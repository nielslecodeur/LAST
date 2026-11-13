/**
 * Chain-synced countdown (SPEC §2.4, §3). The contract reports `now_ns` (block timestamp of the
 * view) and `deadline_ns`. We sample the offset between chain time and the local clock when a view
 * returns, then tick locally. This is an ESTIMATE: only contract state decides expiry, so a local
 * 00:00 while the chain still says ACTIVE is shown as "CLOSING", never as "ended".
 *
 * Time values are not money; converting nanosecond deltas (< 2^53 ms) to Number is safe here.
 */

/** Jackpot status as reported by the contract (`get_state.status`). */
type GameStatus = "IDLE" | "ACTIVE" | "EXPIRED";

export const NS_PER_MS = 1_000_000n;

export interface ChainClock {
  /** `now_ns` reported by the last successful `get_game_state`. */
  chainNowNs: bigint;
  /** Local `Date.now()` when that response arrived. */
  localAtMs: number;
}

export function estimateChainNowNs(clock: ChainClock, localNowMs: number): bigint {
  const elapsedMs = Math.max(0, Math.round(localNowMs - clock.localAtMs));
  return clock.chainNowNs + BigInt(elapsedMs) * NS_PER_MS;
}

/**
 * Clock sample from one `get_game_state` round trip. The block time is attributed to the
 * midpoint of the request (half the round-trip latency), not to its arrival.
 */
export function sampleClock(chainNowNs: bigint, sentAtMs: number, receivedAtMs: number): ChainClock {
  return { chainNowNs, localAtMs: sentAtMs + Math.max(0, receivedAtMs - sentAtMs) / 2 };
}

/** A sample implying chain time this far *behind* the running estimate means the local clock jumped. */
export const CLOCK_RESYNC_MS = 5_000;

/**
 * Merges a new sample into the running clock instead of overwriting it.
 *
 * Every sample UNDER-estimates chain time (final-block lag + network latency), never over-estimates
 * it, so the sample implying the latest chain time is the best one: keep it. Effect: the countdown
 * no longer jumps back up by a second when one poll is slower than the previous one.
 * Exception: if the new sample is more than CLOCK_RESYNC_MS behind the estimate, the local clock
 * was changed (system time adjusted) → resync to the new sample. Sleep/resume needs no special case:
 * local time and chain time both advanced, and the next poll refreshes the sample.
 */
export function mergeClock(prev: ChainClock | null, next: ChainClock, resyncMs = CLOCK_RESYNC_MS): ChainClock {
  if (!prev) return next;
  const predicted = estimateChainNowNs(prev, next.localAtMs);
  if (next.chainNowNs >= predicted) return next;
  if (predicted - next.chainNowNs > BigInt(resyncMs) * NS_PER_MS) return next;
  return prev;
}

/** Remaining milliseconds before `deadlineNs`, floored at 0. */
export function remainingMs(deadlineNs: bigint, chainNowNs: bigint): number {
  const diff = deadlineNs - chainNowNs;
  return diff <= 0n ? 0 : Number(diff / NS_PER_MS);
}

/** 125_400 → "02:05"; 3_600_000 → "1:00:00". Rounds *up* to the second so "00:00" means ≤ 0. */
export function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "120000000000" ns → "2 min"; 3600 s → "60 min"; 90 s → "90 s". */
export function formatDuration(ns: bigint): string {
  const sec = Number(ns / 1_000_000_000n);
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

export type DisplayPhase = "IDLE" | "ACTIVE" | "CLOSING" | "EXPIRED";

/**
 * What the hero shows. The contract status always wins; the local clock can only move ACTIVE to
 * CLOSING ("00:00, waiting for the chain"), never to EXPIRED.
 */
export function displayPhase(status: GameStatus, remaining: number): DisplayPhase {
  if (status === "IDLE") return "IDLE";
  if (status === "EXPIRED") return "EXPIRED";
  return remaining > 0 ? "ACTIVE" : "CLOSING";
}

/** Fraction of the round window left, 0..1 (for the progress bar). */
export function progressLeft(remaining: number, durationNs: bigint): number {
  const durMs = Number(durationNs / NS_PER_MS);
  if (durMs <= 0) return 0;
  return Math.min(1, Math.max(0, remaining / durMs));
}

/** Last N seconds are "danger" (urgent styling). */
export function isUrgent(remaining: number, durationNs: bigint): boolean {
  const durMs = Number(durationNs / NS_PER_MS);
  const threshold = Math.min(30_000, durMs / 4);
  return remaining > 0 && remaining <= threshold;
}
