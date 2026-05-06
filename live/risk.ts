import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { LiveConfig, PreflightItem, RiskPolicy } from "./types.js";

const riskPolicySchema = z.object({
  enabled: z.boolean(),
  allowRaydiumSwaps: z.boolean(),
  allowMexcOrders: z.boolean(),
  allowMexcWithdrawals: z.boolean(),
  allowMexcDeposits: z.boolean(),
  allowedDirections: z.array(z.enum(["RAYDIUM_TO_MEXC", "MEXC_TO_RAYDIUM"])).min(1),
  maxTradeNotionalUsd: z.number().positive(),
  maxDailyLossUsd: z.number().positive(),
  maxOpenTransfers: z.number().int().positive(),
  minNetSpreadBps: z.number().positive(),
  maxSlippageBps: z.number().positive(),
  requireManualConfirmation: z.boolean(),
  notes: z.array(z.string()).optional()
});

export async function loadRiskPolicy(path: string): Promise<RiskPolicy> {
  const raw = await readFile(path, "utf8");
  return riskPolicySchema.parse(JSON.parse(raw));
}

export function buildPreflight(config: LiveConfig, policy: RiskPolicy): PreflightItem[] {
  const hasSolanaSigner = Boolean(config.solanaKeypairPath || config.solanaPrivateKeyBase58);
  const needsMexcWithdrawalAddress = config.allowedDirections.includes("MEXC_TO_RAYDIUM");
  const needsMexcDepositAddress = config.allowedDirections.includes("RAYDIUM_TO_MEXC");

  return [
    {
      name: "live mode",
      ok: config.mode !== "execute" || config.executionEnabled,
      detail: config.mode === "execute" ? "execute requested; LIVE_EXECUTION_ENABLED must be true" : `mode=${config.mode}`
    },
    {
      name: "execution confirmation",
      ok: config.mode !== "execute" || config.confirmation === "I_UNDERSTAND_REAL_MONEY",
      detail: "execute requires LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY"
    },
    {
      name: "risk policy enabled",
      ok: config.mode !== "execute" || policy.enabled,
      detail: `policy.enabled=${policy.enabled}`
    },
    {
      name: "MEXC API credentials",
      ok: Boolean(config.mexcApiKey && config.mexcApiSecret),
      detail: config.mexcApiKey && config.mexcApiSecret ? "present" : "missing"
    },
    {
      name: "Solana signer",
      ok: hasSolanaSigner,
      detail: hasSolanaSigner ? "present" : "missing SOLANA_KEYPAIR_PATH or SOLANA_PRIVATE_KEY_BASE58"
    },
    {
      name: "Solana wallet public key",
      ok: Boolean(config.solanaWalletPublicKey),
      detail: config.solanaWalletPublicKey ? "present" : "missing"
    },
    {
      name: "MEXC SPYx network",
      ok: Boolean(config.mexcSpyxNetwork),
      detail: config.mexcSpyxNetwork ? `netWork=${config.mexcSpyxNetwork}` : "must be confirmed from MEXC /api/v3/capital/config/getall"
    },
    {
      name: "MEXC deposit address",
      ok: !needsMexcDepositAddress || Boolean(config.mexcSolanaDepositAddress),
      detail: needsMexcDepositAddress ? "required for RAYDIUM_TO_MEXC" : "not required for configured directions"
    },
    {
      name: "MEXC withdrawal address",
      ok: !needsMexcWithdrawalAddress || Boolean(config.mexcWithdrawAddressSolana),
      detail: needsMexcWithdrawalAddress ? "required for MEXC_TO_RAYDIUM" : "not required for configured directions"
    },
    {
      name: "direction policy",
      ok: config.allowedDirections.every((direction) => policy.allowedDirections.includes(direction)),
      detail: `env=${config.allowedDirections.join(",")} policy=${policy.allowedDirections.join(",")}`
    },
    {
      name: "trade size cap",
      ok: config.maxTradeNotionalUsd <= policy.maxTradeNotionalUsd,
      detail: `env=${config.maxTradeNotionalUsd} policy=${policy.maxTradeNotionalUsd}`
    },
    {
      name: "spread threshold",
      ok: config.minNetSpreadBps >= policy.minNetSpreadBps,
      detail: `env=${config.minNetSpreadBps} policy=${policy.minNetSpreadBps}`
    },
    {
      name: "slippage cap",
      ok: config.maxSlippageBps <= policy.maxSlippageBps,
      detail: `env=${config.maxSlippageBps} policy=${policy.maxSlippageBps}`
    },
    {
      name: "open transfer cap",
      ok: config.maxOpenTransfers <= policy.maxOpenTransfers,
      detail: `env=${config.maxOpenTransfers} policy=${policy.maxOpenTransfers}`
    }
  ];
}

export function assertExecuteAllowed(config: LiveConfig, policy: RiskPolicy, preflight: PreflightItem[]): void {
  if (config.mode !== "execute") return;

  const failed = preflight.filter((item) => !item.ok);
  if (failed.length > 0) {
    throw new Error(`Live execution blocked by failed preflight: ${failed.map((item) => item.name).join(", ")}`);
  }

  if (!policy.allowRaydiumSwaps || !policy.allowMexcOrders) {
    throw new Error("Live execution blocked: policy must explicitly allow Raydium swaps and MEXC orders");
  }

  if (config.allowedDirections.includes("MEXC_TO_RAYDIUM") && !policy.allowMexcWithdrawals) {
    throw new Error("Live execution blocked: MEXC_TO_RAYDIUM requires allowMexcWithdrawals=true");
  }
}
