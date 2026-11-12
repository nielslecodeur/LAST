import { BPS, parseUnits } from "./amounts";

export const DEFAULT_SLIPPAGE_BPS = 100n; // 1%
export const MAX_SLIPPAGE_BPS = 5_000n; // 50%: anything above is almost surely a typo
export const SLIPPAGE_PRESETS_BPS = [50n, 100n, 200n] as const;

/** Minimum acceptable output: `floor(quote * (10000 - bps) / 10000)`. */
export function applySlippage(quoted: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new RangeError("Slippage out of range");
  }
  return (quoted * (BPS - slippageBps)) / BPS;
}

/** "0.5" (%) → 50n bps. Returns null when invalid or out of range. */
export function parseSlippagePercent(input: string): bigint | null {
  try {
    const bps = parseUnits(input, 2);
    return bps <= MAX_SLIPPAGE_BPS ? bps : null;
  } catch {
    return null;
  }
}
