import { readFile } from "node:fs/promises";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { Decimal } from "decimal.js";
import { toRawTokenUnits } from "../src/math.js";
import type { TokenScale } from "../src/types.js";

export type TokenProgramId = typeof TOKEN_PROGRAM_ID | typeof TOKEN_2022_PROGRAM_ID;

export async function loadSolanaKeypair(args: {
  keypairPath?: string;
  privateKeyBase58?: string;
}): Promise<Keypair> {
  if (args.privateKeyBase58) {
    return Keypair.fromSecretKey(bs58.decode(args.privateKeyBase58));
  }

  if (!args.keypairPath) {
    throw new Error("Missing SOLANA_KEYPAIR_PATH or SOLANA_PRIVATE_KEY_BASE58");
  }

  const raw = await readFile(args.keypairPath, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(secret);
}

export async function getMintProgramId(connection: Connection, mint: PublicKey): Promise<TokenProgramId> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  throw new Error(`Unsupported mint owner for ${mint.toBase58()}: ${info.owner.toBase58()}`);
}

export function getAta(mint: PublicKey, owner: PublicKey, tokenProgramId: TokenProgramId): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export async function getUiTokenBalance(connection: Connection, tokenAccount: PublicKey): Promise<Decimal> {
  const balance = await connection.getTokenAccountBalance(tokenAccount, "confirmed");
  return new Decimal(balance.value.uiAmountString ?? "0");
}

export async function ensureAta(args: {
  connection: Connection;
  payer: Keypair;
  mint: PublicKey;
  owner: PublicKey;
  tokenProgramId: TokenProgramId;
  dryRun: boolean;
}): Promise<PublicKey> {
  const ata = getAta(args.mint, args.owner, args.tokenProgramId);
  const existing = await args.connection.getAccountInfo(ata, "confirmed");
  if (existing || args.dryRun) return ata;

  const instruction = createAssociatedTokenAccountIdempotentInstruction(
    args.payer.publicKey,
    ata,
    args.owner,
    args.mint,
    args.tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const { blockhash } = await args.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: args.payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction]
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([args.payer]);
  const signature = await args.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await args.connection.confirmTransaction(signature, "confirmed");
  return ata;
}

export async function transferToken(args: {
  connection: Connection;
  payer: Keypair;
  mint: PublicKey;
  sourceOwner: PublicKey;
  destinationOwner: PublicKey;
  amountUi: Decimal;
  scale: TokenScale;
  tokenProgramId: TokenProgramId;
  dryRun: boolean;
}): Promise<{ sourceAta: string; destinationAta: string; signature?: string }> {
  const sourceAta = await ensureAta({
    connection: args.connection,
    payer: args.payer,
    mint: args.mint,
    owner: args.sourceOwner,
    tokenProgramId: args.tokenProgramId,
    dryRun: args.dryRun
  });
  const destinationAta = await resolveDestinationTokenAccount({
    connection: args.connection,
    payer: args.payer,
    mint: args.mint,
    destination: args.destinationOwner,
    tokenProgramId: args.tokenProgramId,
    dryRun: args.dryRun
  });

  const rawAmount = toRawTokenUnits(args.amountUi, args.scale);
  if (args.dryRun) {
    return { sourceAta: sourceAta.toBase58(), destinationAta: destinationAta.toBase58() };
  }

  const instruction = createTransferCheckedInstruction(
    sourceAta,
    args.mint,
    destinationAta,
    args.sourceOwner,
    rawAmount,
    args.scale.decimals,
    [],
    args.tokenProgramId
  );
  const { blockhash } = await args.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: args.payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction]
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([args.payer]);
  const signature = await args.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await args.connection.confirmTransaction(signature, "confirmed");

  return {
    sourceAta: sourceAta.toBase58(),
    destinationAta: destinationAta.toBase58(),
    signature
  };
}

async function resolveDestinationTokenAccount(args: {
  connection: Connection;
  payer: Keypair;
  mint: PublicKey;
  destination: PublicKey;
  tokenProgramId: TokenProgramId;
  dryRun: boolean;
}): Promise<PublicKey> {
  const parsed = await args.connection.getParsedAccountInfo(args.destination, "confirmed");
  const data = parsed.value?.data;
  if (data && typeof data === "object" && "parsed" in data) {
    const info = (data.parsed as { info?: { mint?: string } }).info;
    if (info?.mint === args.mint.toBase58()) {
      return args.destination;
    }
  }

  return ensureAta({
    connection: args.connection,
    payer: args.payer,
    mint: args.mint,
    owner: args.destination,
    tokenProgramId: args.tokenProgramId,
    dryRun: args.dryRun
  });
}
