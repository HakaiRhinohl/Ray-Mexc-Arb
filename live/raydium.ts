import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { TxVersion } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { createRaydiumClmmQuoteProvider } from "../src/clients/raydium.js";
import type { RaydiumQuote } from "../src/types.js";

export async function buildRaydiumSwapTransactions(args: {
  connection: Connection;
  owner: Keypair;
  quote: RaydiumQuote;
  computeUnitPriceMicroLamports: string;
}) {
  const provider = await createRaydiumClmmQuoteProvider({
    connection: args.connection,
    owner: args.owner,
    poolIds: [args.quote.poolId]
  });
  const snapshot = provider.poolSnapshots.find((pool) => pool.poolInfo.id === args.quote.poolId);
  if (!snapshot) throw new Error(`Raydium pool snapshot not found for ${args.quote.poolId}`);

  const { transaction } = await provider.raydium.clmm.swap({
    poolInfo: snapshot.poolInfo,
    poolKeys: snapshot.poolKeys,
    inputMint: args.quote.inputMint,
    amountIn: new BN(args.quote.inAmount.toString()),
    amountOutMin: new BN(args.quote.minOutAmount.toString()),
    observationId: new PublicKey(snapshot.poolKeys.observationId),
    ownerInfo: {
      useSOLBalance: false,
      feePayer: args.owner.publicKey
    },
    remainingAccounts: args.quote.remainingAccounts.map((account) => new PublicKey(account)),
    associatedOnly: true,
    checkCreateATAOwner: true,
    txVersion: TxVersion.V0,
    computeBudgetConfig: {
      units: 600_000,
      microLamports: Number(args.computeUnitPriceMicroLamports)
    }
  });

  return [transaction];
}

export async function signSendAndConfirmRaydiumSwap(args: {
  connection: Connection;
  owner: Keypair;
  transactions: Awaited<ReturnType<typeof buildRaydiumSwapTransactions>>;
}): Promise<string[]> {
  const signatures: string[] = [];

  for (const tx of args.transactions) {
    tx.sign([args.owner]);
    const signature = await args.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await args.connection.confirmTransaction(signature, "confirmed");
    signatures.push(signature);
  }

  return signatures;
}
