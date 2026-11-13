/**
 * Read-only client for the mainnet jackpot contract (`contracts/last-pot`).
 * Plain JSON-RPC `call_function` views with endpoint fallback. Amounts stay bigint.
 */
import { parseU128, parseU64 } from "../lib/amounts";

export type PotStatus = "IDLE" | "ACTIVE" | "EXPIRED";
export type PayoutStatus = "AVAILABLE" | "IN_FLIGHT" | "PAID";

export interface PotState {
  status: PotStatus;
  roundId: bigint;
  leader: string | null;
  startedAtNs: bigint | null;
  deadlineNs: bigint | null;
  settleAfterNs: bigint | null;
  eligibleBuys: number;
  lastTxHash: string | null;
  pot: bigint;
  prizeIfSettledNow: bigint;
  prizesOutstanding: bigint;
  inFlight: bigint;
  totalPaid: bigint;
  totalBuysRecorded: bigint;
  lastSettledRoundId: bigint | null;
  nowNs: bigint;
}

export interface PotConfig {
  ownerId: string;
  reporterId: string;
  tokenId: string | null;
  roundDurationNs: bigint;
  minEligibleBuy: bigint;
  winnerShareBps: number;
  settleGraceNs: bigint;
  reserveFloor: bigint;
}

export interface PotRound {
  roundId: bigint;
  winner: string;
  prize: bigint;
  startedAtNs: bigint;
  endedAtNs: bigint;
  eligibleBuys: number;
  winningTxHash: string;
  status: PayoutStatus;
}

export const DEFAULT_MAINNET_RPCS = ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"];

type Fetch = typeof fetch;

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export class PotReader {
  constructor(
    readonly contractId: string,
    private readonly rpcUrls: string[] = DEFAULT_MAINNET_RPCS,
    private readonly fetchImpl: Fetch = (...a) => fetch(...a),
  ) {}

  async view(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    let lastError: unknown = null;
    for (const url of this.rpcUrls) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "pot",
            method: "query",
            params: { request_type: "call_function", finality: "final", account_id: this.contractId, method_name: method, args_base64: b64(JSON.stringify(args)) },
          }),
        });
        const json = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
        if (json.error || !json.result?.result) throw new Error(JSON.stringify(json.error ?? "empty result").slice(0, 200));
        return JSON.parse(new TextDecoder().decode(new Uint8Array(json.result.result)));
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async state(): Promise<PotState> {
    return parseState(await this.view("get_state"));
  }

  async config(): Promise<PotConfig> {
    return parseConfig(await this.view("get_config"));
  }

  async round(id: bigint): Promise<PotRound | null> {
    const r = await this.view("get_round", { round_id: id.toString() });
    return r === null ? null : parseRound(r);
  }
}

const optU64 = (v: unknown, f: string) => (v === null || v === undefined ? null : parseU64(v, f));

export function parseState(raw: unknown): PotState {
  const o = raw as Record<string, unknown>;
  const status = o.status;
  if (status !== "IDLE" && status !== "ACTIVE" && status !== "EXPIRED") throw new Error(`bad status ${String(status)}`);
  return {
    status,
    roundId: parseU64(o.round_id, "round_id"),
    leader: (o.leader as string | null) ?? null,
    startedAtNs: optU64(o.started_at_ns, "started_at_ns"),
    deadlineNs: optU64(o.deadline_ns, "deadline_ns"),
    settleAfterNs: optU64(o.settle_after_ns, "settle_after_ns"),
    eligibleBuys: Number(o.eligible_buys ?? 0),
    lastTxHash: (o.last_tx_hash as string | null) ?? null,
    pot: parseU128(o.pot, "pot"),
    prizeIfSettledNow: parseU128(o.prize_if_settled_now, "prize_if_settled_now"),
    prizesOutstanding: parseU128(o.prizes_outstanding, "prizes_outstanding"),
    inFlight: parseU128(o.in_flight, "in_flight"),
    totalPaid: parseU128(o.total_paid, "total_paid"),
    totalBuysRecorded: parseU64(o.total_buys_recorded, "total_buys_recorded"),
    lastSettledRoundId: optU64(o.last_settled_round_id, "last_settled_round_id"),
    nowNs: parseU64(o.now_ns, "now_ns"),
  };
}

export function parseConfig(raw: unknown): PotConfig {
  const o = raw as Record<string, unknown>;
  return {
    ownerId: String(o.owner_id),
    reporterId: String(o.reporter_id),
    tokenId: (o.token_id as string | null) ?? null,
    roundDurationNs: parseU64(o.round_duration_ns, "round_duration_ns"),
    minEligibleBuy: parseU128(o.min_eligible_buy, "min_eligible_buy"),
    winnerShareBps: Number(o.winner_share_bps),
    settleGraceNs: parseU64(o.settle_grace_ns, "settle_grace_ns"),
    reserveFloor: parseU128(o.reserve_floor, "reserve_floor"),
  };
}

export function parseRound(raw: unknown): PotRound {
  const o = raw as Record<string, unknown>;
  const status = o.status;
  if (status !== "AVAILABLE" && status !== "IN_FLIGHT" && status !== "PAID") throw new Error(`bad payout status ${String(status)}`);
  return {
    roundId: parseU64(o.round_id, "round_id"),
    winner: String(o.winner),
    prize: parseU128(o.prize, "prize"),
    startedAtNs: parseU64(o.started_at_ns, "started_at_ns"),
    endedAtNs: parseU64(o.ended_at_ns, "ended_at_ns"),
    eligibleBuys: Number(o.eligible_buys ?? 0),
    winningTxHash: String(o.winning_tx_hash),
    status,
  };
}
