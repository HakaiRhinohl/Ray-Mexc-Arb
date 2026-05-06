import { Decimal } from "decimal.js";
import type { TokenScale } from "./types.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const BPS_DENOMINATOR = new Decimal(10_000);

export function bpsMultiplier(bps: number): Decimal {
  return new Decimal(1).minus(new Decimal(bps).div(BPS_DENOMINATOR));
}

export function toBaseUnits(amount: Decimal, decimals: number): bigint {
  const scaled = amount.mul(new Decimal(10).pow(decimals)).floor();
  return BigInt(scaled.toFixed(0));
}

export function fromBaseUnits(amount: bigint, decimals: number): Decimal {
  return new Decimal(amount.toString()).div(new Decimal(10).pow(decimals));
}

export function toRawTokenUnits(uiAmount: Decimal, scale: TokenScale): bigint {
  const rawAmount = uiAmount.div(scale.uiMultiplier);
  return toBaseUnits(rawAmount, scale.decimals);
}

export function fromRawTokenUnits(rawAmount: bigint, scale: TokenScale): Decimal {
  return fromBaseUnits(rawAmount, scale.decimals).mul(scale.uiMultiplier);
}

export function floorDecimal(value: Decimal, decimalPlaces: number): Decimal {
  const scale = new Decimal(10).pow(decimalPlaces);
  return value.mul(scale).floor().div(scale);
}

export function formatDecimal(value: Decimal, dp = 6): string {
  return value.toFixed(dp);
}
