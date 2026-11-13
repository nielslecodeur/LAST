/**
 * On-chain post-conditions. A transaction outcome is not enough: the UI says "confirmed" only once
 * a fresh read of contract state (finality `final`) shows the expected effect. Views lag the
 * wallet's outcome by ~1–2 blocks, so the caller retries a few times before giving up with an
 * honest "executed, not yet visible" state.
 *
 * Pure: compares the snapshot taken before signing with a fresh one.
 */

import type { TxKind } from "./transactions";
import type { AccountState, GameState, MarketState, RoundView } from "./types";

export interface ChainSnapshot {
  game: GameState | null;
  market: MarketState | null;
  account: AccountState | null;
  rounds: Map<string, RoundView | null>;
}

export interface TxMeta {
  roundId?: bigint;
}

export type Verdict =
  | { status: "confirmed" }
  /** Not visible yet (finality lag) or a payout still IN_FLIGHT. Never shown as success. */
  | { status: "wait"; note: string };

export function verifyOnChain(kind: TxKind, meta: TxMeta, before: ChainSnapshot, after: ChainSnapshot): Verdict {
  const lag = { status: "wait", note: "Executed — waiting for the change to reach final contract state." } as const;
  switch (kind) {
    case "buy":
      return after.market && before.market && after.market.buyCount > before.market.buyCount ? { status: "confirmed" } : lag;
    case "sell":
      return after.market && before.market && after.market.sellCount > before.market.sellCount ? { status: "confirmed" } : lag;
    case "register":
      return after.account?.registered ? { status: "confirmed" } : lag;
    case "deposit":
      return after.account && before.account && after.account.creditAvailable > before.account.creditAvailable ? { status: "confirmed" } : lag;
    case "session":
      // Key registration lives on the user account, not in contract state: the outcome is the proof
      // (the hook re-reads the key with view_access_key right after).
      return { status: "confirmed" };
    case "settle": {
      const id = meta.roundId;
      const settled = after.game?.lastSettledRoundId ?? null;
      return id !== undefined && settled !== null && settled >= id ? { status: "confirmed" } : lag;
    }
    case "claim": {
      const id = meta.roundId;
      if (id === undefined) return lag;
      const round = after.rounds.get(id.toString());
      if (round) {
        if (round.claimStatus === "PAID") return { status: "confirmed" };
        if (round.claimStatus === "IN_FLIGHT") {
          return { status: "wait", note: "Prize transfer is IN_FLIGHT — not final until the contract callback marks it PAID." };
        }
        return lag;
      }
      // Without get_round: the round leaving claimable_rounds is the confirmation.
      const listed = after.account?.claimableRounds.some((r) => r === id) ?? true;
      return listed ? lag : { status: "confirmed" };
    }
    case "withdraw": {
      const a = after.account;
      const b = before.account;
      if (!a || !b) return lag;
      if (a.creditInFlight > 0n) {
        return { status: "wait", note: "Withdrawal is IN_FLIGHT — not final until the contract callback confirms it." };
      }
      return a.creditAvailable < b.creditAvailable ? { status: "confirmed" } : lag;
    }
  }
}

export const VERIFY_ATTEMPTS = 6;
export const VERIFY_INTERVAL_MS = 1_500;
