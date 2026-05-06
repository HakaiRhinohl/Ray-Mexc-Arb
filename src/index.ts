import { Decimal } from "decimal.js";
import { config } from "./config.js";
import { fetchMexcOrderBook } from "./clients/mexc.js";
import { fetchTokenScale } from "./clients/solana.js";
import { appendOpportunitiesCsv, appendPaperEventsCsv } from "./csv.js";
import { evaluateOpportunities } from "./opportunity.js";
import { PaperTracker, renderPaperOpen, renderPaperResolution, resolvePaperPosition } from "./paper.js";
import { TelegramNotifier } from "./telegram.js";
import { formatDecimal } from "./math.js";
import type { Opportunity, OrderBook, TokenScale } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachRateLimitDiagnostics(onRateLimit: (message: string) => void): () => void {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const message = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
    onRateLimit(message);
    originalWarn(...args);
  };

  return () => {
    console.warn = originalWarn;
  };
}

function renderOpportunity(opportunity: Opportunity): string {
  const marker = opportunity.passesThreshold ? "PASS" : "----";
  return [
    marker,
    opportunity.direction.padEnd(16),
    `$${formatDecimal(opportunity.notionalUsd, 2).padStart(7)}`,
    `market=${formatDecimal(opportunity.grossSpreadBps, 2).padStart(8)} bps`,
    `net=${formatDecimal(opportunity.netSpreadBps, 2).padStart(8)} bps`,
    `pnl=$${formatDecimal(opportunity.pnlUsd, 4).padStart(9)}`,
    `mexcPx=${opportunity.mexcAveragePrice ? formatDecimal(opportunity.mexcAveragePrice, 4) : "n/a"}`,
    `rayRawPx=${opportunity.raydiumEffectivePrice ? formatDecimal(opportunity.raydiumEffectivePrice, 4) : "n/a"}`,
    `scaleDrag=${formatDecimal(opportunity.tokenScaleDragBps, 2)}bps`,
    `netOut=$${formatDecimal(opportunity.netOutUsd, 4)}`
  ].join("  ");
}

type MarketScales = {
  spyx: TokenScale;
  usdc: TokenScale;
};

type MarketSnapshot = {
  orderBook: OrderBook;
  opportunities: Opportunity[];
};

