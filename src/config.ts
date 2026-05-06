import "dotenv/config";
import { z } from "zod";

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;

    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
    return value;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  MEXC_SYMBOL: z.string().default("SPYXUSDT"),
  SPYX_MINT: z.string().default("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"),
  USDC_MINT: z.string().default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  TRADE_SIZES_USD: z.string().default("25,50,100"),
  TRADE_DIRECTIONS: z.string().default("RAYDIUM_TO_MEXC"),
  MIN_NET_SPREAD_BPS: z.coerce.number().default(150),
  MEXC_TAKER_FEE_BPS: z.coerce.number().default(5),
  MEXC_BASE_PRECISION: z.coerce.number().default(3),
  RAYDIUM_SLIPPAGE_BPS: z.coerce.number().default(50),
  SETTLEMENT_RISK_BUFFER_BPS: z.coerce.number().default(50),
  MEXC_WITHDRAW_FEE_SPYX: z.coerce.number().default(0),
  SOLANA_TX_COST_USD: z.coerce.number().default(0.01),
  SCAN_INTERVAL_MS: z.coerce.number().default(15_000),
  LOG_CSV_PATH: z.string().default("data/opportunities.csv"),
  PAPER_MIN_MARKET_SPREAD_BPS: z.coerce.number().default(25),
  PAPER_SETTLEMENT_DELAYS_MS: z.string().default("120000,300000,600000,1200000"),
  PAPER_OPEN_COOLDOWN_MS: z.coerce.number().default(60_000),
  PAPER_MAX_OPEN_POSITIONS: z.coerce.number().default(200),
  PAPER_LOG_CSV_PATH: z.string().default("data/paper-trades.csv"),
  PAPER_REALISTIC_MODE: envBoolean(true),
  PAPER_CAPITAL_USD: z.coerce.number().default(300),
  PAPER_REALISTIC_SETTLEMENT_DELAY_MS: z.coerce.number().optional(),
  PAPER_MEXC_BASE_PRECISION: z.coerce.number().default(3),
  PAPER_LIVE_EXTRA_COST_USD: z.coerce.number().default(0),
  TELEGRAM_ENABLED: envBoolean(false),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_OPPORTUNITY_ALERTS: envBoolean(true),
  TELEGRAM_HOURLY_REPORTS: envBoolean(true),
  TELEGRAM_STARTUP_MESSAGE: envBoolean(true),
  TELEGRAM_MIN_NET_SPREAD_BPS: z.coerce.number().optional(),
  TELEGRAM_ALERT_COOLDOWN_MS: z.coerce.number().default(300_000),
  TELEGRAM_REPORT_INTERVAL_MS: z.coerce.number().default(3_600_000)
});

const env = envSchema.parse(process.env);

const tradeSizesUsd = env.TRADE_SIZES_USD.split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

if (tradeSizesUsd.length === 0) {
  throw new Error("TRADE_SIZES_USD must contain at least one positive number");
}

const paperSettlementDelaysMs = env.PAPER_SETTLEMENT_DELAYS_MS.split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
  .sort((a, b) => a - b);

if (paperSettlementDelaysMs.length === 0) {
  throw new Error("PAPER_SETTLEMENT_DELAYS_MS must contain at least one positive number");
}

export const config = {
  mexcSymbol: env.MEXC_SYMBOL.toUpperCase(),
  spyxMint: env.SPYX_MINT,
  usdcMint: env.USDC_MINT,
  solanaRpcUrl: env.SOLANA_RPC_URL,
  tradeSizesUsd,
  tradeDirections: env.TRADE_DIRECTIONS.split(",")
    .map((value) => value.trim())
    .filter((value): value is "MEXC_TO_RAYDIUM" | "RAYDIUM_TO_MEXC" => value === "MEXC_TO_RAYDIUM" || value === "RAYDIUM_TO_MEXC"),
  minNetSpreadBps: env.MIN_NET_SPREAD_BPS,
  mexcTakerFeeBps: env.MEXC_TAKER_FEE_BPS,
  mexcBasePrecision: Math.max(0, Math.floor(env.MEXC_BASE_PRECISION)),
  raydiumSlippageBps: env.RAYDIUM_SLIPPAGE_BPS,
  settlementRiskBufferBps: env.SETTLEMENT_RISK_BUFFER_BPS,
  mexcWithdrawFeeSpyx: env.MEXC_WITHDRAW_FEE_SPYX,
  solanaTxCostUsd: env.SOLANA_TX_COST_USD,
  scanIntervalMs: env.SCAN_INTERVAL_MS,
  logCsvPath: env.LOG_CSV_PATH,
  paperMinMarketSpreadBps: env.PAPER_MIN_MARKET_SPREAD_BPS,
  paperSettlementDelaysMs,
  paperOpenCooldownMs: env.PAPER_OPEN_COOLDOWN_MS,
  paperMaxOpenPositions: env.PAPER_MAX_OPEN_POSITIONS,
  paperLogCsvPath: env.PAPER_LOG_CSV_PATH,
  paperRealisticMode: env.PAPER_REALISTIC_MODE,
  paperCapitalUsd: env.PAPER_CAPITAL_USD,
  paperRealisticSettlementDelayMs: env.PAPER_REALISTIC_SETTLEMENT_DELAY_MS ?? paperSettlementDelaysMs[0],
  paperMexcBasePrecision: Math.max(0, Math.floor(env.PAPER_MEXC_BASE_PRECISION)),
  paperLiveExtraCostUsd: env.PAPER_LIVE_EXTRA_COST_USD,
  telegram: {
    enabled: env.TELEGRAM_ENABLED,
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    chatId: env.TELEGRAM_CHAT_ID?.trim() || undefined,
    opportunityAlerts: env.TELEGRAM_OPPORTUNITY_ALERTS,
    hourlyReports: env.TELEGRAM_HOURLY_REPORTS,
    startupMessage: env.TELEGRAM_STARTUP_MESSAGE,
    minNetSpreadBps: env.TELEGRAM_MIN_NET_SPREAD_BPS ?? env.MIN_NET_SPREAD_BPS,
    alertCooldownMs: env.TELEGRAM_ALERT_COOLDOWN_MS,
    reportIntervalMs: env.TELEGRAM_REPORT_INTERVAL_MS
  }
} as const;
