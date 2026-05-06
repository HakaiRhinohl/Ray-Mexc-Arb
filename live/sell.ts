import { setTimeout as sleep } from "node:timers/promises";
import { Decimal } from "decimal.js";
import { formatDecimal } from "../src/math.js";
import { appendJournal } from "./journal.js";
import { MexcSignedClient } from "./mexc.js";
import type { LiveConfig, RiskPolicy } from "./types.js";

export async function sellMexcSpyxMarket(args: {
  config: LiveConfig;
  policy: RiskPolicy;
}): Promise<void> {
  const { config, policy } = args;
  assertSellAllowed(config, policy);

  const client = new MexcSignedClient(config.mexcApiKey!, config.mexcApiSecret!);
  const [symbolInfo, freeBalanceRaw] = await Promise.all([
    client.fetchExchangeInfo(config.mexcSymbol),
    client.fetchFreeBalance(config.mexcSpyxCoin)
  ]);

  if (!symbolInfo.orderTypes.includes("MARKET")) {
    throw new Error(`${config.mexcSymbol} does not support MARKET orders`);
  }
  if (!symbolInfo.isSpotTradingAllowed) {
    throw new Error(`${config.mexcSymbol} spot trading is not allowed`);
  }

  const freeBalance = new Decimal(freeBalanceRaw);
  const requestedAmount = config.sellSpyxAmount ? new Decimal(config.sellSpyxAmount) : freeBalance;
  if (requestedAmount.lte(0)) {
    throw new Error("No SPYx amount to sell");
  }
  if (requestedAmount.gt(freeBalance)) {
    throw new Error(`Sell amount exceeds MEXC free balance: ${requestedAmount.toString()} > ${freeBalance.toString()}`);
  }

  const precision = Math.max(0, symbolInfo.baseAssetPrecision ?? 3);
  const quantity = floorToPrecision(requestedAmount, precision);
  console.log("\nMEXC market sell");
  console.log(`Symbol:       ${config.mexcSymbol}`);
  console.log(`Free balance: ${formatDecimal(freeBalance, 8)} ${config.mexcSpyxCoin}`);
  console.log(`Requested:    ${formatDecimal(requestedAmount, 8)} ${config.mexcSpyxCoin}`);
  console.log(`Quantity:     ${quantity.toFixed()} ${config.mexcSpyxCoin}`);
  console.log(`Precision:    ${precision} decimals`);

  if (quantity.lte(0)) {
    throw new Error(`Sell quantity floors to zero at MEXC precision ${precision}`);
  }

  const clientOrderId = makeClientOrderId();
  await appendJournal(config.stateDir, "mexc.market_sell.plan", {
    symbol: config.mexcSymbol,
    coin: config.mexcSpyxCoin,
    freeBalance: freeBalance.toString(),
    requestedAmount: requestedAmount.toString(),
    quantity: quantity.toString(),
    clientOrderId,
    symbolInfo
  });

  const order = await client.createMarketSell({
    symbol: config.mexcSymbol,
    quantity: quantity.toFixed(),
    newClientOrderId: clientOrderId
  });
  await appendJournal(config.stateDir, "mexc.market_sell.submitted", { order });
  console.log(`Order submitted: ${order.orderId} status=${order.status}`);

  const finalOrder = await waitForOrderTerminal(client, config.mexcSymbol, order.orderId);
  const trades = await client.fetchMyTrades({
    symbol: config.mexcSymbol,
    orderId: finalOrder.orderId,
    startTime: (finalOrder.time ?? Date.now()) - 60_000,
    endTime: Date.now() + 60_000
  });
  await appendJournal(config.stateDir, "mexc.market_sell.final", { order: finalOrder });
  await appendJournal(config.stateDir, "mexc.market_sell.trades", {
    orderId: finalOrder.orderId,
    trades
  });
  console.log(`Order final:     ${finalOrder.orderId} status=${finalOrder.status}`);
  console.log(`Executed qty:    ${finalOrder.executedQty}`);
  console.log(`Received quote:  ${finalOrder.cummulativeQuoteQty} USDT`);

  const executedQty = new Decimal(finalOrder.executedQty || "0");
  const receivedQuote = new Decimal(finalOrder.cummulativeQuoteQty || "0");
  if (executedQty.gt(0)) {
    console.log(`Avg fill:        ${formatDecimal(receivedQuote.div(executedQty), 8)} USDT/SPYx`);
  }
  for (const [asset, commission] of summarizeCommissions(trades)) {
    console.log(`Commission:      ${commission} ${asset}`);
  }
}

function assertSellAllowed(config: LiveConfig, policy: RiskPolicy): void {
  if (config.mode !== "execute") {
    throw new Error("MEXC sell requires LIVE_MODE=execute");
  }
  if (!config.executionEnabled) {
    throw new Error("MEXC sell requires LIVE_EXECUTION_ENABLED=true");
  }
  if (config.confirmation !== "I_UNDERSTAND_REAL_MONEY") {
    throw new Error("MEXC sell requires LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY");
  }
  if (!config.mexcApiKey || !config.mexcApiSecret) {
    throw new Error("MEXC sell requires MEXC_API_KEY and MEXC_API_SECRET");
  }
  if (!policy.enabled || !policy.allowMexcOrders) {
    throw new Error("MEXC sell requires risk policy enabled=true and allowMexcOrders=true");
  }
}

function floorToPrecision(value: Decimal, precision: number): Decimal {
  const multiplier = new Decimal(10).pow(precision);
  return value.mul(multiplier).floor().div(multiplier);
}

function makeClientOrderId(): string {
  return `spyx-probe-${Date.now()}`;
}

function summarizeCommissions(trades: { commission: string; commissionAsset: string }[]): Map<string, string> {
  const totals = new Map<string, Decimal>();
  for (const trade of trades) {
    const current = totals.get(trade.commissionAsset) ?? new Decimal(0);
    totals.set(trade.commissionAsset, current.plus(trade.commission));
  }

  return new Map([...totals.entries()].map(([asset, value]) => [asset, value.toString()]));
}

async function waitForOrderTerminal(
  client: MexcSignedClient,
  symbol: string,
  orderId: string | number
) {
  let latest = await client.fetchOrder({ symbol, orderId });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (["FILLED", "CANCELED", "PARTIALLY_CANCELED"].includes(latest.status)) return latest;
    await sleep(1_000);
    latest = await client.fetchOrder({ symbol, orderId });
  }

  return latest;
}
