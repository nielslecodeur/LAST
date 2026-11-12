/**
 * SIMULATED adapter — local UI development only (`pnpm dev:mock`). Never reachable from a
 * production build (see config.ts), and every screen shows a SIMULATED badge while it runs.
 *
 * It replays the contract rules in memory (same integer math as market.rs, same ERR_* codes, same
 * outcome format) so the UI exercises the exact live code paths. Nothing here is real data.
 */

import { ATOMS_PER_LAST, YOCTO_PER_NEAR } from "./amounts";
import { calcBuy, calcSell, splitFee } from "./marketMath";
import type { LastReader } from "./reader";
import { toBase64 } from "./rpc";
import type { ExecutionOutcomeLike, TxRequest } from "./transactions";
import type {
  AccountState,
  Capabilities,
  ClaimStatus,
  GameState,
  Integrity,
  MarketState,
  RoundView,
  StorageBounds,
} from "./types";
import type { LastWriter } from "./wallet";

export const SIM_CONTRACT = "last.simulated";
export const SIM_USER = "you.simulated";
const RIVALS = ["degen.simulated", "whale.simulated", "sniper.simulated"];

interface SimRound {
  leader: string;
  startedAtNs: bigint;
  deadlineNs: bigint;
  count: number;
}

interface SimSettled extends RoundView {}

class PanicError extends Error {}
const panic = (code: string): never => {
  throw new PanicError(code);
};

export interface SimOptions {
  gate2?: boolean;
  bots?: boolean;
  durationNs?: bigint;
  now?: () => bigint;
}

export class SimulatedChain implements LastReader, LastWriter {
  readonly kind = "simulated" as const;
  readonly contractId = SIM_CONTRACT;

  x = 3n * YOCTO_PER_NEAR;
  y = 1_000_000n * ATOMS_PER_LAST;
  activePot = 0n;
  nextSeedPot = 0n;
  treasury = 0n;
  ops = 0n;
  roundId = 1n;
  round: SimRound | null = null;
  lastSettled: bigint | null = null;
  settled = new Map<string, SimSettled>();
  balances = new Map<string, bigint>();
  near = new Map<string, bigint>([[SIM_USER, 10n * YOCTO_PER_NEAR]]);
  credits = new Map<string, { available: bigint; inFlight: bigint }>();
  totals = { buyVolume: 0n, sellVolume: 0n, buyCount: 0n, sellCount: 0n };
  readonly minEligible = 3n * 10n ** 22n; // 0.03 NEAR
  readonly storageMin = 125n * 10n ** 19n; // 0.00125 NEAR (simulated)
  readonly durationNs: bigint;
  readonly gate2: boolean;
  private connected: string | null = null;
  private listeners = new Set<(id: string | null) => void>();
  private readonly now: () => bigint;

  constructor(opts: SimOptions = {}) {
    this.gate2 = opts.gate2 ?? false;
    this.durationNs = opts.durationNs ?? 120n * 1_000_000_000n;
    this.now = opts.now ?? (() => BigInt(Date.now()) * 1_000_000n);
    if (opts.bots) this.startBots();
  }

  // ---------------- reader ----------------

  private status(now = this.now()) {
    if (!this.round) return "IDLE" as const;
    return now >= this.round.deadlineNs ? ("EXPIRED" as const) : ("ACTIVE" as const);
  }

  async getGameState(): Promise<GameState> {
    const now = this.now();
    return {
      status: this.status(now),
      roundId: this.roundId,
      leader: this.round?.leader ?? null,
      startedAtNs: this.round?.startedAtNs ?? null,
      deadlineNs: this.round?.deadlineNs ?? null,
      activePot: this.activePot,
      nextSeedPot: this.nextSeedPot,
      qualifyingBuyCount: this.round?.count ?? 0,
      lastSettledRoundId: this.lastSettled,
      nowNs: now,
    };
  }

  async getMarketState(): Promise<MarketState> {
    return {
      nearReserve: this.x,
      lastInventory: this.y,
      totalBuyVolume: this.totals.buyVolume,
      totalSellVolume: this.totals.sellVolume,
      buyCount: this.totals.buyCount,
      sellCount: this.totals.sellCount,
      treasuryReserve: this.treasury,
      opsReserve: this.ops,
      buyFeeBps: 400,
      sellFeeBps: 200,
      minEligibleBuy: this.minEligible,
      roundDurationNs: this.durationNs,
    };
  }

