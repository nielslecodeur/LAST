/**
 * Contract types, mirroring docs/CONTRACT_API.md v0.2 and the Rust structs on feat/contracts.
 * `Raw*` = exact JSON on the wire (U128/U64 as decimal strings). Parsed types use `bigint`.
 * Parsers throw on any shape mismatch: a wrong field must surface as an error, not as a 0.
 */

import { parseU128, parseU64 } from "./amounts";

export type GameStatus = "IDLE" | "ACTIVE" | "EXPIRED";
export type ClaimStatus = "AVAILABLE" | "IN_FLIGHT" | "PAID";

// ---------- wire format ----------

export interface RawGameState {
  status: string;
  round_id: string;
  leader: string | null;
  started_at_ns: string | null;
  deadline_ns: string | null;
  active_pot: string;
  next_seed_pot: string;
  qualifying_buy_count: number;
  last_settled_round_id: string | null;
  now_ns: string;
}

export interface RawMarketState {
  near_reserve: string;
  last_inventory: string;
  total_buy_volume: string;
  total_sell_volume: string;
  buy_count: string;
  sell_count: string;
  treasury_reserve: string;
  ops_reserve: string;
  buy_fee_bps: number;
  sell_fee_bps: number;
  min_eligible_buy: string;
  round_duration_ns: string;
}

export interface RawAccountState {
  registered: boolean;
  last_balance: string;
  credit_available: string;
  credit_in_flight: string;
  claimable_rounds: string[];
}

export interface RawBuyQuote {
  tokens_out: string;
  fee: string;
  net_near: string;
  eligible: boolean;
}

export interface RawSellQuote {
  gross_near_out: string;
  fee: string;
  payout: string;
}

export interface RawRound {
  round_id: string;
  winner: string;
  prize: string;
  started_at_ns: string;
  ended_at_ns: string;
  qualifying_buy_count: number;
  claim_status: string;
}

export interface RawIntegrity {
  account_balance: string;
  storage_cost: string;
  total_obligations: string;
  market_near_reserve: string;
  active_pot: string;
  next_seed_pot: string;
  treasury_reserve: string;
  ops_reserve: string;
  credits_outstanding: string;
  prizes_outstanding: string;
  surplus: string;
}

export interface RawStorageBounds {
  min: string;
  max: string | null;
}

// ---------- parsed ----------

export interface GameState {
  status: GameStatus;
  roundId: bigint;
  leader: string | null;
  startedAtNs: bigint | null;
  deadlineNs: bigint | null;
  activePot: bigint;
  nextSeedPot: bigint;
  qualifyingBuyCount: number;
  lastSettledRoundId: bigint | null;
  nowNs: bigint;
}

export interface MarketState {
  nearReserve: bigint;
  lastInventory: bigint;
  totalBuyVolume: bigint;
  totalSellVolume: bigint;
  buyCount: bigint;
  sellCount: bigint;
  treasuryReserve: bigint;
  opsReserve: bigint;
  buyFeeBps: number;
  sellFeeBps: number;
  minEligibleBuy: bigint;
  roundDurationNs: bigint;
}

export interface AccountState {
  registered: boolean;
  lastBalance: bigint;
  creditAvailable: bigint;
  creditInFlight: bigint;
  claimableRounds: bigint[];
}

export interface BuyQuote {
  tokensOut: bigint;
  fee: bigint;
  netNear: bigint;
  eligible: boolean;
}

export interface SellQuote {
  grossNearOut: bigint;
  fee: bigint;
  payout: bigint;
}

export interface RoundView {
  roundId: bigint;
  winner: string;
  prize: bigint;
  startedAtNs: bigint;
  endedAtNs: bigint;
  qualifyingBuyCount: number;
  claimStatus: ClaimStatus;
}

export interface Integrity {
  accountBalance: bigint;
  storageCost: bigint;
  totalObligations: bigint;
  marketNearReserve: bigint;
  activePot: bigint;
  nextSeedPot: bigint;
  treasuryReserve: bigint;
  opsReserve: bigint;
  creditsOutstanding: bigint;
  prizesOutstanding: bigint;
  surplus: bigint;
}

export interface StorageBounds {
  min: bigint;
  max: bigint | null;
}

/** Which Gate 2 methods the deployed contract actually exports. */
export interface Capabilities {
  settleRound: boolean;
  claimReward: boolean;
  withdrawNearCredit: boolean;
  getRound: boolean;
  /** How it was determined. "unknown" = could not read the code: everything Gate 2 stays off. */
  source: "wasm-exports" | "simulated" | "unknown";
}

export const GATE2_METHODS = ["settle_round", "claim_reward", "withdraw_near_credit", "get_round"] as const;

export const NO_GATE2: Capabilities = {
  settleRound: false,
  claimReward: false,
  withdrawNearCredit: false,
  getRound: false,
  source: "unknown",
};

// ---------- parsers ----------

function obj(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${what}: expected an object`);
  }
  return raw as Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new TypeError(`${k}: expected a string`);
  return v;
}

function nullableStr(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new TypeError(`${k}: expected a string or null`);
  return v;
}

function int(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${k}: expected a non-negative integer`);
  }
  return v;
}

function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new TypeError(`${k}: expected a boolean`);
  return v;
}

const optU64 = (o: Record<string, unknown>, k: string) => {
  const v = nullableStr(o, k);
  return v === null ? null : parseU64(v, k);
};

