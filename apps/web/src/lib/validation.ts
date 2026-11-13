/**
 * Pre-signature checks. They only *prevent* obviously failing transactions; the contract remains
 * the authority (it re-checks everything and panics with ERR_* codes).
 */

import { formatNear } from "./amounts";
import type { AccountState, BuyQuote, GameStatus, SellQuote, StorageBounds } from "./types";

/** NEAR kept aside for gas when checking that a buy is affordable (≈ 60 Tgas at testnet prices, rounded up). */
export const GAS_RESERVE_YOCTO = 10n ** 22n; // 0.01 NEAR

/** Instant (no-popup) buys above 5× the minimum or with ≥ 5% price impact need a second tap. */
export const SECOND_TAP_MIN_MULTIPLE = 5n;
export const SECOND_TAP_IMPACT_BPS = 500n;
export function needsSecondTap(gross: bigint, minEligibleBuy: bigint | null, impactBps: bigint | null): boolean {
  if (minEligibleBuy !== null && gross > minEligibleBuy * SECOND_TAP_MIN_MULTIPLE) return true;
  return impactBps !== null && impactBps >= SECOND_TAP_IMPACT_BPS;
}

export type Blocker =
  | "NOT_DEPLOYED"
  | "NO_WALLET"
  | "LOADING"
  | "ROUND_EXPIRED"
  | "NO_AMOUNT"
  | "ZERO_OUTPUT"
  | "INSUFFICIENT_NEAR"
  | "INSUFFICIENT_LAST"
  | "NOT_REGISTERED";

export const BLOCKER_TEXT: Record<Blocker, string> = {
  NOT_DEPLOYED: "Contract not deployed",
  NO_WALLET: "Connect wallet",
  LOADING: "Loading…",
  ROUND_EXPIRED: "Round over — settle first",
  NO_AMOUNT: "Enter an amount",
  ZERO_OUTPUT: "Amount too small",
  INSUFFICIENT_NEAR: "Insufficient NEAR",
  INSUFFICIENT_LAST: "Insufficient LAST",
  NOT_REGISTERED: "Not registered — buy first",
};

export interface BuyCheckInput {
  deployed: boolean;
  accountId: string | null;
  status: GameStatus | null;
  gross: bigint | null;
  quote: BuyQuote | null;
  nearBalance: bigint | null;
  account: AccountState | null;
  storage: StorageBounds | null;
  minEligibleBuy: bigint | null;
}

export interface BuyCheck {
  blocker: Blocker | null;
  /** Deposit to prepend as `storage_deposit` (null when already registered). */
  storageDeposit: bigint | null;
  /** Total NEAR leaving the wallet (gross + storage), excluding gas. */
  totalCost: bigint;
  /** Eligible amounts take the crown and reset the timer. */
  eligible: boolean;
  warnings: string[];
}

export function checkBuy(i: BuyCheckInput): BuyCheck {
  const warnings: string[] = [];
  const needsStorage = i.account !== null && !i.account.registered;
  const storageDeposit = needsStorage && i.storage ? i.storage.min : null;
  const gross = i.gross ?? 0n;
  const totalCost = gross + (storageDeposit ?? 0n);
  const eligible = i.minEligibleBuy !== null && gross >= i.minEligibleBuy;

  const done = (blocker: Blocker | null): BuyCheck => ({ blocker, storageDeposit, totalCost, eligible, warnings });

  if (!i.deployed) return done("NOT_DEPLOYED");
  if (!i.accountId) return done("NO_WALLET");
  if (i.status === null || i.account === null || i.minEligibleBuy === null) return done("LOADING");
  if (needsStorage && !i.storage) return done("LOADING");
  if (i.status === "EXPIRED") return done("ROUND_EXPIRED");
  if (i.gross === null || i.gross <= 0n) return done("NO_AMOUNT");
  if (i.quote === null) return done("LOADING");
  if (i.quote.tokensOut === 0n) return done("ZERO_OUTPUT");

  if (!eligible) {
    warnings.push(
      `Below the ${formatNear(i.minEligibleBuy)} NEAR minimum: you get LAST, but you will NOT take the crown or reset the timer.`,
    );
  }
  if (storageDeposit !== null) {
    warnings.push(`First buy: includes a one-time ${formatNear(storageDeposit, 6)} NEAR storage registration.`);
  }
  if (i.nearBalance !== null && totalCost + GAS_RESERVE_YOCTO > i.nearBalance) return done("INSUFFICIENT_NEAR");
  return done(null);
}

export interface SellCheckInput {
  deployed: boolean;
  accountId: string | null;
  status: GameStatus | null;
  tokensIn: bigint | null;
  quote: SellQuote | null;
  account: AccountState | null;
}

export function checkSell(i: SellCheckInput): Blocker | null {
  if (!i.deployed) return "NOT_DEPLOYED";
  if (!i.accountId) return "NO_WALLET";
  if (i.status === null || i.account === null) return "LOADING";
  if (!i.account.registered) return "NOT_REGISTERED";
  if (i.status === "EXPIRED") return "ROUND_EXPIRED";
  if (i.tokensIn === null || i.tokensIn <= 0n) return "NO_AMOUNT";
  if (i.tokensIn > i.account.lastBalance) return "INSUFFICIENT_LAST";
  if (i.quote === null) return "LOADING";
  if (i.quote.payout === 0n) return "ZERO_OUTPUT";
  return null;
}
