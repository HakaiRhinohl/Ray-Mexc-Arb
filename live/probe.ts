import { setTimeout as sleep } from "node:timers/promises";
import { Connection, PublicKey } from "@solana/web3.js";
import { Decimal } from "decimal.js";
import { fetchMexcOrderBook } from "../src/clients/mexc.js";
import { sellBaseForQuote } from "../src/clients/mexc.js";
import { fetchRaydiumBaseInQuote } from "../src/clients/raydium.js";
import { fetchTokenScale } from "../src/clients/solana.js";
import { bpsMultiplier, floorDecimal, formatDecimal, fromBaseUnits, fromRawTokenUnits, toBaseUnits } from "../src/math.js";
import { appendJournal } from "./journal.js";
import { MexcSignedClient } from "./mexc.js";
import { buildRaydiumSwapTransactions, signSendAndConfirmRaydiumSwap } from "./raydium.js";
import {
  ensureAta,
  getAta,
  getMintProgramId,
  getUiTokenBalance,
  loadSolanaKeypair,
  transferToken
} from "./solana.js";
import type { LiveConfig, RiskPolicy } from "./types.js";

export async function runLiveProbe(args: {
  config: LiveConfig;
  policy: RiskPolicy;
}): Promise<void> {
  const { config, policy } = args;
  const dryRun = config.mode !== "execute";

  if (!config.allowedDirections.includes("RAYDIUM_TO_MEXC")) {
    throw new Error("live:probe currently supports only RAYDIUM_TO_MEXC");
  }

  if (config.probeNotionalUsd > config.maxTradeNotionalUsd || config.probeNotionalUsd > policy.maxTradeNotionalUsd) {
    throw new Error("Probe notional exceeds configured risk cap");
  }

  if (!dryRun) {
    if (!config.executionEnabled) {
      throw new Error("Probe execution blocked: LIVE_EXECUTION_ENABLED must be true");
    }
    if (config.confirmation !== "I_UNDERSTAND_REAL_MONEY") {
      throw new Error("Probe execution blocked: LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY is required");
    }
    if (!policy.enabled) {
      throw new Error("Probe execution blocked: risk policy enabled=true is required");
    }
  }

  const [spyxScale, usdcScale, orderBook] = await Promise.all([
    fetchTokenScale(config.solanaRpcUrl, config.spyxMint),
    fetchTokenScale(config.solanaRpcUrl, config.usdcMint),
    fetchMexcOrderBook(config.mexcSymbol)
  ]);

  const notionalUsd = new Decimal(config.probeNotionalUsd);
  const quote = await fetchRaydiumBaseInQuote({
    solanaRpcUrl: config.solanaRpcUrl,
    inputMint: config.usdcMint,
    outputMint: config.spyxMint,
    amount: toBaseUnits(notionalUsd, usdcScale.decimals),
    slippageBps: config.maxSlippageBps
  });
  const expectedSpyxWalletUi = fromRawTokenUnits(quote.outAmount, spyxScale);
  const expectedSpyxOnChainAmount = fromBaseUnits(quote.outAmount, spyxScale.decimals);
  const expectedSpyxMexcCredit = floorDecimal(
    expectedSpyxOnChainAmount.div(spyxScale.uiMultiplier),
    config.mexcBasePrecision
  );
  const mexcSell = sellBaseForQuote(orderBook.bids, expectedSpyxMexcCredit);
  const mexcFeeMultiplier = bpsMultiplier(5);
  const grossOutUsd = mexcSell.quoteAmount;
  const netOutUsd = grossOutUsd.mul(mexcFeeMultiplier).minus(0.01);
  const marketSpreadBps = grossOutUsd.minus(notionalUsd).div(notionalUsd).mul(10_000);
  const netSpreadBps = netOutUsd.minus(notionalUsd).div(notionalUsd).mul(10_000);
  const raydiumEffectivePrice = expectedSpyxMexcCredit.gt(0) ? notionalUsd.div(expectedSpyxMexcCredit) : undefined;

  console.log("\nProbe opportunity");
  console.log("Direction:   RAYDIUM_TO_MEXC");
  console.log(`Notional:    $${formatDecimal(notionalUsd, 2)}`);
  console.log(`Market:      ${formatDecimal(marketSpreadBps, 2)} bps`);
  console.log(`Net instant: ${formatDecimal(netSpreadBps, 2)} bps`);
  console.log(`Raydium px:  ${raydiumEffectivePrice ? formatDecimal(raydiumEffectivePrice, 8) : "n/a"} raw-MEXC units`);
  console.log(`MEXC avg:    ${formatDecimal(mexcSell.averagePrice, 8)}`);
  console.log(`Raydium pool:${quote.poolId} fee=${formatDecimal(new Decimal(quote.feeRate).mul(10_000), 2)} bps`);
  console.log(`Price impact:${formatDecimal(new Decimal(quote.priceImpactPct), 6)}%`);
  console.log(`Expected SPYx wallet UI: ${formatDecimal(expectedSpyxWalletUi, 8)}`);
  console.log(`Expected SPYx on-chain:  ${formatDecimal(expectedSpyxOnChainAmount, 8)}`);
  console.log(`Expected MEXC sellable:  ${formatDecimal(expectedSpyxMexcCredit, 8)}`);

  await appendJournal(config.stateDir, "probe.plan", {
    dryRun,
    direction: "RAYDIUM_TO_MEXC",
    notionalUsd: notionalUsd.toString(),
    marketSpreadBps: marketSpreadBps.toString(),
    netSpreadBps: netSpreadBps.toString()
  });

  await appendJournal(config.stateDir, "probe.raydium_quote", {
    inputAmount: quote.inAmount.toString(),
    outputAmount: quote.outAmount.toString(),
    expectedSpyxWalletUi: expectedSpyxWalletUi.toString(),
    expectedSpyxOnChainAmount: expectedSpyxOnChainAmount.toString(),
    expectedSpyxMexcCredit: expectedSpyxMexcCredit.toString(),
    raw: quote.raw
  });

  const belowProbeThreshold = netSpreadBps.lt(config.probeMinNetSpreadBps);
  if (!dryRun && belowProbeThreshold) {
    console.log(`Probe stopped: net instant spread is below ${config.probeMinNetSpreadBps} bps.`);
    return;
  }

  const walletPublicKey = await resolveWalletPublicKey(config, dryRun);
  if (!walletPublicKey) {
    console.log("Probe dry-run stopped before transaction build: no Solana wallet public key configured.");
    return;
  }

  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const usdcMint = new PublicKey(config.usdcMint);
  const spyxMint = new PublicKey(config.spyxMint);
  const [usdcProgramId, spyxProgramId] = await Promise.all([
    getMintProgramId(connection, usdcMint),
    getMintProgramId(connection, spyxMint)
  ]);
  const usdcAta = getAta(usdcMint, walletPublicKey, usdcProgramId);
  const spyxAta = getAta(spyxMint, walletPublicKey, spyxProgramId);
  console.log(`USDC ATA:     ${usdcAta.toBase58()}`);
  console.log(`SPYx ATA:     ${spyxAta.toBase58()}`);

  if (dryRun) {
    await appendJournal(config.stateDir, "probe.dry_run_ready", {
      wallet: walletPublicKey.toBase58(),
      usdcAta: usdcAta.toBase58(),
      spyxAta: spyxAta.toBase58(),
      autoTransferToMexc: config.probeAutoTransferToMexc
    });
    if (belowProbeThreshold) {
      console.log(`Probe stopped: net instant spread is below ${config.probeMinNetSpreadBps} bps.`);
    }
    console.log("Dry-run complete. Execute mode is required to sign/send the Raydium swap.");
    return;
  }

  if (!policy.enabled || !policy.allowRaydiumSwaps) {
    throw new Error("Probe execution blocked: risk policy must enable allowRaydiumSwaps");
  }

  const owner = await loadSolanaKeypair({
    keypairPath: config.solanaKeypairPath,
    privateKeyBase58: config.solanaPrivateKeyBase58
  });
  if (!owner.publicKey.equals(walletPublicKey)) {
    throw new Error(`Signer public key ${owner.publicKey.toBase58()} does not match SOLANA_WALLET_PUBLIC_KEY ${walletPublicKey.toBase58()}`);
  }

  await ensureAta({
    connection,
    payer: owner,
    mint: spyxMint,
    owner: owner.publicKey,
    tokenProgramId: spyxProgramId,
    dryRun: false
  });

  const usdcBalance = await getUiTokenBalance(connection, usdcAta);
  const spyxBefore = await getUiTokenBalance(connection, spyxAta).catch(() => new Decimal(0));
  if (usdcBalance.lt(notionalUsd)) {
    throw new Error(`Insufficient USDC balance: have ${formatDecimal(usdcBalance, 6)}, need ${formatDecimal(notionalUsd, 6)}`);
  }

  const freshOrderBook = await fetchMexcOrderBook(config.mexcSymbol);
  const freshQuote = await fetchRaydiumBaseInQuote({
    solanaRpcUrl: config.solanaRpcUrl,
    inputMint: config.usdcMint,
    outputMint: config.spyxMint,
    amount: toBaseUnits(notionalUsd, usdcScale.decimals),
    slippageBps: config.maxSlippageBps
  });
  const freshExpectedSpyxOnChainAmount = fromBaseUnits(freshQuote.outAmount, spyxScale.decimals);
  const freshExpectedSpyxMexcCredit = floorDecimal(
    freshExpectedSpyxOnChainAmount.div(spyxScale.uiMultiplier),
    config.mexcBasePrecision
  );
  const freshMexcSell = sellBaseForQuote(freshOrderBook.bids, freshExpectedSpyxMexcCredit);
  const freshNetOutUsd = freshMexcSell.quoteAmount.mul(mexcFeeMultiplier).minus(0.01);
  const freshNetSpreadBps = freshNetOutUsd.minus(notionalUsd).div(notionalUsd).mul(10_000);

  await appendJournal(config.stateDir, "probe.raydium_quote_fresh", {
    inputAmount: freshQuote.inAmount.toString(),
    outputAmount: freshQuote.outAmount.toString(),
    expectedSpyxOnChainAmount: freshExpectedSpyxOnChainAmount.toString(),
    expectedSpyxMexcCredit: freshExpectedSpyxMexcCredit.toString(),
    netSpreadBps: freshNetSpreadBps.toString(),
    raw: freshQuote.raw
  });

  if (freshNetSpreadBps.lt(config.probeMinNetSpreadBps)) {
    throw new Error(`Fresh quote blocked execution: net spread ${formatDecimal(freshNetSpreadBps, 2)} bps is below ${config.probeMinNetSpreadBps} bps`);
  }

  const swapTransactions = await buildRaydiumSwapTransactions({
    connection,
    owner,
    quote: freshQuote,
    computeUnitPriceMicroLamports: config.probePriorityFeeMicroLamports
  });
  await appendJournal(config.stateDir, "probe.swap_built", {
    transactionCount: swapTransactions.length,
    usdcAta: usdcAta.toBase58(),
    spyxAta: spyxAta.toBase58()
  });

  const swapSignatures = await signSendAndConfirmRaydiumSwap({
    connection,
    owner,
    transactions: swapTransactions
  });
  const spyxAfter = await getUiTokenBalance(connection, spyxAta);
  const spyxReceived = spyxAfter.minus(spyxBefore);
  await appendJournal(config.stateDir, "probe.swap_confirmed", {
    signatures: swapSignatures,
    spyxBefore: spyxBefore.toString(),
    spyxAfter: spyxAfter.toString(),
    spyxReceived: spyxReceived.toString()
  });
  console.log(`Swap confirmed: ${swapSignatures.join(", ")}`);
  console.log(`SPYx received: ${formatDecimal(spyxReceived, 8)}`);

  if (!config.probeAutoTransferToMexc) {
    console.log("Auto-transfer to MEXC is disabled. Verify wallet balance manually before enabling LIVE_PROBE_AUTO_TRANSFER_TO_MEXC.");
    return;
  }

  if (!policy.allowMexcDeposits) {
    throw new Error("Probe transfer blocked: risk policy must set allowMexcDeposits=true");
  }
  if (!config.mexcSolanaDepositAddress) {
    throw new Error("MEXC_SOLANA_DEPOSIT_ADDRESS is required for probe transfer");
  }

  const transferResult = await transferToken({
    connection,
    payer: owner,
    mint: spyxMint,
    sourceOwner: owner.publicKey,
    destinationOwner: new PublicKey(config.mexcSolanaDepositAddress),
    amountUi: spyxReceived,
    scale: spyxScale,
    tokenProgramId: spyxProgramId,
    dryRun: false
  });
  await appendJournal(config.stateDir, "probe.transfer_to_mexc_confirmed", transferResult);
  console.log(`Transfer to MEXC confirmed: ${transferResult.signature}`);

  if (config.mexcApiKey && config.mexcApiSecret) {
    await pollMexcDeposit({
      config,
      txId: transferResult.signature ?? "",
      startTime: Date.now() - 60_000
    });
  }
}

async function resolveWalletPublicKey(config: LiveConfig, dryRun: boolean): Promise<PublicKey | undefined> {
  if (config.solanaWalletPublicKey) return new PublicKey(config.solanaWalletPublicKey);
  if (dryRun) return undefined;

  const owner = await loadSolanaKeypair({
    keypairPath: config.solanaKeypairPath,
    privateKeyBase58: config.solanaPrivateKeyBase58
  });
  return owner.publicKey;
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
      await appendJournal(args.config.stateDir, "probe.mexc_deposit_seen", { deposit: match });
      console.log(`MEXC deposit seen: status=${match.status} amount=${match.amount} tx=${match.txId}`);
      return;
    }
    await sleep(15_000);
  }

  await appendJournal(args.config.stateDir, "probe.mexc_deposit_timeout", {
    txId: args.txId,
    pollMs: args.config.probePollDepositMs
  });
  console.log("MEXC deposit polling timed out; check MEXC manually.");
}
