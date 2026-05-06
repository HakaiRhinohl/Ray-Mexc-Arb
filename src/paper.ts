import { Decimal } from "decimal.js";
import { createRaydiumClmmQuoteProvider } from "./clients/raydium.js";
import { sellBaseForQuote } from "./clients/mexc.js";
import { bpsMultiplier, floorDecimal, formatDecimal, fromBaseUnits, toBaseUnits } from "./math.js";
import type { Direction, Opportunity, OrderBook, TokenScale } from "./types.js";

export type PaperPosition = {
  id: string;
  direction: Direction;
  model: "legacy" | "live-adjusted";
  notionalUsd: Decimal;
  entrySpyxAmount: Decimal;
  entryTimestamp: string;
  openedAtMs: number;
  resolveAtMs: number;
  delayMs: number;
  entryMarketSpreadBps: Decimal;
  entryNetSpreadBps: Decimal;
  entryMexcAveragePrice?: Decimal;
  entryRaydiumEffectivePrice?: Decimal;
  notes: string[];
};

export type PaperResolution = {
  position: PaperPosition;
  resolvedAt: string;
  actualDelayMs: number;
  sellableSpyxAmount?: Decimal;
  unsellableSpyxAmount?: Decimal;
  grossOutUsd: Decimal;
  netOutUsd: Decimal;
  pnlUsd: Decimal;
  realizedSpreadBps: Decimal;
  exitMexcAveragePrice?: Decimal;
  exitRaydiumEffectivePrice?: Decimal;
  filled: boolean;
  notes: string[];
};

export type PaperEvent =
  | { event: "OPEN"; position: PaperPosition }
  | { event: "RESOLVE"; resolution: PaperResolution };

export class PaperTracker {
  private readonly openPositions = new Map<string, PaperPosition>();
  private readonly lastOpenedAtByKey = new Map<string, number>();
  private nextId = 1;

  constructor(
    private readonly settings: {
      minMarketSpreadBps: number;
      settlementDelaysMs: readonly number[];
      realisticMode: boolean;
      capitalUsd: number;
      realisticSettlementDelayMs: number;
      openCooldownMs: number;
      maxOpenPositions: number;
    }
  ) {}

  get openCount(): number {
    return this.openPositions.size;
  }

  openFromOpportunities(opportunities: Opportunity[], nowMs: number): PaperPosition[] {
    if (this.settings.realisticMode) return this.openRealistic(opportunities, nowMs);

    const opened: PaperPosition[] = [];

    for (const opportunity of opportunities) {
      if (this.openPositions.size + opened.length >= this.settings.maxOpenPositions) break;
      if (!this.shouldOpen(opportunity, nowMs)) continue;

      const key = this.cooldownKey(opportunity);
      this.lastOpenedAtByKey.set(key, nowMs);

      for (const delayMs of this.settings.settlementDelaysMs) {
        if (this.openPositions.size + opened.length >= this.settings.maxOpenPositions) break;

        const position: PaperPosition = {
          id: this.makeId(nowMs, opportunity, delayMs),
          direction: opportunity.direction,
          model: "legacy",
          notionalUsd: opportunity.notionalUsd,
          entrySpyxAmount: opportunity.entrySpyxAmount,
          entryTimestamp: opportunity.timestamp,
          openedAtMs: nowMs,
          resolveAtMs: nowMs + delayMs,
          delayMs,
          entryMarketSpreadBps: opportunity.grossSpreadBps,
          entryNetSpreadBps: opportunity.netSpreadBps,
          entryMexcAveragePrice: opportunity.mexcAveragePrice,
          entryRaydiumEffectivePrice: opportunity.raydiumEffectivePrice,
          notes: opportunity.notes
        };

        this.openPositions.set(position.id, position);
        opened.push(position);
      }
    }

    return opened;
  }

  takeDue(nowMs: number): PaperPosition[] {
    const due: PaperPosition[] = [];

    for (const position of this.openPositions.values()) {
      if (position.resolveAtMs > nowMs) continue;
      this.openPositions.delete(position.id);
      due.push(position);
    }

    return due.sort((a, b) => a.resolveAtMs - b.resolveAtMs);
  }

  private shouldOpen(opportunity: Opportunity, nowMs: number): boolean {
    if (opportunity.notes.length > 0) return false;
    if (opportunity.entrySpyxAmount.lte(0)) return false;
    if (opportunity.grossSpreadBps.lt(this.settings.minMarketSpreadBps) && opportunity.netSpreadBps.lt(0)) {
      return false;
    }

    const lastOpenedAt = this.lastOpenedAtByKey.get(this.cooldownKey(opportunity));
    return lastOpenedAt === undefined || nowMs - lastOpenedAt >= this.settings.openCooldownMs;
  }

