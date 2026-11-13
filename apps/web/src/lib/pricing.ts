/**
 * Display-only trade analytics derived from REAL contract quotes and reserves (never invented):
 * price impact and NEAR network gas bounds. All bigint.
 */

import { ATOMS_PER_LAST, BPS } from "./amounts";
import { spotPriceYoctoPerLast } from "./amounts";

/**
 * Price impact of a buy, in bps: how many fewer LAST you get than the marginal spot price would
 * give for the *net* NEAR (fee excluded, so the 4% fee is not double-counted).
 * expected = net × 10^18 / spot; impact = (expected − out) / expected.
 */
export function buyPriceImpactBps(nearReserve: bigint, lastInventory: bigint, netNear: bigint, tokensOut: bigint): bigint {
  const spot = spotPriceYoctoPerLast(nearReserve, lastInventory);
  if (spot === 0n || netNear === 0n) return 0n;
  const expected = (netNear * ATOMS_PER_LAST) / spot;
  if (expected === 0n || tokensOut >= expected) return 0n;
  return ((expected - tokensOut) * BPS) / expected;
}

/** Same for a sell: gross NEAR out vs `tokens_in × spot`. */
export function sellPriceImpactBps(nearReserve: bigint, lastInventory: bigint, tokensIn: bigint, grossNearOut: bigint): bigint {
  const spot = spotPriceYoctoPerLast(nearReserve, lastInventory);
  if (spot === 0n || tokensIn === 0n) return 0n;
  const expected = (tokensIn * spot) / ATOMS_PER_LAST;
  if (expected === 0n || grossNearOut >= expected) return 0n;
  return ((expected - grossNearOut) * BPS) / expected;
}

export const HIGH_IMPACT_BPS = 500n; // 5%: warn

/**
 * Upper bound of the NEAR network fee for a transaction: attached gas × gas price. Unused gas is
 * refunded by the protocol, so the real cost is lower. This is NOT a LAST fee.
 */
export function maxGasCost(totalGas: bigint, gasPriceYocto: bigint): bigint {
  return totalGas * gasPriceYocto;
}