function getNumberArg(name: string): number | undefined {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return undefined;

  const value = Number(match.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function scanOnce(scales: MarketScales): Promise<MarketSnapshot> {
  const orderBook = await fetchMexcOrderBook(config.mexcSymbol);
  const opportunities = await evaluateOpportunities({
    orderBook,
    tradeSizesUsd: config.tradeSizesUsd,
    tradeDirections: config.tradeDirections,
    spyxMint: config.spyxMint,
    usdcMint: config.usdcMint,
    solanaRpcUrl: config.solanaRpcUrl,
    spyxScale: scales.spyx,
    usdcScale: scales.usdc,
    mexcTakerFeeBps: config.mexcTakerFeeBps,
    mexcBasePrecision: config.mexcBasePrecision,
    raydiumSlippageBps: config.raydiumSlippageBps,
    settlementRiskBufferBps: config.settlementRiskBufferBps,
    minNetSpreadBps: config.minNetSpreadBps,
    mexcWithdrawFeeSpyx: config.mexcWithdrawFeeSpyx,
    solanaTxCostUsd: config.solanaTxCostUsd
  });

  return { orderBook, opportunities };
}

async function main(): Promise<void> {
  const scanOnceOnly = process.argv.includes("--once");
  const paperMode = process.argv.includes("--paper");
  const maxRuntimeMs = getNumberArg("--max-runtime-ms");
  const processStartedAt = Date.now();
  const telegram = new TelegramNotifier(config.telegram);
  const restoreRateLimitDiagnostics = attachRateLimitDiagnostics((message) => telegram.recordRateLimitWarning(message));

  const paperTracker = paperMode
    ? new PaperTracker({
        minMarketSpreadBps: config.paperMinMarketSpreadBps,
        settlementDelaysMs: config.paperSettlementDelaysMs,
        realisticMode: config.paperRealisticMode,
        capitalUsd: config.paperCapitalUsd,
        realisticSettlementDelayMs: config.paperRealisticSettlementDelayMs,
        openCooldownMs: config.paperOpenCooldownMs,
        maxOpenPositions: config.paperMaxOpenPositions
      })
    : undefined;

  console.log(`SPYx ${paperMode ? "paper trader" : "scanner"} starting`);
  console.log(`MEXC symbol: ${config.mexcSymbol}`);
  console.log(`SPYx mint:   ${config.spyxMint}`);
  console.log(`USDC mint:   ${config.usdcMint}`);
  console.log(`Trade sizes: ${config.tradeSizesUsd.map((value) => `$${value}`).join(", ")}`);
  console.log(`Directions:  ${config.tradeDirections.join(", ")}`);
  console.log(`Threshold:   ${config.minNetSpreadBps} bps net`);
  if (paperMode) {
    console.log(`Paper min:   ${config.paperMinMarketSpreadBps} bps market`);
    console.log(`Paper delays:${config.paperSettlementDelaysMs.map((value) => ` ${Math.round(value / 1000)}s`).join(",")}`);
    console.log(
      `Paper model: ${config.paperRealisticMode ? "live-adjusted" : "legacy"} ` +
        `(capital=$${config.paperCapitalUsd}, delay=${Math.round(config.paperRealisticSettlementDelayMs / 1000)}s, ` +
        `mexcPrecision=${config.paperMexcBasePrecision}, extraCost=$${config.paperLiveExtraCostUsd})`
    );
  }
  if (config.telegram.enabled) {
    console.log(`Telegram:    ${telegram.configured ? "enabled" : "enabled but missing token/chat id"}`);
    console.log(`TG min net:  ${config.telegram.minNetSpreadBps} bps`);
  }

  const [spyxScale, usdcScale] = await Promise.all([
    fetchTokenScale(config.solanaRpcUrl, config.spyxMint),
    fetchTokenScale(config.solanaRpcUrl, config.usdcMint)
  ]);
  const scales = { spyx: spyxScale, usdc: usdcScale };
  console.log(
    `Scales:      SPYx decimals=${scales.spyx.decimals} multiplier=${formatDecimal(scales.spyx.uiMultiplier, 9)}, ` +
      `USDC decimals=${scales.usdc.decimals}`
  );
  await telegram.sendStartup({
    paperMode,
    mexcSymbol: config.mexcSymbol,
    tradeSizesUsd: config.tradeSizesUsd,
    directions: config.tradeDirections,
    scanIntervalMs: config.scanIntervalMs
  });

  while (true) {
    const startedAt = Date.now();
    try {
      const snapshot = await scanOnce(scales);
      const opportunities = snapshot.opportunities;
      await appendOpportunitiesCsv(config.logCsvPath, opportunities);

      const best = opportunities.reduce((winner, current) =>
        current.netSpreadBps.gt(winner.netSpreadBps) ? current : winner
      );

      console.log(`\n${new Date().toISOString()} best=${best.direction} ${formatDecimal(best.netSpreadBps, 2)} bps`);
      for (const opportunity of opportunities) {
        console.log(renderOpportunity(opportunity));
      }

      const passes = opportunities.filter((opportunity) => opportunity.passesThreshold);
      if (passes.length > 0) {
        const totalExpected = passes.reduce((sum, opportunity) => sum.plus(opportunity.pnlUsd), new Decimal(0));
        console.log(`ALERT: ${passes.length} route(s) passed threshold. Combined paper pnl: $${formatDecimal(totalExpected, 4)}`);
      }

      await telegram.recordScan({
        opportunities,
        nowMs: Date.now(),
        scanIntervalMs: config.scanIntervalMs
      });

      if (paperTracker) {
        const nowMs = Date.now();
        const opened = paperTracker.openFromOpportunities(opportunities, nowMs);
        if (opened.length > 0) {
          await appendPaperEventsCsv(
            config.paperLogCsvPath,
            opened.map((position) => ({ event: "OPEN", position }))
          );
          telegram.recordPaperOpened(opened);
          for (const position of opened) {
            console.log(renderPaperOpen(position));
          }
        }

        const due = paperTracker.takeDue(nowMs);
        if (due.length > 0) {
          const resolutions = [];
          for (const position of due) {
            const resolution = await resolvePaperPosition({
              position,
              orderBook: snapshot.orderBook,
              spyxMint: config.spyxMint,
              usdcMint: config.usdcMint,
              solanaRpcUrl: config.solanaRpcUrl,
              spyxScale: scales.spyx,
              usdcScale: scales.usdc,
              mexcTakerFeeBps: config.mexcTakerFeeBps,
              raydiumSlippageBps: config.raydiumSlippageBps,
              settlementRiskBufferBps: config.settlementRiskBufferBps,
              solanaTxCostUsd: config.solanaTxCostUsd,
              liveExtraCostUsd: config.paperLiveExtraCostUsd,
              mexcBasePrecision: config.paperMexcBasePrecision,
              realisticMode: config.paperRealisticMode
            });
            resolutions.push(resolution);
            console.log(renderPaperResolution(resolution));
          }

          await appendPaperEventsCsv(
            config.paperLogCsvPath,
            resolutions.map((resolution) => ({ event: "RESOLVE", resolution }))
          );
          telegram.recordPaperResolved(resolutions);
        }

        console.log(`PAPER: ${paperTracker.openCount} simulated transfer(s) still open`);
      }
    } catch (error) {
      telegram.recordScanFailure(error);
      console.error(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    await telegram.maybeSendHourlyReport(Date.now());

    if (scanOnceOnly) {
      restoreRateLimitDiagnostics();
      break;
    }
    if (maxRuntimeMs !== undefined && Date.now() - processStartedAt >= maxRuntimeMs) {
      await telegram.flushFinalReport(Date.now());
      restoreRateLimitDiagnostics();
      break;
    }

    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(1_000, config.scanIntervalMs - elapsed));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