  private openRealistic(opportunities: Opportunity[], nowMs: number): PaperPosition[] {
    if (this.openPositions.size >= this.settings.maxOpenPositions) return [];

    const availableCapitalUsd = new Decimal(this.settings.capitalUsd).minus(this.openNotionalUsd());
    if (availableCapitalUsd.lte(0)) return [];

    const candidate = opportunities
      .filter((opportunity) => this.shouldOpen(opportunity, nowMs))
      .filter((opportunity) => opportunity.notionalUsd.lte(availableCapitalUsd))
      .sort((left, right) => right.netSpreadBps.cmp(left.netSpreadBps))[0];

    if (!candidate) return [];

    const delayMs = this.settings.realisticSettlementDelayMs;
    const key = this.cooldownKey(candidate);
    this.lastOpenedAtByKey.set(key, nowMs);

    const position: PaperPosition = {
      id: this.makeId(nowMs, candidate, delayMs),
      direction: candidate.direction,
      model: "live-adjusted",
      notionalUsd: candidate.notionalUsd,
      entrySpyxAmount: candidate.entrySpyxAmount,
      entryTimestamp: candidate.timestamp,
      openedAtMs: nowMs,
      resolveAtMs: nowMs + delayMs,
      delayMs,
      entryMarketSpreadBps: candidate.grossSpreadBps,
      entryNetSpreadBps: candidate.netSpreadBps,
      entryMexcAveragePrice: candidate.mexcAveragePrice,
      entryRaydiumEffectivePrice: candidate.raydiumEffectivePrice,
      notes: candidate.notes
    };

    this.openPositions.set(position.id, position);
    return [position];
  }

  private openNotionalUsd(): Decimal {
    return [...this.openPositions.values()].reduce((sum, position) => sum.plus(position.notionalUsd), new Decimal(0));
  }

  private cooldownKey(opportunity: Opportunity): string {
    return `${opportunity.direction}:${opportunity.notionalUsd.toFixed(2)}`;
  }

  private makeId(nowMs: number, opportunity: Opportunity, delayMs: number): string {
    const counter = String(this.nextId++).padStart(6, "0");
    return [
      new Date(nowMs).toISOString().replaceAll(/[:.]/g, "-"),
      opportunity.direction,
      opportunity.notionalUsd.toFixed(2),
      delayMs,
      counter
    ].join("-");
  }
}

export async function resolvePaperPosition(args: {
  position: PaperPosition;
  orderBook: OrderBook;
  spyxMint: string;
  usdcMint: string;
  solanaRpcUrl: string;
  spyxScale: TokenScale;
  usdcScale: TokenScale;
  mexcTakerFeeBps: number;
  raydiumSlippageBps: number;
  settlementRiskBufferBps: number;
  solanaTxCostUsd: number;
  liveExtraCostUsd: number;
  mexcBasePrecision: number;
  realisticMode: boolean;
}): Promise<PaperResolution> {
  const notes: string[] = [];
  const mexcFeeMultiplier = bpsMultiplier(args.mexcTakerFeeBps);
  const settlementMultiplier = args.realisticMode ? bpsMultiplier(args.settlementRiskBufferBps) : new Decimal(1);
  const totalTxCostUsd = new Decimal(args.solanaTxCostUsd).plus(args.realisticMode ? args.liveExtraCostUsd : 0);

  if (args.position.direction === "RAYDIUM_TO_MEXC") {
    const creditedSpyx = args.realisticMode
      ? args.position.entrySpyxAmount.div(args.spyxScale.uiMultiplier)
      : args.position.entrySpyxAmount;
    const sellableSpyx = args.realisticMode
      ? floorDecimal(creditedSpyx, args.mexcBasePrecision)
      : creditedSpyx;
    const unsellableSpyx = Decimal.max(args.position.entrySpyxAmount.minus(sellableSpyx), 0);
    if (args.realisticMode) {
      notes.push(
        `live-adjusted: MEXC sellable SPYx = on-chain raw / scale multiplier, floored to ${args.mexcBasePrecision} decimals`
      );
    }

    const mexcSell = sellBaseForQuote(args.orderBook.bids, sellableSpyx);
    if (!mexcSell.filled) notes.push("MEXC bids do not fully cover paper SPYx amount at resolution");

    const grossOutUsd = mexcSell.quoteAmount;
    const netOutUsd = grossOutUsd.mul(mexcFeeMultiplier).mul(settlementMultiplier).minus(totalTxCostUsd);
    return buildResolution({
      position: args.position,
      sellableSpyxAmount: sellableSpyx,
      unsellableSpyxAmount: unsellableSpyx,
      grossOutUsd,
      netOutUsd,
      exitMexcAveragePrice: mexcSell.averagePrice,
      filled: mexcSell.filled,
      notes
    });
  }

  const raydiumQuoteProvider = await createRaydiumClmmQuoteProvider({ solanaRpcUrl: args.solanaRpcUrl });
  const onChainSpyxAmount = args.realisticMode
    ? args.position.entrySpyxAmount.mul(args.spyxScale.uiMultiplier)
    : args.position.entrySpyxAmount;
  const quote = await raydiumQuoteProvider.fetchBaseInQuote({
    inputMint: args.spyxMint,
    outputMint: args.usdcMint,
    amount: toBaseUnits(onChainSpyxAmount, args.spyxScale.decimals),
    slippageBps: args.raydiumSlippageBps
  });
  const grossOutUsd = fromBaseUnits(quote.outAmount, args.usdcScale.decimals);
  const netOutUsd = grossOutUsd.mul(settlementMultiplier).minus(totalTxCostUsd);
  const exitRaydiumEffectivePrice = onChainSpyxAmount.gt(0)
    ? grossOutUsd.div(onChainSpyxAmount)
    : undefined;
  if (args.realisticMode) {
    notes.push("live-adjusted: MEXC withdrawal amount converted to on-chain scaled SPYx before Raydium quote");
  }

  return buildResolution({
    position: args.position,
    grossOutUsd,
    netOutUsd,
    exitRaydiumEffectivePrice,
    filled: true,
    notes
  });
}

