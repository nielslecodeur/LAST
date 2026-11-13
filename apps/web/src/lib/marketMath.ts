/**
 * BigInt port of the contract's pure AMM math (`contracts/last/src/market.rs`: `calc_buy`,
 * `calc_sell`, `accounting::split_fee`). Used ONLY by the SIMULATED adapter and by tests that pin
 * our expectations to Builder A's test vectors. Live quotes always come from `quote_buy` /
 * `quote_sell` on the contract — this file never feeds a live screen.
 */

import { BPS } from "./amounts";

export const BUY_FEE_BPS = 400n;
export const SELL_FEE_BPS = 200n;
export const JACKPOT_SHARE = 7_000n;
export const NEXT_SEED_SHARE = 1_000n;
export const OPS_SHARE = 500n;

export function calcBuy(x: bigint, y: bigint, gross: bigint) {
  const fee = (gross * BUY_FEE_BPS) / BPS;
  const netNear = gross - fee;
  const denom = x + netNear;
  const tokensOut = denom === 0n ? 0n : (y * netNear) / denom;
  return { fee, netNear, tokensOut };
}

export function calcSell(x: bigint, y: bigint, tokensIn: bigint) {
  const denom = y + tokensIn;
  const grossNearOut = denom === 0n ? 0n : (x * tokensIn) / denom;
  const fee = (grossNearOut * SELL_FEE_BPS) / BPS;
  return { grossNearOut, fee, payout: grossNearOut - fee };
}

/** 70/10/15/5, remainder → treasury (conserves every yoctoNEAR). */
export function splitFee(fee: bigint) {
  const jackpot = (fee * JACKPOT_SHARE) / BPS;
  const nextSeed = (fee * NEXT_SEED_SHARE) / BPS;
  const ops = (fee * OPS_SHARE) / BPS;
  return { jackpot, nextSeed, ops, treasury: fee - jackpot - nextSeed - ops };
}
