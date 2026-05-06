import dotenv from "dotenv";
import { z } from "zod";
import type { LiveConfig, LiveDirection } from "./types.js";

// Single source of truth: edit the repository root .env.
dotenv.config();

const directionSchema = z.enum(["RAYDIUM_TO_MEXC", "MEXC_TO_RAYDIUM"]);

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;

    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
    return value;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  LIVE_MODE: z.enum(["plan", "dry-run", "execute"]).default("plan"),
  LIVE_EXECUTION_ENABLED: envBoolean(false),
  LIVE_CONFIRMATION: z.string().default(""),
  MEXC_SYMBOL: z.string().default("SPYXUSDT"),
  SPYX_MINT: z.string().default("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"),
  USDC_MINT: z.string().default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  MEXC_API_KEY: z.string().optional(),
  MEXC_API_SECRET: z.string().optional(),
  MEXC_BASE_PRECISION: z.coerce.number().default(3),
  SOLANA_KEYPAIR_PATH: z.string().optional(),
  SOLANA_PRIVATE_KEY_BASE58: z.string().optional(),
  SOLANA_WALLET_PUBLIC_KEY: z.string().optional(),
  MEXC_SPYX_COIN: z.string().default("SPYX"),
  MEXC_SPYX_NETWORK: z.string().optional(),
  MEXC_SOLANA_DEPOSIT_ADDRESS: z.string().optional(),
  MEXC_WITHDRAW_ADDRESS_SOLANA: z.string().optional(),
  LIVE_ALLOWED_DIRECTIONS: z.string().default("RAYDIUM_TO_MEXC"),
  LIVE_MAX_TRADE_NOTIONAL_USD: z.coerce.number().positive().default(25),
  LIVE_MIN_NET_SPREAD_BPS: z.coerce.number().positive().default(150),
  LIVE_MAX_SLIPPAGE_BPS: z.coerce.number().positive().default(50),
  LIVE_MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(10),
  LIVE_MAX_OPEN_TRANSFERS: z.coerce.number().int().positive().default(1),
  LIVE_REQUIRE_MANUAL_CONFIRMATION: envBoolean(true),
  LIVE_PROBE_NOTIONAL_USD: z.coerce.number().positive().default(25),
  LIVE_PROBE_MIN_NET_SPREAD_BPS: z.coerce.number().positive().default(25),
  LIVE_PROBE_AUTO_TRANSFER_TO_MEXC: envBoolean(false),
  LIVE_PROBE_POLL_DEPOSIT_MS: z.coerce.number().positive().default(900_000),
  LIVE_PROBE_PRIORITY_FEE_MICRO_LAMPORTS: z.string().default("10000"),
  LIVE_TRANSFER_SPYX_AMOUNT: z.string().optional(),
  LIVE_SELL_SPYX_AMOUNT: z.string().optional(),
  LIVE_RISK_POLICY_PATH: z.string().default("live/risk-policy.json"),
  LIVE_STATE_DIR: z.string().default("live/state")
});

const env = envSchema.parse(process.env);

function parseDirections(value: string): LiveDirection[] {
  const directions = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => directionSchema.parse(entry));

  if (directions.length === 0) {
    throw new Error("LIVE_ALLOWED_DIRECTIONS must include at least one direction");
  }

  return directions;
}

function optional(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export const liveConfig: LiveConfig = {
  mode: env.LIVE_MODE,
  executionEnabled: env.LIVE_EXECUTION_ENABLED,
  confirmation: env.LIVE_CONFIRMATION,
  mexcSymbol: env.MEXC_SYMBOL.toUpperCase(),
  spyxMint: env.SPYX_MINT,
  usdcMint: env.USDC_MINT,
  solanaRpcUrl: env.SOLANA_RPC_URL,
  mexcApiKey: optional(env.MEXC_API_KEY),
  mexcApiSecret: optional(env.MEXC_API_SECRET),
  mexcBasePrecision: Math.max(0, Math.floor(env.MEXC_BASE_PRECISION)),
  solanaKeypairPath: optional(env.SOLANA_KEYPAIR_PATH),
  solanaPrivateKeyBase58: optional(env.SOLANA_PRIVATE_KEY_BASE58),
  solanaWalletPublicKey: optional(env.SOLANA_WALLET_PUBLIC_KEY),
  mexcSpyxCoin: env.MEXC_SPYX_COIN,
  mexcSpyxNetwork: optional(env.MEXC_SPYX_NETWORK),
  mexcSolanaDepositAddress: optional(env.MEXC_SOLANA_DEPOSIT_ADDRESS),
  mexcWithdrawAddressSolana: optional(env.MEXC_WITHDRAW_ADDRESS_SOLANA),
  allowedDirections: parseDirections(env.LIVE_ALLOWED_DIRECTIONS),
  maxTradeNotionalUsd: env.LIVE_MAX_TRADE_NOTIONAL_USD,
  minNetSpreadBps: env.LIVE_MIN_NET_SPREAD_BPS,
  maxSlippageBps: env.LIVE_MAX_SLIPPAGE_BPS,
  maxDailyLossUsd: env.LIVE_MAX_DAILY_LOSS_USD,
  maxOpenTransfers: env.LIVE_MAX_OPEN_TRANSFERS,
  requireManualConfirmation: env.LIVE_REQUIRE_MANUAL_CONFIRMATION,
  probeNotionalUsd: env.LIVE_PROBE_NOTIONAL_USD,
  probeMinNetSpreadBps: env.LIVE_PROBE_MIN_NET_SPREAD_BPS,
  probeAutoTransferToMexc: env.LIVE_PROBE_AUTO_TRANSFER_TO_MEXC,
  probePollDepositMs: env.LIVE_PROBE_POLL_DEPOSIT_MS,
  probePriorityFeeMicroLamports: env.LIVE_PROBE_PRIORITY_FEE_MICRO_LAMPORTS,
  transferSpyxAmount: optional(env.LIVE_TRANSFER_SPYX_AMOUNT),
  sellSpyxAmount: optional(env.LIVE_SELL_SPYX_AMOUNT),
  riskPolicyPath: env.LIVE_RISK_POLICY_PATH,
  stateDir: env.LIVE_STATE_DIR
};
