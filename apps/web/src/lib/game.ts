/** Pure game-state helpers used by the hero and the rounds panel. */

import type { AccountState, Capabilities, GameState, RoundView } from "./types";

export interface LeaderChange {
  previous: string | null;
  next: string;
  roundId: bigint;
}

/**
 * Detects a crown change between two *confirmed* contract reads. A new round starting (IDLE →
 * ACTIVE) counts as a change; a refresh with the same leader, a dust buy or a sell does not.
 */
export function detectLeaderChange(prev: GameState | null, next: GameState): LeaderChange | null {
  if (next.leader === null) return null;
  if (prev === null) return null; // first load is not a "change"
  const sameRound = prev.roundId === next.roundId;
  if (sameRound && prev.leader === next.leader) {
    // Same leader re-buying still resets the deadline: surface it as a change too.
    if (prev.deadlineNs !== null && next.deadlineNs !== null && next.deadlineNs > prev.deadlineNs) {
      return { previous: prev.leader, next: next.leader, roundId: next.roundId };
    }
    return null;
  }
  return { previous: sameRound ? prev.leader : null, next: next.leader, roundId: next.roundId };
}

/** Settle is offered only when the CONTRACT reports EXPIRED (never from the local clock). */
export function canSettle(game: GameState | null, caps: Capabilities): { allowed: boolean; reason: string | null } {
  if (!game || game.status !== "EXPIRED") return { allowed: false, reason: null };
  if (!caps.settleRound) return { allowed: false, reason: "settle_round is pending Gate 2 on the contract" };
  return { allowed: true, reason: null };
}

/** A prize is claimable when the contract lists it for the account and its status is AVAILABLE. */
export function claimableFor(
  account: AccountState | null,
  rounds: Map<string, RoundView | null>,
  accountId: string | null,
): RoundView[] {
  if (!account || !accountId) return [];
  return account.claimableRounds
    .map((id) => rounds.get(id.toString()) ?? null)
    .filter((r): r is RoundView => r !== null && r.winner === accountId && r.claimStatus !== "PAID");
}

/** Ids of the most recent settled rounds, newest first. */
export function recentRoundIds(lastSettled: bigint | null, max = 8): bigint[] {
  if (lastSettled === null || lastSettled < 1n) return [];
  const out: bigint[] = [];
  for (let id = lastSettled; id >= 1n && out.length < max; id--) out.push(id);
  return out;
}

export function shortAccount(id: string, max = 22): string {
  if (id.length <= max) return id;
  if (/^[0-9a-f]{64}$/.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  const keep = Math.floor((max - 1) / 2);
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}