  async getAccountState(id: string): Promise<AccountState> {
    const c = this.credits.get(id) ?? { available: 0n, inFlight: 0n };
    const claimable = this.gate2
      ? [...this.settled.values()].filter((r) => r.winner === id && r.claimStatus !== "PAID").map((r) => r.roundId)
      : [];
    return {
      registered: this.balances.has(id),
      lastBalance: this.balances.get(id) ?? 0n,
      creditAvailable: c.available,
      creditInFlight: c.inFlight,
      claimableRounds: claimable,
    };
  }

  async getIntegrity(): Promise<Integrity> {
    const credits = [...this.credits.values()].reduce((s, c) => s + c.available + c.inFlight, 0n);
    const prizes = [...this.settled.values()].filter((r) => r.claimStatus !== "PAID").reduce((s, r) => s + r.prize, 0n);
    const total = this.x + this.activePot + this.nextSeedPot + this.treasury + this.ops + credits + prizes;
    const storage = 5n * YOCTO_PER_NEAR;
    return {
      accountBalance: total + storage,
      storageCost: storage,
      totalObligations: total,
      marketNearReserve: this.x,
      activePot: this.activePot,
      nextSeedPot: this.nextSeedPot,
      treasuryReserve: this.treasury,
      opsReserve: this.ops,
      creditsOutstanding: credits,
      prizesOutstanding: prizes,
      surplus: 0n,
    };
  }

  async quoteBuy(gross: bigint) {
    const q = calcBuy(this.x, this.y, gross);
    return { ...q, eligible: gross >= this.minEligible };
  }

  async quoteSell(tokensIn: bigint) {
    return calcSell(this.x, this.y, tokensIn);
  }

  async getStorageBounds(): Promise<StorageBounds> {
    return { min: this.storageMin, max: this.storageMin };
  }

  async getNearBalance(id: string) {
    return this.near.get(id) ?? 0n;
  }

  async getRound(id: bigint): Promise<RoundView | null> {
    if (!this.gate2) panic("MethodNotFound");
    return this.settled.get(id.toString()) ?? null;
  }

  async getCapabilities(): Promise<Capabilities> {
    const g = this.gate2;
    return { settleRound: g, claimReward: g, withdrawNearCredit: g, getRound: g, source: "simulated" };
  }

  // ---------------- writer ----------------

