import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import { formatDecimal } from "../src/math.js";
import { appendJournal } from "./journal.js";
import { MexcSignedClient } from "./mexc.js";
import type { MexcOrder, MexcTrade } from "./mexc.js";
import type { LiveConfig } from "./types.js";

type JournalEvent = {
  ts: string;
  event: string;
  [key: string]: unknown;
};

export async function printLatestPnlReport(config: LiveConfig): Promise<void> {
  const events = await readJournal(config.stateDir);
  const sellFinal = findLast(events, "mexc.market_sell.final");
  if (!sellFinal) {
    throw new Error("No mexc.market_sell.final event found in journal");
  }

  const order = sellFinal.order as MexcOrder | undefined;
  if (!order?.orderId) {
    throw new Error("Latest mexc.market_sell.final event has no order id");
  }

  const plan = findLastBefore(events, "probe.plan", sellFinal.ts, (event) => event.dryRun === false);
  const quote = findLastBefore(events, "probe.raydium_quote", sellFinal.ts);
  const swap = findLastBefore(events, "probe.swap_confirmed", sellFinal.ts);
  const transfer = findLargestTransferBetween(events, "transfer_to_mexc.confirmed", swap?.ts, sellFinal.ts);
  const tradeEvent = findLast(events, "mexc.market_sell.trades", (event) => {
    const eventOrderId = event.orderId;
    return String(eventOrderId) === String(order.orderId);
  });

  let trades = (tradeEvent?.trades as MexcTrade[] | undefined) ?? [];
  if (trades.length === 0) {
    if (!config.mexcApiKey || !config.mexcApiSecret) {
      throw new Error("No trades in journal and MEXC credentials are missing");
    }

    const client = new MexcSignedClient(config.mexcApiKey, config.mexcApiSecret);
    trades = await client.fetchMyTrades({
      symbol: config.mexcSymbol,
      orderId: order.orderId,
      startTime: (order.time ?? Date.now()) - 60_000,
      endTime: Date.now() + 60_000
    });
    await appendJournal(config.stateDir, "mexc.market_sell.trades", {
      orderId: order.orderId,
      trades
    });
  }

  const inputUsdc = new Decimal(
    quote?.inputAmount !== undefined ? String(quote.inputAmount) : new Decimal(String(plan?.notionalUsd ?? "0")).mul(1_000_000).toString()
  ).div(1_000_000);
  const quoteOutputRawSpyx = quote?.outputAmount !== undefined ? new Decimal(String(quote.outputAmount)).div(100_000_000) : undefined;
  const walletUiReceived = swap?.spyxReceived !== undefined ? new Decimal(String(swap.spyxReceived)) : undefined;
  const transferredUi = transfer?.amount !== undefined ? new Decimal(String(transfer.amount)) : undefined;

  const executedQty = new Decimal(order.executedQty ?? "0");
  const orderGrossQuote = new Decimal(order.cummulativeQuoteQty ?? "0");
  const tradeGrossQuote = trades.reduce((sum, trade) => sum.plus(trade.quoteQty), new Decimal(0));
  const grossQuote = tradeGrossQuote.gt(0) ? tradeGrossQuote : orderGrossQuote;
  const avgFill = executedQty.gt(0) ? grossQuote.div(executedQty) : new Decimal(0);

  const commissions = summarizeCommissions(trades);
  const quoteCommission = commissions.get(config.mexcSymbol.endsWith("USDT") ? "USDT" : "USDC") ?? new Decimal(0);
  const netQuote = grossQuote.minus(quoteCommission);

  const mexcCreditedRaw = quoteOutputRawSpyx ?? new Decimal(order.origQty ?? "0");
  const unsoldRaw = Decimal.max(mexcCreditedRaw.minus(executedQty), 0);
  const dustValue = unsoldRaw.mul(avgFill);

  const totalGrossValue = grossQuote.plus(dustValue);
  const totalNetValue = netQuote.plus(dustValue);
  const grossPnl = totalGrossValue.minus(inputUsdc);
  const netPnl = totalNetValue.minus(inputUsdc);
  const grossBps = grossPnl.div(inputUsdc).mul(10_000);
  const netBps = netPnl.div(inputUsdc).mul(10_000);

  console.log("\nLatest live PnL report");
  console.log(`Input:             ${formatDecimal(inputUsdc, 6)} USDC`);
  if (walletUiReceived) console.log(`Wallet UI SPYx:    ${formatDecimal(walletUiReceived, 8)}`);
  if (quoteOutputRawSpyx) console.log(`MEXC raw credit:   ${formatDecimal(quoteOutputRawSpyx, 8)} SPYx`);
  if (transferredUi) console.log(`Transferred UI:    ${formatDecimal(transferredUi, 8)} SPYx`);
  console.log(`Sold qty:          ${formatDecimal(executedQty, 8)} SPYx`);
  console.log(`Avg fill:          ${formatDecimal(avgFill, 8)} USDT/SPYx`);
  console.log(`Gross quote:       ${formatDecimal(grossQuote, 8)} USDT`);

  if (commissions.size === 0) {
    console.log("Commission:        no trade commission returned by MEXC");
  } else {
    for (const [asset, amount] of commissions) {
      console.log(`Commission:        ${amount.toString()} ${asset}`);
    }
  }

  console.log(`Unsold raw dust:   ${formatDecimal(unsoldRaw, 8)} SPYx`);
  console.log(`Dust value:        ${formatDecimal(dustValue, 8)} USDT`);
  console.log(`Gross value:       ${formatDecimal(totalGrossValue, 8)} USDT`);
  console.log(`Net value:         ${formatDecimal(totalNetValue, 8)} USDT`);
  console.log(`Gross PnL:         ${formatDecimal(grossPnl, 8)} USDT (${formatDecimal(grossBps, 2)} bps)`);
  console.log(`Net PnL:           ${formatDecimal(netPnl, 8)} USDT (${formatDecimal(netBps, 2)} bps)`);

  await appendJournal(config.stateDir, "pnl.report", {
    orderId: order.orderId,
    inputUsdc: inputUsdc.toString(),
    walletUiReceived: walletUiReceived?.toString(),
    mexcCreditedRaw: mexcCreditedRaw.toString(),
    executedQty: executedQty.toString(),
    grossQuote: grossQuote.toString(),
    commissions: Object.fromEntries([...commissions.entries()].map(([asset, amount]) => [asset, amount.toString()])),
    unsoldRaw: unsoldRaw.toString(),
    dustValue: dustValue.toString(),
    grossPnl: grossPnl.toString(),
    netPnl: netPnl.toString(),
    grossBps: grossBps.toString(),
    netBps: netBps.toString()
  });
}

