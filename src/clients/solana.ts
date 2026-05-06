import { Decimal } from "decimal.js";
import type { TokenScale } from "../types.js";

type ParsedMintInfo = {
  decimals?: number;
  extensions?: {
    extension?: string;
    state?: {
      multiplier?: string;
      newMultiplier?: string;
      newMultiplierEffectiveTimestamp?: number | string;
    };
  }[];
};

export async function fetchTokenScale(rpcUrl: string, mint: string): Promise<TokenScale> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "xstock-arb-bot",
      method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Solana RPC ${response.status} ${response.statusText}: ${body}`);
  }

  const json = (await response.json()) as {
    error?: { message?: string };
    result?: { value?: { data?: { parsed?: { info?: ParsedMintInfo } } } };
  };

  if (json.error) {
    throw new Error(`Solana RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  const info = json.result?.value?.data?.parsed?.info;
  if (!info || typeof info.decimals !== "number") {
    throw new Error(`Could not read token decimals for ${mint}`);
  }

  return {
    decimals: info.decimals,
    uiMultiplier: getCurrentUiMultiplier(info)
  };
}

function getCurrentUiMultiplier(info: ParsedMintInfo): Decimal {
  const scaledUiExtension = info.extensions?.find((extension) => extension.extension === "scaledUiAmountConfig");
  const state = scaledUiExtension?.state;
  if (!state?.multiplier) return new Decimal(1);

  const currentMultiplier = new Decimal(state.multiplier);
  if (!state.newMultiplier || state.newMultiplierEffectiveTimestamp === undefined) {
    return currentMultiplier;
  }

  const effectiveTimestamp = Number(state.newMultiplierEffectiveTimestamp);
  if (!Number.isFinite(effectiveTimestamp)) return currentMultiplier;

  const nowSeconds = Date.now() / 1000;
  return nowSeconds >= effectiveTimestamp ? new Decimal(state.newMultiplier) : currentMultiplier;
}
