import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { Decimal } from "decimal.js";
import { config } from "./config.js";
import { fetchMexcOrderBook } from "./clients/mexc.js";
import { fetchTokenScale } from "./clients/solana.js";
import { evaluateOpportunities } from "./opportunity.js";
import { formatDecimal } from "./math.js";
import type { Opportunity, TokenScale } from "./types.js";

type StressConfig = {
  startIntervalMs: number;
  minIntervalMs: number;
  factor: number;
  roundScans: number;
  failLimit: number;
  cooldownMs: number;
  logCsvPath: string;
};

type MarketScales = {
  spyx: TokenScale;
  usdc: TokenScale;
};

type ScanResult = {
  ok: boolean;
  latencyMs: number;
  best?: Opportunity;
  errorType?: "rate_limit" | "error";
  errorMessage?: string;
};

type RoundSummary = {
  intervalMs: number;
  ok: number;
  failed: number;
  rateLimited: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  bestNetBps?: Decimal;
  bestMarketBps?: Decimal;
  bestOpportunity?: Opportunity;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNumberArg(name: string, fallback: number): number {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;

  const value = Number(match.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getStringArg(name: string, fallback: string): string {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() || fallback : fallback;
}

function loadStressConfig(): StressConfig {
  return {
    startIntervalMs: getNumberArg("--start-interval-ms", 10_000),
    minIntervalMs: getNumberArg("--min-interval-ms", 500),
    factor: Math.min(0.95, Math.max(0.1, getNumberArg("--factor", 0.75))),
    roundScans: Math.max(1, Math.round(getNumberArg("--round-scans", 8))),
    failLimit: Math.max(1, Math.round(getNumberArg("--fail-limit", 1))),
    cooldownMs: getNumberArg("--cooldown-ms", 10_000),
    logCsvPath: getStringArg("--log-csv-path", "data/scan-stress.csv")
  };
}

function buildIntervals(args: StressConfig): number[] {
  const intervals: number[] = [];
  let current = args.startIntervalMs;

  while (current >= args.minIntervalMs) {
    intervals.push(Math.round(current));
    const next = current * args.factor;
    if (Math.round(next) === Math.round(current)) break;
    current = next;
  }

  if (intervals[intervals.length - 1] !== args.minIntervalMs) intervals.push(args.minIntervalMs);
  return [...new Set(intervals)].sort((left, right) => right - left);
}

async function scanOnce(scales: MarketScales): Promise<Opportunity[]> {
  const orderBook = await fetchMexcOrderBook(config.mexcSymbol);
  return evaluateOpportunities({
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
}

async function timedScan(scales: MarketScales): Promise<ScanResult> {
  const started = performance.now();
  try {
    const opportunities = await scanOnce(scales);
    const best = opportunities.reduce((winner, current) =>
      current.netSpreadBps.gt(winner.netSpreadBps) ? current : winner
    );
    return {
      ok: true,
      latencyMs: performance.now() - started,
      best
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      latencyMs: performance.now() - started,
      errorType: isRateLimitError(message) ? "rate_limit" : "error",
      errorMessage: message
    };
  }
}

async function runRound(args: {
  intervalMs: number;
  roundScans: number;
  scales: MarketScales;
  logCsvPath: string;
}): Promise<RoundSummary> {
  const results: ScanResult[] = [];

  for (let scanIndex = 1; scanIndex <= args.roundScans; scanIndex += 1) {
    const startedAt = Date.now();
    const result = await timedScan(args.scales);
    results.push(result);
    await appendStressCsv(args.logCsvPath, args.intervalMs, scanIndex, result);

    const status = result.ok ? "OK" : result.errorType === "rate_limit" ? "RATE_LIMIT" : "ERROR";
    const best = result.best
      ? `best=${formatDecimal(result.best.netSpreadBps, 2)}bps ${result.best.direction} $${formatDecimal(result.best.notionalUsd, 2)}`
      : truncate(result.errorMessage ?? "unknown error", 140);
    console.log(
      `  ${String(scanIndex).padStart(2)}/${args.roundScans} ${status.padEnd(10)} ` +
        `latency=${Math.round(result.latencyMs).toString().padStart(5)}ms ${best}`
    );

    if (scanIndex < args.roundScans) {
      const elapsed = Date.now() - startedAt;
      await sleep(Math.max(0, args.intervalMs - elapsed));
    }
  }

  return summarizeRound(args.intervalMs, results);
}

function summarizeRound(intervalMs: number, results: ScanResult[]): RoundSummary {
  const latencies = results.map((result) => result.latencyMs).sort((left, right) => left - right);
  const okResults = results.filter((result) => result.ok);
  const bestOpportunities = okResults.map((result) => result.best).filter((value): value is Opportunity => Boolean(value));
  const bestOpportunity = bestOpportunities.sort((left, right) => right.netSpreadBps.cmp(left.netSpreadBps))[0];
  const bestMarket = bestOpportunities.sort((left, right) => right.grossSpreadBps.cmp(left.grossSpreadBps))[0];

  return {
    intervalMs,
    ok: okResults.length,
    failed: results.length - okResults.length,
    rateLimited: results.filter((result) => result.errorType === "rate_limit").length,
    avgLatencyMs: latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length),
    p95LatencyMs: percentile(latencies, 0.95),
    maxLatencyMs: latencies[latencies.length - 1] ?? 0,
    bestNetBps: bestOpportunity?.netSpreadBps,
    bestMarketBps: bestMarket?.grossSpreadBps,
    bestOpportunity
  };
}

function shouldStop(summary: RoundSummary, failLimit: number): boolean {
  return summary.rateLimited > 0 || summary.failed >= failLimit || summary.ok === 0;
}

function renderRoundSummary(summary: RoundSummary): string {
  return [
    `interval=${summary.intervalMs}ms`,
    `ok=${summary.ok}`,
    `failed=${summary.failed}`,
    `rateLimit=${summary.rateLimited}`,
    `avg=${Math.round(summary.avgLatencyMs)}ms`,
    `p95=${Math.round(summary.p95LatencyMs)}ms`,
    `max=${Math.round(summary.maxLatencyMs)}ms`,
    `bestNet=${summary.bestNetBps ? formatDecimal(summary.bestNetBps, 2) : "n/a"}bps`,
    `bestMarket=${summary.bestMarketBps ? formatDecimal(summary.bestMarketBps, 2) : "n/a"}bps`
  ].join("  ");
}

async function prepareCsv(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      "timestamp",
      "interval_ms",
      "scan_index",
      "ok",
      "latency_ms",
      "error_type",
      "error_message",
      "best_direction",
      "best_notional_usd",
      "best_net_bps",
      "best_market_bps"
    ].join(",") + "\n"
  );
}

async function appendStressCsv(path: string, intervalMs: number, scanIndex: number, result: ScanResult): Promise<void> {
  await appendFile(
    path,
    [
      csv(new Date().toISOString()),
      intervalMs,
      scanIndex,
      result.ok,
      Math.round(result.latencyMs),
      csv(result.errorType ?? ""),
      csv(result.errorMessage ?? ""),
      csv(result.best?.direction ?? ""),
      csv(result.best ? formatDecimal(result.best.notionalUsd, 2) : ""),
      csv(result.best ? formatDecimal(result.best.netSpreadBps, 8) : ""),
      csv(result.best ? formatDecimal(result.best.grossSpreadBps, 8) : "")
    ].join(",") + "\n"
  );
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index] ?? 0;
}

function isRateLimitError(message: string): boolean {
  return /429|1015|rate limited|too many requests/i.test(message);
}

function csv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

async function main(): Promise<void> {
  const stressConfig = loadStressConfig();
  const intervals = buildIntervals(stressConfig);

  console.log("SPYx scan stress test");
  console.log(`MEXC symbol: ${config.mexcSymbol}`);
  console.log(`Sizes:       ${config.tradeSizesUsd.map((value) => `$${value}`).join(", ")}`);
  console.log(`Directions:  ${config.tradeDirections.join(", ")}`);
  console.log(`Intervals:   ${intervals.map((value) => `${value}ms`).join(", ")}`);
  console.log(`Round scans: ${stressConfig.roundScans}`);
  console.log(`Fail limit:  ${stressConfig.failLimit}`);
  console.log(`CSV:         ${stressConfig.logCsvPath}`);

  await prepareCsv(stressConfig.logCsvPath);
  const [spyxScale, usdcScale] = await Promise.all([
    fetchTokenScale(config.solanaRpcUrl, config.spyxMint),
    fetchTokenScale(config.solanaRpcUrl, config.usdcMint)
  ]);
  const scales = { spyx: spyxScale, usdc: usdcScale };
  console.log(
    `Scales:      SPYx decimals=${scales.spyx.decimals} multiplier=${formatDecimal(scales.spyx.uiMultiplier, 9)}, ` +
      `USDC decimals=${scales.usdc.decimals}`
  );

  let lastStable: RoundSummary | undefined;
  let firstUnstable: RoundSummary | undefined;

  for (const intervalMs of intervals) {
    console.log(`\nTesting ${intervalMs}ms interval`);
    const summary = await runRound({
      intervalMs,
      roundScans: stressConfig.roundScans,
      scales,
      logCsvPath: stressConfig.logCsvPath
    });
    console.log(`Summary: ${renderRoundSummary(summary)}`);

    if (shouldStop(summary, stressConfig.failLimit)) {
      firstUnstable = summary;
      break;
    }

    lastStable = summary;
    if (intervalMs !== intervals[intervals.length - 1]) await sleep(stressConfig.cooldownMs);
  }

  console.log("\nResult");
  if (lastStable) {
    const perMinute = 60_000 / lastStable.intervalMs;
    console.log(`Last stable interval: ${lastStable.intervalMs}ms (~${formatDecimal(new Decimal(perMinute), 2)} scans/min)`);
    console.log(`Stable latency: avg=${Math.round(lastStable.avgLatencyMs)}ms p95=${Math.round(lastStable.p95LatencyMs)}ms`);
  } else {
    console.log("No stable interval found in this run.");
  }

  if (firstUnstable) {
    console.log(`First unstable interval: ${firstUnstable.intervalMs}ms (${firstUnstable.failed} failed, ${firstUnstable.rateLimited} rate limited)`);
  }
  console.log(`Detailed log written to ${stressConfig.logCsvPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
