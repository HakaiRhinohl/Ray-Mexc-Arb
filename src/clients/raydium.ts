import { Connection, PublicKey } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import {
  PoolUtils,
  Raydium,
  type ApiV3PoolInfoConcentratedItem,
  type ClmmKeys,
  type ComputeClmmPoolInfo,
  type ReturnTypeFetchMultiplePoolTickArrays
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import type { RaydiumQuote } from "../types.js";

export const SPYX_USDC_CLMM_POOL_IDS = [
  "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE",
  "7sHMnvE7WqP7vQFWJGEnMT4vZg6Za9K7PpddDoXJCqME"
] as const;

export type RaydiumClmmPoolSnapshot = {
  poolInfo: ApiV3PoolInfoConcentratedItem;
  poolKeys: ClmmKeys;
  computePoolInfo: ComputeClmmPoolInfo;
  tickData: ReturnTypeFetchMultiplePoolTickArrays;
};

export type RaydiumClmmQuoteProvider = {
  connection: Connection;
  raydium: Raydium;
  poolSnapshots: RaydiumClmmPoolSnapshot[];
  fetchBaseInQuote: (args: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }) => Promise<RaydiumQuote>;
};

export async function createRaydiumClmmQuoteProvider(args: {
  solanaRpcUrl?: string;
  connection?: Connection;
  owner?: PublicKey | Keypair;
  poolIds?: readonly string[];
}): Promise<RaydiumClmmQuoteProvider> {
  const connection = args.connection ?? new Connection(requiredRpcUrl(args.solanaRpcUrl), "confirmed");
  const raydium = await Raydium.load({
    connection,
    owner: args.owner,
    cluster: "mainnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
    apiRequestInterval: -1
  });

  const poolIds = args.poolIds ?? SPYX_USDC_CLMM_POOL_IDS;
  const poolSnapshots = await Promise.all(
    poolIds.map(async (poolId) => {
      try {
        return await raydium.clmm.getPoolInfoFromRpc(poolId);
      } catch (error) {
        throw new Error(`Raydium SDK RPC pool fetch failed for ${poolId}: ${errorMessage(error)}`);
      }
    })
  );

  return {
    connection,
    raydium,
    poolSnapshots,
    fetchBaseInQuote: async (quoteArgs) =>
      quoteFromSnapshots({
        raydium,
        poolSnapshots,
        ...quoteArgs
      })
  };
}

export async function fetchRaydiumBaseInQuote(args: {
  solanaRpcUrl: string;
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}): Promise<RaydiumQuote> {
  const provider = await createRaydiumClmmQuoteProvider({ solanaRpcUrl: args.solanaRpcUrl });
  return provider.fetchBaseInQuote(args);
}

async function quoteFromSnapshots(args: {
  raydium: Raydium;
  poolSnapshots: RaydiumClmmPoolSnapshot[];
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}): Promise<RaydiumQuote> {
  const amountIn = new BN(args.amount.toString());
  const slippage = args.slippageBps / 10_000;
  const epochInfo = await args.raydium.fetchEpochInfo();
  const quotes: RaydiumQuote[] = [];

  for (const snapshot of args.poolSnapshots) {
    const { poolInfo, computePoolInfo, tickData } = snapshot;
    const baseIn = args.inputMint === poolInfo.mintA.address && args.outputMint === poolInfo.mintB.address;
    const quoteIn = args.inputMint === poolInfo.mintB.address && args.outputMint === poolInfo.mintA.address;
    if (!baseIn && !quoteIn) continue;

    try {
      const tokenOut = baseIn ? poolInfo.mintB : poolInfo.mintA;
      const result = PoolUtils.computeAmountOutFormat({
        poolInfo: computePoolInfo,
        tickArrayCache: tickData[poolInfo.id],
        amountIn,
        tokenOut,
        slippage,
        epochInfo,
        catchLiquidityInsufficient: true
      });

      if (!result.allTrade) continue;
      const feeRate = normalizeFeeRate(poolInfo.feeRate);
      const priceImpactPct = Number(result.priceImpact.toFixed(8));

      quotes.push({
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        inAmount: args.amount,
        outAmount: BigInt(result.amountOut.amount.raw.toString()),
        minOutAmount: BigInt(result.minAmountOut.amount.raw.toString()),
        poolId: poolInfo.id,
        poolType: "CLMM",
        feeRate,
        priceImpactPct,
        remainingAccounts: result.remainingAccounts.map((account) => account.toBase58()),
        raw: {
          source: "raydium-sdk-v2-local-clmm",
          poolId: poolInfo.id,
          poolType: "CLMM",
          feeRate,
          priceImpactPct,
          inputMint: args.inputMint,
          outputMint: args.outputMint,
          inputAmount: args.amount.toString(),
          outputAmount: result.amountOut.amount.raw.toString(),
          otherAmountThreshold: result.minAmountOut.amount.raw.toString(),
          remainingAccounts: result.remainingAccounts.map((account) => account.toBase58())
        }
      });
    } catch (error) {
      throw new Error(`Raydium SDK local quote failed for ${poolInfo.id}: ${errorMessage(error)}`);
    }
  }

  const best = quotes.sort((left, right) => {
    if (left.outAmount === right.outAmount) return 0;
    return left.outAmount > right.outAmount ? -1 : 1;
  })[0];

  if (!best) {
    throw new Error(
      `Raydium SDK local quote unavailable for ${args.inputMint} -> ${args.outputMint}; no configured CLMM pool could fill ${args.amount.toString()} raw units`
    );
  }

  return best;
}

function requiredRpcUrl(value: string | undefined): string {
  if (!value) throw new Error("SOLANA_RPC_URL is required for Raydium SDK local quotes");
  return value;
}

function normalizeFeeRate(feeRate: number): number {
  return feeRate > 1 ? feeRate / 1_000_000 : feeRate;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
