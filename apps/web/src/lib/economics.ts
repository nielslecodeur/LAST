/**
 * Economic parameters shown in the UI, with where each one comes from.
 *
 * Read from the contract today (`get_market_state`): buy/sell fee bps, minimum eligible buy,
 * round duration. NOT readable on-chain in CONTRACT_API v0.2: the fee split (70/10/15/5). It is
 * shown from the documented V1 constants and labelled as such.
 *
 * "Crown Economy V2" (85/10/5, conditional carry-over, dynamic minimum) is a proposal, NOT
 * implemented: nothing here activates it. When Builder A exposes the split on-chain (proposed
 * `get_economics()` view, see BUILDER_B_HANDOFF.md), only `splitFromContract` needs wiring.
 */

import type { MarketState } from "./types";

export interface FeeSplitShare {
  /** Stable key, also used for i18n / tests. */
  bucket: "jackpot" | "next_seed" | "treasury" | "ops";
  label: string;
  bps: number;
}

export interface Economics {
  buyFeeBps: number;
  sellFeeBps: number;
  minEligibleBuy: bigint;
  roundDurationNs: bigint;
  split: FeeSplitShare[];
  /** "contract" = read on-chain; "documented-v1" = CONTRACT_API v0.2 constants (not readable on-chain). */
  splitSource: "contract" | "documented-v1";
  /** Model the UI is describing. Only "v1" exists today. */
  model: "v1";
}

/** CONTRACT_API v0.2 §0 — fixed at init, remainder → treasury. */
export const DOCUMENTED_V1_SPLIT: FeeSplitShare[] = [
  { bucket: "jackpot", label: "current jackpot", bps: 7_000 },
  { bucket: "next_seed", label: "next-round seed", bps: 1_000 },
  { bucket: "treasury", label: "treasury", bps: 1_500 },
  { bucket: "ops", label: "ops", bps: 500 },
];

export function economicsFromMarket(market: MarketState): Economics {
  return {
    buyFeeBps: market.buyFeeBps,
    sellFeeBps: market.sellFeeBps,
    minEligibleBuy: market.minEligibleBuy,
    roundDurationNs: market.roundDurationNs,
    split: DOCUMENTED_V1_SPLIT,
    splitSource: "documented-v1",
    model: "v1",
  };
}

/** "70% current jackpot · 10% next-round seed · …" */
export function describeSplit(split: FeeSplitShare[]): string {
  return split.map((s) => `${s.bps / 100}% ${s.label}`).join(" · ");
}

/** Sanity check: a split must cover exactly 100% of the fee. */
export function isCompleteSplit(split: FeeSplitShare[]): boolean {
  return split.reduce((sum, s) => sum + s.bps, 0) === 10_000;
}