export function parseGameState(raw: unknown): GameState {
  const o = obj(raw, "get_game_state");
  const status = str(o, "status");
  if (status !== "IDLE" && status !== "ACTIVE" && status !== "EXPIRED") {
    throw new TypeError(`status: unknown value ${JSON.stringify(status)}`);
  }
  const g: GameState = {
    status,
    roundId: parseU64(o.round_id, "round_id"),
    leader: nullableStr(o, "leader"),
    startedAtNs: optU64(o, "started_at_ns"),
    deadlineNs: optU64(o, "deadline_ns"),
    activePot: parseU128(o.active_pot, "active_pot"),
    nextSeedPot: parseU128(o.next_seed_pot, "next_seed_pot"),
    qualifyingBuyCount: int(o, "qualifying_buy_count"),
    lastSettledRoundId: optU64(o, "last_settled_round_id"),
    nowNs: parseU64(o.now_ns, "now_ns"),
  };
  if (status !== "IDLE" && (g.leader === null || g.deadlineNs === null)) {
    throw new TypeError(`${status} round without leader/deadline`);
  }
  return g;
}

export function parseMarketState(raw: unknown): MarketState {
  const o = obj(raw, "get_market_state");
  return {
    nearReserve: parseU128(o.near_reserve, "near_reserve"),
    lastInventory: parseU128(o.last_inventory, "last_inventory"),
    totalBuyVolume: parseU128(o.total_buy_volume, "total_buy_volume"),
    totalSellVolume: parseU128(o.total_sell_volume, "total_sell_volume"),
    buyCount: parseU64(o.buy_count, "buy_count"),
    sellCount: parseU64(o.sell_count, "sell_count"),
    treasuryReserve: parseU128(o.treasury_reserve, "treasury_reserve"),
    opsReserve: parseU128(o.ops_reserve, "ops_reserve"),
    buyFeeBps: int(o, "buy_fee_bps"),
    sellFeeBps: int(o, "sell_fee_bps"),
    minEligibleBuy: parseU128(o.min_eligible_buy, "min_eligible_buy"),
    roundDurationNs: parseU64(o.round_duration_ns, "round_duration_ns"),
  };
}

export function parseAccountState(raw: unknown): AccountState {
  const o = obj(raw, "get_account_state");
  const rounds = o.claimable_rounds;
  if (!Array.isArray(rounds)) throw new TypeError("claimable_rounds: expected an array");
  return {
    registered: bool(o, "registered"),
    lastBalance: parseU128(o.last_balance, "last_balance"),
    creditAvailable: parseU128(o.credit_available, "credit_available"),
    creditInFlight: parseU128(o.credit_in_flight, "credit_in_flight"),
    claimableRounds: rounds.map((r, i) => parseU64(r, `claimable_rounds[${i}]`)),
  };
}

export function parseBuyQuote(raw: unknown): BuyQuote {
  const o = obj(raw, "quote_buy");
  return {
    tokensOut: parseU128(o.tokens_out, "tokens_out"),
    fee: parseU128(o.fee, "fee"),
    netNear: parseU128(o.net_near, "net_near"),
    eligible: bool(o, "eligible"),
  };
}

export function parseSellQuote(raw: unknown): SellQuote {
  const o = obj(raw, "quote_sell");
  return {
    grossNearOut: parseU128(o.gross_near_out, "gross_near_out"),
    fee: parseU128(o.fee, "fee"),
    payout: parseU128(o.payout, "payout"),
  };
}

export function parseRound(raw: unknown): RoundView | null {
  if (raw === null) return null;
  const o = obj(raw, "get_round");
  const claimStatus = str(o, "claim_status");
  if (claimStatus !== "AVAILABLE" && claimStatus !== "IN_FLIGHT" && claimStatus !== "PAID") {
    throw new TypeError(`claim_status: unknown value ${JSON.stringify(claimStatus)}`);
  }
  return {
    roundId: parseU64(o.round_id, "round_id"),
    winner: str(o, "winner"),
    prize: parseU128(o.prize, "prize"),
    startedAtNs: parseU64(o.started_at_ns, "started_at_ns"),
    endedAtNs: parseU64(o.ended_at_ns, "ended_at_ns"),
    qualifyingBuyCount: int(o, "qualifying_buy_count"),
    claimStatus,
  };
}

export function parseIntegrity(raw: unknown): Integrity {
  const o = obj(raw, "get_integrity");
  const u = (k: string) => parseU128(o[k], k);
  return {
    accountBalance: u("account_balance"),
    storageCost: u("storage_cost"),
    totalObligations: u("total_obligations"),
    marketNearReserve: u("market_near_reserve"),
    activePot: u("active_pot"),
    nextSeedPot: u("next_seed_pot"),
    treasuryReserve: u("treasury_reserve"),
    opsReserve: u("ops_reserve"),
    creditsOutstanding: u("credits_outstanding"),
    prizesOutstanding: u("prizes_outstanding"),
    surplus: u("surplus"),
  };
}

export function parseStorageBounds(raw: unknown): StorageBounds {
  const o = obj(raw, "storage_balance_bounds");
  const max = o.max;
  return {
    min: parseU128(o.min, "min"),
    max: max === null || max === undefined ? null : parseU128(max, "max"),
  };
}
