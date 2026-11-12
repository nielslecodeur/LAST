/**
 * Central app state: deployment probe, polled contract views, chain clock, wallet session and the
 * transaction lifecycle. Components read it through `useLast()`.
 *
 * Rules enforced here:
 *  - On an RPC error we keep the last *real* values, flag them as stale and show the error.
 *    We never fall back to simulated data.
 *  - After a transaction we re-read the views before declaring it confirmed.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { type AppConfig } from "../config";
import type { ChainClock } from "../lib/countdown";
import { classifyError } from "../lib/errors";
import { recentRoundIds } from "../lib/game";
import type { LastReader } from "../lib/reader";
import { LiveLastReader } from "../lib/reader";
import { type TxRequest, interpretOutcome } from "../lib/transactions";
import { IDLE_TX, type TxState, isBusy, txReducer } from "../lib/txMachine";
import {
  type AccountState,
  type Capabilities,
  type GameState,
  type Integrity,
  type MarketState,
  NO_GATE2,
  type RoundView,
  type StorageBounds,
} from "../lib/types";
import type { LastWriter } from "../lib/wallet";

export type Deployment =
  | "not_configured" // no contract id → CONTRACT NOT DEPLOYED
  | "config_error"
  | "checking"
  | "deployed"
  | "no_account" // id configured but account missing → CONTRACT NOT DEPLOYED
  | "no_code" // account exists, no contract code → CONTRACT NOT DEPLOYED
  | "probe_failed"; // RPC down while probing

export interface SessionTx {
  id: number;
  kind: TxRequest["kind"];
  label: string;
  phase: TxState["phase"];
  hash: string | null;
  error: string | null;
  at: number;
}

export interface LastData {
  game: GameState | null;
  market: MarketState | null;
  account: AccountState | null;
  nearBalance: bigint | null;
  storage: StorageBounds | null;
  integrity: Integrity | null;
  rounds: Map<string, RoundView | null>;
  clock: ChainClock | null;
}

export interface LastContextValue extends LastData {
  config: AppConfig;
  reader: LastReader | null;
  deployment: Deployment;
  deployed: boolean;
  simulated: boolean;
  capabilities: Capabilities;
  rpcError: string | null;
  lastUpdatedMs: number | null;
  accountId: string | null;
  connecting: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  tx: TxState;
  run(tx: TxRequest): Promise<boolean>;
  resetTx(): void;
  sessionTxs: SessionTx[];
  refresh(): Promise<void>;
}

const Ctx = createContext<LastContextValue | null>(null);

export function useLast(): LastContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLast outside <LastProvider>");
  return v;
}

const EMPTY: LastData = {
  game: null,
  market: null,
  account: null,
  nearBalance: null,
  storage: null,
  integrity: null,
  rounds: new Map(),
  clock: null,
};

const POLL_MS = 3_000;

export function LastProvider(props: {
  config: AppConfig;
  reader: LastReader | null;
  writer: LastWriter | null;
  children: ReactNode;
  pollMs?: number;
}) {
  const { config, reader, writer } = props;
  const pollMs = props.pollMs ?? POLL_MS;
  const [deployment, setDeployment] = useState<Deployment>(() =>
    config.source === "config_error" ? "config_error" : reader ? "checking" : "not_configured",
  );
  const [capabilities, setCapabilities] = useState<Capabilities>(NO_GATE2);
  const [data, setData] = useState<LastData>(EMPTY);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [tx, dispatch] = useReducer(txReducer, IDLE_TX);
  const [sessionTxs, setSessionTxs] = useState<SessionTx[]>([]);
  const txSeq = useRef(0);
  const accountRef = useRef<string | null>(null);
  accountRef.current = accountId;

  const deployed = deployment === "deployed";

  // ---- deployment probe (also yields Gate 2 capabilities from the deployed WASM) ----
  useEffect(() => {
    if (!reader) return;
    let cancelled = false;
    (async () => {
      try {
        if (reader instanceof LiveLastReader) {
          const st = await reader.probeDeployment();
          if (cancelled) return;
          if (st.state === "deployed") {
            setCapabilities(st.capabilities);
            setDeployment("deployed");
          } else {
            setDeployment(st.state);
          }
        } else {
          const caps = await reader.getCapabilities();
          if (cancelled) return;
          setCapabilities(caps);
          setDeployment("deployed");
        }
      } catch (e) {
        if (cancelled) return;
        setDeployment("probe_failed");
        setRpcError(classifyError(e).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reader]);

  // ---- views ----
  const refresh = useCallback(async () => {
    if (!reader || deployment !== "deployed") return;
    const who = accountRef.current;
    try {
      const [game, market, integrity, storage] = await Promise.all([
        reader.getGameState(),
        reader.getMarketState(),
        reader.getIntegrity(),
        reader.getStorageBounds(),
      ]);
      const localAtMs = Date.now();
      const [account, nearBalance] = who
        ? await Promise.all([reader.getAccountState(who), reader.getNearBalance(who)])
        : [null, null];

      let rounds = new Map<string, RoundView | null>();
      if (capabilities.getRound) {
        const ids = new Set(recentRoundIds(game.lastSettledRoundId).map(String));
        account?.claimableRounds.forEach((r) => ids.add(r.toString()));
        const fetched = await Promise.all([...ids].map(async (id) => [id, await reader.getRound(BigInt(id))] as const));
        rounds = new Map(fetched);
      }

      setData({ game, market, integrity, storage, account, nearBalance, rounds, clock: { chainNowNs: game.nowNs, localAtMs } });
      setRpcError(null);
      setLastUpdatedMs(localAtMs);
    } catch (e) {
      // Keep the last real values (shown as stale) — never substitute simulated data.
      setRpcError(classifyError(e).message);
    }
  }, [reader, deployment, capabilities.getRound]);

  useEffect(() => {
    if (deployment !== "deployed") return;
    void refresh();
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
    }, pollMs);
    return () => clearInterval(t);
  }, [deployment, refresh, pollMs]);

  // Account switch → immediate re-read.
  useEffect(() => {
    if (deployed) void refresh();
  }, [accountId, deployed, refresh]);

  // ---- wallet ----
  useEffect(() => {
    if (!writer) return;
    let alive = true;
    void writer.getAccountId().then((id) => alive && setAccountId(id));
    const off = writer.onAccountChange((id) => setAccountId(id));
    return () => {
      alive = false;
      off();
    };
  }, [writer]);

  const connect = useCallback(async () => {
    if (!writer) return;
    setConnecting(true);
    try {
      setAccountId(await writer.connect());
    } catch (e) {
      const err = classifyError(e);
      if (err.kind !== "rejected") setRpcError(`Wallet: ${err.message}`);
    } finally {
      setConnecting(false);
    }
  }, [writer]);

  const disconnect = useCallback(async () => {
    if (!writer) return;
    await writer.disconnect().catch(() => undefined);
    setAccountId(null);
  }, [writer]);

  // ---- transactions ----
  const txRef = useRef(tx);
  txRef.current = tx;

  const run = useCallback(
    async (req: TxRequest): Promise<boolean> => {
      if (!writer || !deployed || isBusy(txRef.current)) return false;
      const id = ++txSeq.current;
      const log = (patch: Partial<SessionTx>) =>
        setSessionTxs((list) => {
          const existing = list.find((t) => t.id === id);
          if (!existing) {
            const entry: SessionTx = { id, kind: req.kind, label: req.label, phase: "signing", hash: null, error: null, at: Date.now(), ...patch };
            return [entry, ...list].slice(0, 20);
          }
          return list.map((t) => (t.id === id ? { ...t, ...patch } : t));
        });

      dispatch({ type: "SIGN", kind: req.kind, label: req.label });
      log({});
      try {
        const outcome = await writer.send(req);
        const res = interpretOutcome(outcome, req.kind);
        if (!res.ok) {
          const error = classifyError(res.code ?? res.message);
          dispatch({ type: "OUTCOME_FAILED", hash: res.hash, error });
          log({ phase: "failed", hash: res.hash, error: error.message });
          await refresh();
          return false;
        }
        dispatch({ type: "OUTCOME_OK", hash: res.hash });
        log({ phase: "pending", hash: res.hash });
        await refresh();
        dispatch({ type: "RECONCILED" });
        log({ phase: "confirmed" });
        return true;
      } catch (e) {
        const error = classifyError(e);
        dispatch({ type: "THROWN", error });
        log({ phase: error.kind === "rejected" ? "rejected" : "failed", error: error.message });
        return false;
      }
    },
    [writer, deployed, refresh],
  );

  const resetTx = useCallback(() => dispatch({ type: "RESET" }), []);

  const value = useMemo<LastContextValue>(
    () => ({
      ...data,
      config,
      reader,
      deployment,
      deployed,
      simulated: reader?.kind === "simulated",
      capabilities,
      rpcError,
      lastUpdatedMs,
      accountId,
      connecting,
      connect,
      disconnect,
      tx,
      run,
      resetTx,
      sessionTxs,
      refresh,
    }),
    [data, config, reader, deployment, deployed, capabilities, rpcError, lastUpdatedMs, accountId, connecting, connect, disconnect, tx, run, resetTx, sessionTxs, refresh],
  );

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}
