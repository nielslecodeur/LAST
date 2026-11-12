/**
 * Central app state: deployment probe, polled contract views, chain clock, wallet session and the
 * transaction lifecycle. Components read it through `useLast()`.
 *
 * Rules enforced here:
 *  - On an RPC error we keep the last *real* values, flag them as stale and show the error.
 *    We never fall back to simulated data.
 *  - Responses are applied in request order: a slow old poll can never overwrite a newer read.
 *  - After a transaction we re-read the views until they show its effect before declaring it
 *    confirmed; payouts still IN_FLIGHT end as "unresolved", never as a success.
 *  - A wallet account that is not a testnet account cannot transact.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { type AppConfig, walletNetworkProblem } from "../config";
import { type ChainClock, mergeClock, sampleClock } from "../lib/countdown";
import { classifyError } from "../lib/errors";
import { recentRoundIds } from "../lib/game";
import { type PendingTxMarker, clearPending, markPending, takeInterrupted } from "../lib/pendingTx";
import type { LastReader } from "../lib/reader";
import { LiveLastReader } from "../lib/reader";
import { type TxRequest, describeResult, interpretOutcome } from "../lib/transactions";
import { IDLE_TX, type TxState, isBusy, txReducer } from "../lib/txMachine";
import { type ChainSnapshot, VERIFY_ATTEMPTS, VERIFY_INTERVAL_MS, verifyOnChain } from "../lib/txVerify";
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
  | "wrong_network" // RPC endpoint is not testnet → refused
  | "probe_failed"; // RPC down while probing

export interface SessionTx {
  id: number;
  kind: TxRequest["kind"];
  label: string;
  phase: TxState["phase"];
  hash: string | null;
  error: string | null;
  note: string | null;
  at: number;
}

export interface LastData {
  game: GameState | null;
  market: MarketState | null;
  account: AccountState | null;
  nearBalance: bigint | null;
  storage: StorageBounds | null;
  integrity: Integrity | null;
  gasPrice: bigint | null;
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
  /** Non-null when the connected wallet account is not usable on testnet. */
  walletError: string | null;
  connecting: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  tx: TxState;
  run(tx: TxRequest): Promise<boolean>;
  resetTx(): void;
  sessionTxs: SessionTx[];
  /** A transaction was waiting for the wallet when the page was last reloaded/closed. */
  interrupted: PendingTxMarker | null;
  dismissInterrupted(): void;
  refresh(): Promise<ChainSnapshot | null>;
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
  gasPrice: null,
  rounds: new Map(),
  clock: null,
};

