import { Decimal } from "decimal.js";

export type Direction = "MEXC_TO_RAYDIUM" | "RAYDIUM_TO_MEXC";

export type OrderBookLevel = {
  price: Decimal;
  quantity: Decimal;
};

export type OrderBook = {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  fetchedAt: Date;
};

export type VwapResult = {
  baseAmount: Decimal;
  quoteAmount: Decimal;
  averagePrice: Decimal;
  filled: boolean;
};

export type TokenScale = {
  decimals: number;
  uiMultiplier: Decimal;
};

export type RaydiumQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  minOutAmount: bigint;
  poolId: string;
  poolType: "CLMM";
  feeRate: number;
  priceImpactPct: number;
  remainingAccounts: string[];
  raw: unknown;
};

export type Opportunity = {
  timestamp: string;
  direction: Direction;
  notionalUsd: Decimal;
  grossOutUsd: Decimal;
  netOutUsd: Decimal;
  pnlUsd: Decimal;
  grossSpreadBps: Decimal;
  netSpreadBps: Decimal;
  entrySpyxAmount: Decimal;
  mexcAveragePrice?: Decimal;
  raydiumEffectivePrice?: Decimal;
  tokenUiMultiplier: Decimal;
  tokenScaleDragBps: Decimal;
  passesThreshold: boolean;
  notes: string[];
};