async function readJournal(stateDir: string): Promise<JournalEvent[]> {
  const raw = await readFile(join(stateDir, "journal.jsonl"), "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEvent);
}

function findLast(
  events: JournalEvent[],
  eventName: string,
  predicate: (event: JournalEvent) => boolean = () => true
): JournalEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event === eventName && predicate(event)) return event;
  }

  return undefined;
}

function findLastBefore(
  events: JournalEvent[],
  eventName: string,
  beforeTs: string,
  predicate: (event: JournalEvent) => boolean = () => true
): JournalEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.ts > beforeTs) continue;
    if (event.event === eventName && predicate(event)) return event;
  }

  return undefined;
}

function findLargestTransferBetween(
  events: JournalEvent[],
  eventName: string,
  afterTs: string | undefined,
  beforeTs: string
): JournalEvent | undefined {
  const candidates = events.filter((event) => {
    if (event.event !== eventName) return false;
    if (afterTs !== undefined && event.ts < afterTs) return false;
    return event.ts <= beforeTs;
  });

  return candidates.sort((a, b) => new Decimal(String(b.amount ?? "0")).cmp(new Decimal(String(a.amount ?? "0"))))[0];
}

function summarizeCommissions(trades: MexcTrade[]): Map<string, Decimal> {
  const totals = new Map<string, Decimal>();
  for (const trade of trades) {
    const current = totals.get(trade.commissionAsset) ?? new Decimal(0);
    totals.set(trade.commissionAsset, current.plus(trade.commission));
  }

  return totals;
}