const POLL_MS = 3_000;
/** Heavier, slow-moving views are refreshed every N polls (keeps the public RPC load low). */
const SLOW_EVERY = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function LastProvider(props: {
  config: AppConfig;
  reader: LastReader | null;
  writer: LastWriter | null;
  children: ReactNode;
  pollMs?: number;
  verifyIntervalMs?: number;
}) {
  const { config, reader, writer } = props;
  const pollMs = props.pollMs ?? POLL_MS;
  const verifyIntervalMs = props.verifyIntervalMs ?? VERIFY_INTERVAL_MS;
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
  const [interrupted, setInterrupted] = useState<PendingTxMarker | null>(() => takeInterrupted());
  const txSeq = useRef(0);
  const accountRef = useRef<string | null>(null);
  accountRef.current = accountId;
  const dataRef = useRef<LastData>(EMPTY);
  dataRef.current = data;

  // Request ordering + caches that do not need React state.
  const reqSeq = useRef(0);
  const appliedSeq = useRef(0);
  const pollCount = useRef(0);
  const paidRounds = useRef(new Map<string, RoundView>()); // PAID rounds never change again

  const deployed = deployment === "deployed";
  // Simulated accounts (`*.simulated`) are local fakes: the testnet account guard applies to live mode.
  const liveWallet = reader?.kind !== "simulated";
  const walletError = accountId && liveWallet ? walletNetworkProblem(accountId) : null;

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
            if (st.state === "wrong_network") setRpcError(`RPC endpoint reports chain "${st.chainId}", not testnet.`);
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
  const refresh = useCallback(async (): Promise<ChainSnapshot | null> => {
    if (!reader || deployment !== "deployed") return null;
    const seq = ++reqSeq.current;
    const who = accountRef.current;
    const prev = dataRef.current;
    const slow = pollCount.current++ % SLOW_EVERY === 0 || prev.integrity === null;
    try {
      const sentAt = Date.now();
      const game = await reader.getGameState();
      const receivedAt = Date.now();
      const [market, account, nearBalance, integrity, storage, gasPrice] = await Promise.all([
        reader.getMarketState(),
        who ? reader.getAccountState(who) : Promise.resolve(null),
        who ? reader.getNearBalance(who) : Promise.resolve(null),
        slow ? reader.getIntegrity() : Promise.resolve(prev.integrity),
        prev.storage ? Promise.resolve(prev.storage) : reader.getStorageBounds(), // fixed at deploy
        slow || prev.gasPrice === null ? reader.getGasPrice().catch(() => prev.gasPrice) : Promise.resolve(prev.gasPrice),
      ]);

      let rounds = new Map<string, RoundView | null>();
      if (capabilities.getRound) {
        const ids = new Set(recentRoundIds(game.lastSettledRoundId).map(String));
        account?.claimableRounds.forEach((r) => ids.add(r.toString()));
        const fetched = await Promise.all(
          [...ids].map(async (id) => {
            const cached = paidRounds.current.get(id);
            if (cached) return [id, cached] as const;
            const r = await reader.getRound(BigInt(id));
            if (r?.claimStatus === "PAID") paidRounds.current.set(id, r);
            return [id, r] as const;
          }),
        );
        rounds = new Map(fetched);
      }

      // A newer request already landed: drop this stale response.
      if (seq < appliedSeq.current) return null;
      appliedSeq.current = seq;

      const snapshot: LastData = {
        game,
        market,
        integrity,
        storage,
        gasPrice,
        account: who === accountRef.current ? account : null,
        nearBalance: who === accountRef.current ? nearBalance : null,
        rounds,
        clock: mergeClock(prev.clock, sampleClock(game.nowNs, sentAt, receivedAt)),
      };
      dataRef.current = snapshot;
      setData(snapshot);
      setRpcError(null);
      setLastUpdatedMs(receivedAt);
      return snapshot;
    } catch (e) {
      // Keep the last real values (shown as stale) — never substitute simulated data.
      if (seq >= appliedSeq.current) setRpcError(classifyError(e).message);
      return null;
    }
  }, [reader, deployment, capabilities.getRound]);

  useEffect(() => {
    if (deployment !== "deployed") return;
    void refresh();
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
    }, pollMs);
    // Resync immediately after sleep / tab switch / network recovery instead of waiting a tick.
    const wake = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
    };
  }, [deployment, refresh, pollMs]);

  // Account switch → drop the previous account's data, then re-read.
  useEffect(() => {
    setData((d) => ({ ...d, account: null, nearBalance: null }));
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
      if (liveWallet && accountRef.current && walletNetworkProblem(accountRef.current)) return false;
      const id = ++txSeq.current;
      const log = (patch: Partial<SessionTx>) =>
        setSessionTxs((list) => {
          if (!list.some((t) => t.id === id)) {
            const entry: SessionTx = { id, kind: req.kind, label: req.label, phase: "signing", hash: null, error: null, note: null, at: Date.now(), ...patch };
            return [entry, ...list].slice(0, 20);
          }
          return list.map((t) => (t.id === id ? { ...t, ...patch } : t));
        });

      const before: ChainSnapshot = dataRef.current;
      dispatch({ type: "SIGN", kind: req.kind, label: req.label });
      log({});
      markPending({ label: req.label, accountId: accountRef.current, at: Date.now() });
      try {
        const outcome = await writer.send(req);
        clearPending();
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

        // Confirmed only when fresh contract state shows the effect.
        let verdict: ReturnType<typeof verifyOnChain> = { status: "wait", note: "Not verified yet." };
        for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
          const fresh = await refresh();
          if (fresh) {
            verdict = verifyOnChain(req.kind, req.meta ?? {}, before, fresh);
            if (verdict.status === "confirmed") break;
          }
          if (i < VERIFY_ATTEMPTS - 1) await sleep(verifyIntervalMs);
        }
        if (verdict.status === "confirmed") {
          const note = describeResult(req.kind, res.value);
          dispatch({ type: "RECONCILED", note });
          log({ phase: "confirmed", note });
          return true;
        }
        dispatch({ type: "UNRESOLVED", note: verdict.note });
        log({ phase: "unresolved", note: verdict.note });
        return false;
      } catch (e) {
        clearPending();
        const error = classifyError(e);
        dispatch({ type: "THROWN", error });
        log({ phase: error.kind === "rejected" ? "rejected" : "failed", error: error.message });
        return false;
      }
    },
    [writer, deployed, refresh, verifyIntervalMs, liveWallet],
  );

  const resetTx = useCallback(() => dispatch({ type: "RESET" }), []);
  const dismissInterrupted = useCallback(() => setInterrupted(null), []);

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
      walletError,
      connecting,
      connect,
      disconnect,
      tx,
      run,
      resetTx,
      sessionTxs,
      interrupted,
      dismissInterrupted,
      refresh,
    }),
    [data, config, reader, deployment, deployed, capabilities, rpcError, lastUpdatedMs, accountId, walletError, connecting, connect, disconnect, tx, run, resetTx, sessionTxs, interrupted, dismissInterrupted, refresh],
  );

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}
