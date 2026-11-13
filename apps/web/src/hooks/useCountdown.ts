import { useEffect, useState } from "react";
import { type ChainClock, type DisplayPhase, displayPhase, estimateChainNowNs, remainingMs } from "../lib/countdown";
import type { GameState } from "../lib/types";

export interface Countdown {
  remaining: number;
  phase: DisplayPhase | null;
}

/** Ticks locally from the last chain clock sample; the contract status still decides the phase. */
export function useCountdown(game: GameState | null, clock: ChainClock | null): Countdown {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  if (!game || !clock) return { remaining: 0, phase: null };
  const rem = game.deadlineNs === null ? 0 : remainingMs(game.deadlineNs, estimateChainNowNs(clock, now));
  return { remaining: rem, phase: displayPhase(game.status, rem) };
}
