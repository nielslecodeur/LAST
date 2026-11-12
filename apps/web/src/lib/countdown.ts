/**
 * Chain-synced countdown (SPEC §2.4, §3). The contract reports `now_ns` (block timestamp of the
 * view) and `deadline_ns`. We sample the offset between chain time and the local clock when a view
 * returns, then tick locally. This is an ESTIMATE: only contract state decides expiry, so a local
 * 00:00 while the chain still says ACTIVE is shown as "CLOSING", never as "ended".
 *
 * Time values are not money; converting nanosecond deltas (< 2^53 ms) to Number is safe here.
 */

import type { GameStatus } from "./types";

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
