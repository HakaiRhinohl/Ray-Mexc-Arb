import { setTimeout as sleep } from "node:timers/promises";
import { Connection, PublicKey } from "@solana/web3.js";
import { Decimal } from "decimal.js";
import { fetchTokenScale } from "../src/clients/solana.js";
import { formatDecimal } from "../src/math.js";
import { appendJournal } from "./journal.js";
import { MexcSignedClient } from "./mexc.js";
import { getAta, getMintProgramId, getUiTokenBalance, loadSolanaKeypair, transferToken } from "./solana.js";
import type { LiveConfig, RiskPolicy } from "./types.js";

export async function transferExistingSpyxToMexc(args: {
  config: LiveConfig;
  policy: RiskPolicy;
}): Promise<void> {
  const { config, policy } = args;
  assertTransferAllowed(config, policy);

  if (!config.mexcSolanaDepositAddress) {
    throw new Error("MEXC_SOLANA_DEPOSIT_ADDRESS is required");
  }

  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const owner = await loadSolanaKeypair({
    keypairPath: config.solanaKeypairPath,
    privateKeyBase58: config.solanaPrivateKeyBase58
  });
  if (config.solanaWalletPublicKey && owner.publicKey.toBase58() !== config.solanaWalletPublicKey) {
    throw new Error(`Signer public key ${owner.publicKey.toBase58()} does not match SOLANA_WALLET_PUBLIC_KEY ${config.solanaWalletPublicKey}`);
  }

  const spyxMint = new PublicKey(config.spyxMint);
  const spyxScale = await fetchTokenScale(config.solanaRpcUrl, config.spyxMint);
  const spyxProgramId = await getMintProgramId(connection, spyxMint);
  const spyxAta = getAta(spyxMint, owner.publicKey, spyxProgramId);
  const walletBalance = await getUiTokenBalance(connection, spyxAta);
  const amount = config.transferSpyxAmount ? new Decimal(config.transferSpyxAmount) : walletBalance;

  console.log("\nTransfer existing SPYx to MEXC");
  console.log(`Wallet:       ${owner.publicKey.toBase58()}`);
  console.log(`SPYx ATA:     ${spyxAta.toBase58()}`);
  console.log(`Balance:      ${formatDecimal(walletBalance, 8)} SPYx`);
  console.log(`Amount:       ${formatDecimal(amount, 8)} SPYx`);
  console.log(`MEXC address: ${config.mexcSolanaDepositAddress}`);

  if (amount.lte(0)) {
    throw new Error("No SPYx amount to transfer");
  }
  if (amount.gt(walletBalance)) {
    throw new Error(`Transfer amount exceeds wallet balance: ${formatDecimal(amount, 8)} > ${formatDecimal(walletBalance, 8)}`);
  }

  await appendJournal(config.stateDir, "transfer_to_mexc.plan", {
    sourceWallet: owner.publicKey.toBase58(),
    sourceAta: spyxAta.toBase58(),
    destination: config.mexcSolanaDepositAddress,
    walletBalance: walletBalance.toString(),
    amount: amount.toString()
  });

  const startedAt = Date.now();
  const result = await transferToken({
    connection,
    payer: owner,
    mint: spyxMint,
    sourceOwner: owner.publicKey,
    destinationOwner: new PublicKey(config.mexcSolanaDepositAddress),
    amountUi: amount,
    scale: spyxScale,
    tokenProgramId: spyxProgramId,
    dryRun: false
  });

  await appendJournal(config.stateDir, "transfer_to_mexc.confirmed", {
    ...result,
    amount: amount.toString()
  });
  console.log(`Transfer confirmed: ${result.signature}`);
  console.log(`Destination token account: ${result.destinationAta}`);

  if (config.mexcApiKey && config.mexcApiSecret && result.signature) {
    await pollMexcDeposit({
      config,
      txId: result.signature,
      startTime: startedAt - 60_000
    });
  }
}

function assertTransferAllowed(config: LiveConfig, policy: RiskPolicy): void {
  if (config.mode !== "execute") {
    throw new Error("Transfer requires LIVE_MODE=execute");
  }
  if (!config.executionEnabled) {
    throw new Error("Transfer requires LIVE_EXECUTION_ENABLED=true");
  }
  if (config.confirmation !== "I_UNDERSTAND_REAL_MONEY") {
    throw new Error("Transfer requires LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY");
  }
  if (!policy.enabled || !policy.allowMexcDeposits) {
    throw new Error("Transfer requires risk policy enabled=true and allowMexcDeposits=true");
  }
}

async function pollMexcDeposit(args: {
  config: LiveConfig;
  txId: string;
  startTime: number;
}): Promise<void> {
  const client = new MexcSignedClient(args.config.mexcApiKey!, args.config.mexcApiSecret!);
  const deadline = Date.now() + args.config.probePollDepositMs;
  while (Date.now() < deadline) {
    const deposits = await client.fetchDeposits({
      coin: args.config.mexcSpyxCoin,
      startTime: args.startTime,
      endTime: Date.now(),
      limit: 100
    });
    const match = deposits.find((deposit) => deposit.txId === args.txId || deposit.txId.includes(args.txId));
    if (match) {
      await appendJournal(args.config.stateDir, "transfer_to_mexc.deposit_seen", { deposit: match });
      console.log(`MEXC deposit seen: status=${match.status} amount=${match.amount} tx=${match.txId}`);
      return;
    }
    await sleep(15_000);
  }

  await appendJournal(args.config.stateDir, "transfer_to_mexc.deposit_timeout", {
    txId: args.txId,
    pollMs: args.config.probePollDepositMs
  });
  console.log("MEXC deposit polling timed out; check MEXC manually.");
}