export function renderPaperOpen(position: PaperPosition): string {
  return [
    "PAPER OPEN",
    position.direction.padEnd(16),
    `$${formatDecimal(position.notionalUsd, 2).padStart(7)}`,
    `model=${position.model}`,
    `delay=${formatDelay(position.delayMs).padStart(5)}`,
    `market=${formatDecimal(position.entryMarketSpreadBps, 2).padStart(8)} bps`,
    `entrySpyx=${formatDecimal(position.entrySpyxAmount, 8)}`
  ].join("  ");
}

export function renderPaperResolution(resolution: PaperResolution): string {
  const marker = resolution.pnlUsd.gte(0) ? "PAPER WIN " : "PAPER LOSS";
  return [
    marker,
    resolution.position.direction.padEnd(16),
    `$${formatDecimal(resolution.position.notionalUsd, 2).padStart(7)}`,
    `delay=${formatDelay(resolution.position.delayMs).padStart(5)}`,
    `actual=${formatDelay(resolution.actualDelayMs).padStart(5)}`,
    `realized=${formatDecimal(resolution.realizedSpreadBps, 2).padStart(8)} bps`,
    `pnl=$${formatDecimal(resolution.pnlUsd, 4).padStart(9)}`,
    resolution.sellableSpyxAmount ? `sellSpyx=${formatDecimal(resolution.sellableSpyxAmount, 8)}` : "",
    `netOut=$${formatDecimal(resolution.netOutUsd, 4)}`
  ].filter(Boolean).join("  ");
}

function buildResolution(args: {
  position: PaperPosition;
  sellableSpyxAmount?: Decimal;
  unsellableSpyxAmount?: Decimal;
  grossOutUsd: Decimal;
  netOutUsd: Decimal;
  exitMexcAveragePrice?: Decimal;
  exitRaydiumEffectivePrice?: Decimal;
  filled: boolean;
  notes: string[];
}): PaperResolution {
  const resolvedAtMs = Date.now();
  const pnlUsd = args.netOutUsd.minus(args.position.notionalUsd);
  return {
    position: args.position,
    resolvedAt: new Date(resolvedAtMs).toISOString(),
    actualDelayMs: resolvedAtMs - args.position.openedAtMs,
    sellableSpyxAmount: args.sellableSpyxAmount,
    unsellableSpyxAmount: args.unsellableSpyxAmount,
    grossOutUsd: args.grossOutUsd,
    netOutUsd: args.netOutUsd,
    pnlUsd,
    realizedSpreadBps: pnlUsd.div(args.position.notionalUsd).mul(10_000),
    exitMexcAveragePrice: args.exitMexcAveragePrice,
    exitRaydiumEffectivePrice: args.exitRaydiumEffectivePrice,
    filled: args.filled,
    notes: args.notes
  };
}

function formatDelay(delayMs: number): string {
  const seconds = Math.round(delayMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}
