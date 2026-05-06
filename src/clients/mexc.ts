import { Decimal } from "decimal.js";
import type { OrderBook, OrderBookLevel, VwapResult } from "../types.js";

const MEXC_BASE_URL = "https://api.mexc.com";

type MexcDepthResponse = {
  lastUpdateId?: number;
  bids: [string, string][];
  asks: [string, string][];
};

function parseLevels(levels: [string, string][]): OrderBookLevel[] {
  return levels.map(([price, quantity]) => ({
    price: new Decimal(price),
    quantity: new Decimal(quantity)
  }));
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${MEXC_BASE_URL}${path}`, {
    headers: { "content-type": "application/json" }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MEXC ${response.status} ${response.statusText}: ${body}`);
  }

  return (await response.json()) as T;
}

export async function fetchMexcOrderBook(symbol: string, limit = 100): Promise<OrderBook> {
  const params = new URLSearchParams({ symbol, limit: String(limit) });
  const data = await getJson<MexcDepthResponse>(`/api/v3/depth?${params}`);

  return {
    symbol,
    bids: parseLevels(data.bids),
    asks: parseLevels(data.asks),
    fetchedAt: new Date()
  };
}

export function buyBaseWithQuote(asks: OrderBookLevel[], quoteBudget: Decimal): VwapResult {
  let remainingQuote = quoteBudget;
  let baseAmount = new Decimal(0);
  let quoteAmount = new Decimal(0);

  for (const level of asks) {
    if (remainingQuote.lte(0)) break;

    const levelQuote = level.price.mul(level.quantity);
    const quoteUsed = Decimal.min(remainingQuote, levelQuote);
    const baseBought = quoteUsed.div(level.price);

    baseAmount = baseAmount.plus(baseBought);
    quoteAmount = quoteAmount.plus(quoteUsed);
    remainingQuote = remainingQuote.minus(quoteUsed);
  }

  return {
    baseAmount,
    quoteAmount,
    averagePrice: baseAmount.gt(0) ? quoteAmount.div(baseAmount) : new Decimal(0),
    filled: remainingQuote.lte(quoteBudget.mul(0.000001))
  };
}

export function sellBaseForQuote(bids: OrderBookLevel[], baseToSell: Decimal): VwapResult {
  let remainingBase = baseToSell;
  let baseAmount = new Decimal(0);
  let quoteAmount = new Decimal(0);

  for (const level of bids) {
    if (remainingBase.lte(0)) break;

    const baseUsed = Decimal.min(remainingBase, level.quantity);
    const quoteReceived = baseUsed.mul(level.price);

    baseAmount = baseAmount.plus(baseUsed);
    quoteAmount = quoteAmount.plus(quoteReceived);
    remainingBase = remainingBase.minus(baseUsed);
  }

  return {
    baseAmount,
    quoteAmount,
    averagePrice: baseAmount.gt(0) ? quoteAmount.div(baseAmount) : new Decimal(0),
    filled: remainingBase.lte(baseToSell.mul(0.000001))
  };
}