  async getAccountId() {
    return this.connected;
  }
  async connect() {
    this.connected = SIM_USER;
    this.listeners.forEach((l) => l(SIM_USER));
    return SIM_USER;
  }
  async disconnect() {
    this.connected = null;
    this.listeners.forEach((l) => l(null));
  }
  onAccountChange(cb: (id: string | null) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async send(tx: TxRequest): Promise<ExecutionOutcomeLike> {
    const signer = this.connected ?? panic("Not signed in");
    await new Promise((r) => setTimeout(r, 700)); // simulated wallet + block latency
    const hash = `SIMULATED-${Math.random().toString(36).slice(2, 10)}`;
    const snapshot = this.snapshot();
    try {
      let value: unknown = null;
      for (const a of tx.actions) {
        const deposit = BigInt(a.params.deposit);
        const bal = this.near.get(signer) ?? 0n;
        if (bal < deposit) panic("NotEnoughBalance");
        this.near.set(signer, bal - deposit);
        value = this.exec(signer, a.params.methodName, a.params.args, deposit);
      }
      const b64 = toBase64(new TextEncoder().encode(JSON.stringify(value)));
      return { status: { SuccessValue: b64 }, transaction: { hash }, receipts_outcome: [] };
    } catch (e) {
      this.restore(snapshot); // a panicking transaction reverts everything (refunds deposits)
      const msg = e instanceof Error ? e.message : String(e);
      return {
        status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } },
        transaction: { hash },
        receipts_outcome: [],
      };
    }
  }

  private exec(who: string, method: string, args: Record<string, unknown>, deposit: bigint): unknown {
    switch (method) {
      case "storage_deposit":
        if (!this.balances.has(who)) this.balances.set(who, 0n);
        else this.near.set(who, (this.near.get(who) ?? 0n) + deposit);
        return { total: this.storageMin.toString(), available: "0" };
      case "buy":
        return this.buy(who, deposit, BigInt(String(args.min_tokens_out)));
      case "sell":
        if (deposit !== 1n) panic("ERR_ONE_YOCTO");
        return this.sell(who, BigInt(String(args.tokens_in)), BigInt(String(args.min_near_out)));
      case "withdraw_near_credit":
        return this.withdraw(who, deposit);
      case "settle_round":
        return this.settle(who);
      case "claim_reward":
        return this.claim(who, BigInt(String(args.round_id)));
      default:
        return panic("MethodNotFound");
    }
  }

  private allocate(fee: bigint, active: boolean) {
    const s = splitFee(fee);
    if (active) {
      this.activePot += s.jackpot;
      this.nextSeedPot += s.nextSeed;
    } else {
      this.nextSeedPot += s.jackpot + s.nextSeed;
    }
    this.treasury += s.treasury;
    this.ops += s.ops;
  }

  buy(who: string, gross: bigint, minOut: bigint) {
    const now = this.now();
    if (gross === 0n) panic("ERR_ZERO_DEPOSIT");
    if (!this.balances.has(who)) panic("ERR_NOT_REGISTERED");
    const status = this.status(now);
    if (status === "EXPIRED") panic("ERR_ROUND_EXPIRED");
    const q = calcBuy(this.x, this.y, gross);
    if (q.tokensOut === 0n) panic("ERR_ZERO_OUTPUT");
    if (q.tokensOut < minOut) panic("ERR_SLIPPAGE");
    if (q.tokensOut >= this.y) panic("ERR_INSUFFICIENT_LIQUIDITY");
    const eligible = gross >= this.minEligible;
    if (eligible && status === "IDLE") {
      this.activePot += this.nextSeedPot;
      this.nextSeedPot = 0n;
      this.round = { leader: who, startedAtNs: now, deadlineNs: now + this.durationNs, count: 0 };
    }
    this.allocate(q.fee, this.round !== null);
    if (eligible && this.round) {
      this.round.leader = who;
      this.round.deadlineNs = now + this.durationNs;
      this.round.count += 1;
    }
    this.x += q.netNear;
    this.y -= q.tokensOut;
    this.balances.set(who, (this.balances.get(who) ?? 0n) + q.tokensOut);
    this.totals.buyVolume += gross;
    this.totals.buyCount += 1n;
    return {
      tokens_out: q.tokensOut.toString(),
      fee: q.fee.toString(),
      eligible,
      round_id: this.roundId.toString(),
      leader: this.round?.leader ?? null,
      deadline_ns: this.round?.deadlineNs.toString() ?? null,
    };
  }

  private sell(who: string, tokensIn: bigint, minOut: bigint) {
    if (tokensIn === 0n) panic("ERR_ZERO_AMOUNT");
    if (!this.balances.has(who)) panic("ERR_NOT_REGISTERED");
    if ((this.balances.get(who) ?? 0n) < tokensIn) panic("ERR_INSUFFICIENT_BALANCE");
    if (this.status() === "EXPIRED") panic("ERR_ROUND_EXPIRED");
    const q = calcSell(this.x, this.y, tokensIn);
    if (q.payout === 0n) panic("ERR_ZERO_OUTPUT");
    if (q.payout < minOut) panic("ERR_SLIPPAGE");
    if (q.grossNearOut >= this.x) panic("ERR_INSUFFICIENT_LIQUIDITY");
    this.x -= q.grossNearOut;
    this.y += tokensIn;
    this.balances.set(who, (this.balances.get(who) ?? 0n) - tokensIn);
    this.allocate(q.fee, this.round !== null);
    const c = this.credits.get(who) ?? { available: 0n, inFlight: 0n };
    c.available += q.payout;
    this.credits.set(who, c);
    this.totals.sellVolume += q.grossNearOut;
    this.totals.sellCount += 1n;
    return {
      gross_near_out: q.grossNearOut.toString(),
      fee: q.fee.toString(),
      payout: q.payout.toString(),
      credit_available: c.available.toString(),
    };
  }

  private withdraw(who: string, deposit: bigint) {
    if (!this.gate2) panic("MethodNotFound");
    if (deposit !== 1n) panic("ERR_ONE_YOCTO");
    const c = this.credits.get(who);
    if (!c || c.available === 0n) return panic("ERR_NO_CREDIT");
    if (c.inFlight > 0n) panic("ERR_WITHDRAW_IN_FLIGHT");
    const amount = c.available;
    c.available = 0n;
    this.near.set(who, (this.near.get(who) ?? 0n) + amount);
    return { amount: amount.toString(), success: true };
  }

  private settle(who: string) {
    if (!this.gate2) panic("MethodNotFound");
    if (!this.round) return panic("ERR_NO_ACTIVE_ROUND");
    const now = this.now();
    if (now < this.round.deadlineNs) panic("ERR_NOT_EXPIRED");
    const r: SimSettled = {
      roundId: this.roundId,
      winner: this.round.leader,
      prize: this.activePot,
      startedAtNs: this.round.startedAtNs,
      endedAtNs: this.round.deadlineNs,
      qualifyingBuyCount: this.round.count,
      claimStatus: (this.activePot > 0n ? "AVAILABLE" : "PAID") as ClaimStatus,
    };
    void who;
    this.settled.set(r.roundId.toString(), r);
    this.lastSettled = r.roundId;
    this.activePot = 0n;
    this.round = null;
    this.roundId += 1n;
    return {
      round_id: r.roundId.toString(),
      winner: r.winner,
      prize: r.prize.toString(),
      started_at_ns: r.startedAtNs.toString(),
      ended_at_ns: r.endedAtNs.toString(),
      qualifying_buy_count: r.qualifyingBuyCount,
      claim_status: r.claimStatus,
    };
  }

  private claim(who: string, roundId: bigint) {
    if (!this.gate2) panic("MethodNotFound");
    const r = this.settled.get(roundId.toString()) ?? panic("ERR_UNKNOWN_ROUND");
    if (r.winner !== who) panic("ERR_NOT_WINNER");
    if (r.claimStatus === "PAID") panic("ERR_ALREADY_PAID");
    if (r.claimStatus === "IN_FLIGHT") panic("ERR_CLAIM_IN_FLIGHT");
    if (r.prize === 0n) panic("ERR_EMPTY_PRIZE");
    r.claimStatus = "PAID";
    this.near.set(who, (this.near.get(who) ?? 0n) + r.prize);
    return { round_id: roundId.toString(), amount: r.prize.toString(), success: true };
  }

  // ---------------- simulated rivals ----------------

  private startBots() {
    const tick = () => {
      const delay = 15_000 + Math.random() * 40_000;
      setTimeout(() => {
        const rival = RIVALS[Math.floor(Math.random() * RIVALS.length)]!;
        if (!this.balances.has(rival)) this.balances.set(rival, 0n);
        this.near.set(rival, 100n * YOCTO_PER_NEAR);
        const st = this.status();
        if (st !== "EXPIRED") {
          // Mostly eligible buys; sometimes dust that must NOT take the crown.
          const gross = Math.random() < 0.25 ? 10n ** 22n : 3n * 10n ** 22n + BigInt(Math.floor(Math.random() * 20)) * 10n ** 22n;
          try {
            this.buy(rival, gross, 0n);
          } catch {
            /* ignore */
          }
        } else if (this.gate2 && Math.random() < 0.5) {
          try {
            this.settle(rival);
          } catch {
            /* ignore */
          }
        }
        tick();
      }, delay);
    };
    tick();
  }

  // ---------------- revert support ----------------

  private snapshot() {
    return JSON.stringify(
      {
        x: this.x,
        y: this.y,
        activePot: this.activePot,
        nextSeedPot: this.nextSeedPot,
        treasury: this.treasury,
        ops: this.ops,
        roundId: this.roundId,
        round: this.round,
        lastSettled: this.lastSettled,
        settled: [...this.settled],
        balances: [...this.balances],
        near: [...this.near],
        credits: [...this.credits],
        totals: this.totals,
      },
      (_k, v) => (typeof v === "bigint" ? `${v}n` : v),
    );
  }

  private restore(json: string) {
    const s = JSON.parse(json, (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
    Object.assign(this, {
      x: s.x,
      y: s.y,
      activePot: s.activePot,
      nextSeedPot: s.nextSeedPot,
      treasury: s.treasury,
      ops: s.ops,
      roundId: s.roundId,
      round: s.round,
      lastSettled: s.lastSettled,
      settled: new Map(s.settled),
      balances: new Map(s.balances),
      near: new Map(s.near),
      credits: new Map(s.credits),
      totals: s.totals,
    });
  }
}
