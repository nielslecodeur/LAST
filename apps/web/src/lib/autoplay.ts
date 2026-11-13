/**
 * Auto mode decisions (pure). With a session key on, the page settles and claims by itself:
 *  - the round's winner settles AND claims at once, as soon as the CONTRACT says EXPIRED;
 *  - anyone else settles after a grace period (so the winner usually does it, and two browsers
 *    rarely race; a lost race only fails with ERR_NO_ACTIVE_ROUND and costs a little gas);
 *  - any AVAILABLE prize of the connected account is claimed.
 * Each action is tried at most once per page session (`tried`), so a failure never loops.
 */

import type { ClaimableItem } from "./game";
import type { Capabilities, GameState } from "./types";

/** Non-winners wait this long after seeing EXPIRED (+ a per-browser jitter). */
export const AUTO_SETTLE_GRACE_MS = 20_000;
export const AUTO_SETTLE_JITTER_MS = 10_000;

export type AutoAction =
  | { key: string; type: "settle_claim"; roundId: bigint }
  | { key: string; type: "settle"; roundId: bigint }
  | { key: string; type: "claim"; roundId: bigint };

export function nextAutoAction(i: {
  me: string;
  game: GameState | null;
  caps: Capabilities;
  claimable: ClaimableItem[];
  /** Local time at which this page first read EXPIRED for the current round (null = not yet). */
  expiredSeenAtMs: number | null;
  nowMs: number;
  graceMs: number;
  tried: ReadonlySet<string>;
}): AutoAction | null {
  const g = i.game;
  if (g && g.status === "EXPIRED" && i.caps.settleRound) {
    const key = `settle:${g.roundId}`;
    if (!i.tried.has(key)) {
      if (g.leader === i.me && i.caps.claimReward && g.activePot > 0n) return { key, type: "settle_claim", roundId: g.roundId };
      if (i.expiredSeenAtMs !== null && i.nowMs - i.expiredSeenAtMs >= i.graceMs) return { key, type: "settle", roundId: g.roundId };
    }
  }
  if (i.caps.claimReward) {
    for (const c of i.claimable) {
      if (c.round !== null && c.round.claimStatus !== "AVAILABLE") continue; // IN_FLIGHT: never re-send
      const key = `claim:${c.roundId}`;
      if (!i.tried.has(key)) return { key, type: "claim", roundId: c.roundId };
    }
  }
  return null;
}
