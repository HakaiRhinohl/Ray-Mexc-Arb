import { Decimal } from "decimal.js";
import { createRaydiumClmmQuoteProvider, type RaydiumClmmQuoteProvider } from "./clients/raydium.js";
import { buyBaseWithQuote, sellBaseForQuote } from "./clients/mexc.js";
import { bpsMultiplier, floorDecimal, fromBaseUnits, toBaseUnits } from "./math.js";
import type { Opportunity, OrderBook, TokenScale } from "./types.js";

export async function evaluateOpportunities(args: {
  orderBook: OrderBook;
  tradeSizesUsd: number[];
  tradeDirections?: ("MEXC_TO_RAYDIUM" | "RAYDIUM_TO_MEXC")[];
  spyxMint: string;
  usdcMint: string;
  solanaRpcUrl: string;
  spyxScale: TokenScale;
  usdcScale: TokenScale;
  mexcTakerFeeBps: number;
  mexcBasePrecision: number;
  raydiumSlippageBps: number;
  settlementRiskBufferBps: number;
  minNetSpreadBps: number;
  mexcWithdrawFeeSpyx: number;
  solanaTxCostUsd: number;
}): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];
  const mexcFeeMultiplier = bpsMultiplier(args.mexcTakerFeeBps);
  const settlementMultiplier = bpsMultiplier(args.settlementRiskBufferBps);
  const tokenScaleDragBps = args.spyxScale.uiMultiplier.minus(1).mul(10_000);
  const timestamp = new Date().toISOString();
  const raydiumQuoteProvider = await createRaydiumClmmQuoteProvider({ solanaRpcUrl: args.solanaRpcUrl });

  const directions = args.tradeDirections?.length ? args.tradeDirections : ["MEXC_TO_RAYDIUM", "RAYDIUM_TO_MEXC"];

  for (const size of args.tradeSizesUsd) {
    const notionalUsd = new Decimal(size);
    if (directions.includes("MEXC_TO_RAYDIUM")) {
      opportunities.push(
        await evaluateMexcToRaydium({
          ...args,
          timestamp,
          notionalUsd,
          mexcFeeMultiplier,
          settlementMultiplier,
          tokenScaleDragBps,
          raydiumQuoteProvider
        })
      );
    }
    if (directions.includes("RAYDIUM_TO_MEXC")) {
      opportunities.push(
        await evaluateRaydiumToMexc({
          ...args,
          timestamp,
          notionalUsd,
          mexcFeeMultiplier,
          settlementMultiplier,
          tokenScaleDragBps,
          raydiumQuoteProvider
        })
      );
    }
  }

  return opportunities;
}

async function evaluateMexcToRaydium(args: Parameters<typeof evaluateRoute>[0]): Promise<Opportunity> {
  return evaluateRoute(args, "MEXC_TO_RAYDIUM");
}

async function evaluateRaydiumToMexc(args: Parameters<typeof evaluateRoute>[0]): Promise<Opportunity> {
  return evaluateRoute(args, "RAYDIUM_TO_MEXC");
}

