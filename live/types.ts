export type LiveMode = "plan" | "dry-run" | "execute";

export type LiveDirection = "RAYDIUM_TO_MEXC" | "MEXC_TO_RAYDIUM";

export type RiskPolicy = {
  enabled: boolean;
  allowRaydiumSwaps: boolean;
  allowMexcOrders: boolean;
  allowMexcWithdrawals: boolean;
  allowMexcDeposits: boolean;
  allowedDirections: LiveDirection[];
  maxTradeNotionalUsd: number;
  maxDailyLossUsd: number;
  maxOpenTransfers: number;
  minNetSpreadBps: number;
  maxSlippageBps: number;
  requireManualConfirmation: boolean;
  notes?: string[];
};

export type LiveConfig = {
  mode: LiveMode;
  executionEnabled: boolean;
  confirmation: string;
  mexcSymbol: string;
  spyxMint: string;
  usdcMint: string;
  solanaRpcUrl: string;
  mexcApiKey?: string;
  mexcApiSecret?: string;
  mexcBasePrecision: number;
  solanaKeypairPath?: string;
  solanaPrivateKeyBase58?: string;
  solanaWalletPublicKey?: string;
  mexcSpyxCoin: string;
  mexcSpyxNetwork?: string;
  mexcSolanaDepositAddress?: string;
  mexcWithdrawAddressSolana?: string;
  allowedDirections: LiveDirection[];
  maxTradeNotionalUsd: number;
  minNetSpreadBps: number;
  maxSlippageBps: number;
  maxDailyLossUsd: number;
  maxOpenTransfers: number;
  requireManualConfirmation: boolean;
  probeNotionalUsd: number;
  probeMinNetSpreadBps: number;
  probeAutoTransferToMexc: boolean;
  probePollDepositMs: number;
  probePriorityFeeMicroLamports: string;
  transferSpyxAmount?: string;
  sellSpyxAmount?: string;
  riskPolicyPath: string;
  stateDir: string;
};

export type PreflightItem = {
  name: string;
  ok: boolean;
  detail: string;
};
