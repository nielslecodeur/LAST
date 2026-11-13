import { useEffect, useMemo, useRef, useState } from "react";
import { estimateChainNowNs, mergeClock, remainingMs, sampleClock, type ChainClock } from "../lib/countdown";
import { PotReader, type PotConfig, type PotRound, type PotState } from "./potReader";

const POLL_MS = 5_000;
const MAX_ROUNDS = 8;

export interface PotView {
  state: PotState | null;
  config: PotConfig | null;
  rounds: PotRound[];
  error: string | null;
  /** Estimated ms left before the on-chain deadline (0 when idle or passed). */
  remaining: number;
  updatedAtMs: number | null;
}

/** Polls the jackpot contract; the countdown ticks locally from the chain clock between polls. */
export function usePot(reader: PotReader): PotView {
  const [state, setState] = useState<PotState | null>(null);
  const [config, setConfig] = useState<PotConfig | null>(null);
  const [rounds, setRounds] = useState<PotRound[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAtMs, setUpdatedAtMs] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const clock = useRef<ChainClock | null>(null);
  const paid = useRef(new Map<string, PotRound>());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const sent = Date.now();
        const [s, c] = await Promise.all([reader.state(), config ? Promise.resolve(config) : reader.config()]);
        if (!alive) return;
        clock.current = mergeClock(clock.current, sampleClock(s.nowNs, sent, Date.now()));
        setState(s);
        if (!config) setConfig(c);
        // Recent settled rounds; PAID ones never change, so they are cached.
        if (s.lastSettledRoundId !== null) {
          const ids: bigint[] = [];
          for (let id = s.lastSettledRoundId; id >= 1n && ids.length < MAX_ROUNDS; id--) ids.push(id);
          const list = await Promise.all(
            ids.map(async (id) => paid.current.get(id.toString()) ?? (await reader.round(id))),
          );
          if (!alive) return;
          const found = list.filter((r): r is PotRound => r !== null);
          for (const r of found) if (r.status === "PAID") paid.current.set(r.roundId.toString(), r);
          setRounds(found);
        }
        setError(null);
        setUpdatedAtMs(Date.now());
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, []);

  const remaining = useMemo(() => {
    if (!state?.deadlineNs || !clock.current || state.status === "IDLE") return 0;
    return remainingMs(state.deadlineNs, estimateChainNowNs(clock.current, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, tick]);

  return { state, config, rounds, error, remaining, updatedAtMs };
}