async function evaluateRoute(
  args: {
    orderBook: OrderBook;
    spyxMint: string;
    usdcMint: string;
    spyxScale: TokenScale;
    usdcScale: TokenScale;
    raydiumSlippageBps: number;
    settlementRiskBufferBps: number;
    minNetSpreadBps: number;
    mexcBasePrecision: number;
    mexcWithdrawFeeSpyx: number;
    solanaTxCostUsd: number;
    timestamp: string;
    notionalUsd: Decimal;
    mexcFeeMultiplier: Decimal;
    settlementMultiplier: Decimal;
    tokenScaleDragBps: Decimal;
    raydiumQuoteProvider: RaydiumClmmQuoteProvider;
  },
  direction: "MEXC_TO_RAYDIUM" | "RAYDIUM_TO_MEXC"
): Promise<Opportunity> {
  const notes: string[] = [];

  if (direction === "MEXC_TO_RAYDIUM") {
    const mexcBuy = buyBaseWithQuote(args.orderBook.asks, args.notionalUsd);
    if (!mexcBuy.filled) notes.push("MEXC asks do not fully cover requested notional");

    const grossQuote = await args.raydiumQuoteProvider.fetchBaseInQuote({
      inputMint: args.spyxMint,
      outputMint: args.usdcMint,
      amount: toBaseUnits(mexcBuy.baseAmount.mul(args.spyxScale.uiMultiplier), args.spyxScale.decimals),
      slippageBps: args.raydiumSlippageBps
    });
    const grossOutUsd = fromBaseUnits(grossQuote.outAmount, args.usdcScale.decimals);

    const spyxAfterFeeAndWithdraw = Decimal.max(
      mexcBuy.baseAmount.mul(args.mexcFeeMultiplier).minus(args.mexcWithdrawFeeSpyx),
      0
    );
    const netQuote = await args.raydiumQuoteProvider.fetchBaseInQuote({
      inputMint: args.spyxMint,
      outputMint: args.usdcMint,
      amount: toBaseUnits(spyxAfterFeeAndWithdraw.mul(args.spyxScale.uiMultiplier), args.spyxScale.decimals),
      slippageBps: args.raydiumSlippageBps
    });

    const outAfterTradingFeesUsd = fromBaseUnits(netQuote.outAmount, args.usdcScale.decimals);
    const netOutUsd = outAfterTradingFeesUsd.mul(args.settlementMultiplier).minus(args.solanaTxCostUsd);
    const pnlUsd = netOutUsd.minus(args.notionalUsd);
    const grossSpreadBps = grossOutUsd.minus(args.notionalUsd).div(args.notionalUsd).mul(10_000);
    const netSpreadBps = pnlUsd.div(args.notionalUsd).mul(10_000);
    const raydiumEffectivePrice = spyxAfterFeeAndWithdraw.gt(0)
      ? outAfterTradingFeesUsd.div(spyxAfterFeeAndWithdraw)
      : undefined;

    return {
      timestamp: args.timestamp,
      direction,
      notionalUsd: args.notionalUsd,
      grossOutUsd,
      netOutUsd,
      pnlUsd,
      grossSpreadBps,
      netSpreadBps,
      entrySpyxAmount: spyxAfterFeeAndWithdraw,
      mexcAveragePrice: mexcBuy.averagePrice,
      raydiumEffectivePrice,
      tokenUiMultiplier: args.spyxScale.uiMultiplier,
      tokenScaleDragBps: args.tokenScaleDragBps,
      passesThreshold: netSpreadBps.gte(args.minNetSpreadBps) && mexcBuy.filled,
      notes
    };
  }

  const quote = await args.raydiumQuoteProvider.fetchBaseInQuote({
    inputMint: args.usdcMint,
    outputMint: args.spyxMint,
    amount: toBaseUnits(args.notionalUsd, args.usdcScale.decimals),
    slippageBps: args.raydiumSlippageBps
  });
  const spyxBought = fromBaseUnits(quote.outAmount, args.spyxScale.decimals);
  const mexcSellableSpyx = floorDecimal(spyxBought.div(args.spyxScale.uiMultiplier), args.mexcBasePrecision);
  const mexcSell = sellBaseForQuote(args.orderBook.bids, mexcSellableSpyx);
  if (!mexcSell.filled) notes.push("MEXC bids do not fully cover Raydium output");

  const grossOutUsd = mexcSell.quoteAmount;
  const outAfterTradingFeesUsd = grossOutUsd.mul(args.mexcFeeMultiplier);
  const netOutUsd = outAfterTradingFeesUsd.mul(args.settlementMultiplier).minus(args.solanaTxCostUsd);
  const pnlUsd = netOutUsd.minus(args.notionalUsd);
  const grossSpreadBps = grossOutUsd.minus(args.notionalUsd).div(args.notionalUsd).mul(10_000);
  const netSpreadBps = pnlUsd.div(args.notionalUsd).mul(10_000);
  const raydiumEffectivePrice = spyxBought.gt(0) ? args.notionalUsd.div(spyxBought) : undefined;

  return {
    timestamp: args.timestamp,
    direction,
    notionalUsd: args.notionalUsd,
    grossOutUsd,
    netOutUsd,
    pnlUsd,
    grossSpreadBps,
    netSpreadBps,
    entrySpyxAmount: spyxBought,
    mexcAveragePrice: mexcSell.averagePrice,
    raydiumEffectivePrice,
    tokenUiMultiplier: args.spyxScale.uiMultiplier,
    tokenScaleDragBps: args.tokenScaleDragBps,
    passesThreshold: netSpreadBps.gte(args.minNetSpreadBps) && mexcSell.filled,
    notes
  };
}
