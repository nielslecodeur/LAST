// UNIT (no network). Phase 2: clock merging, economics source, price impact & gas, on-chain
// verification of transactions, unresolved payouts, claimable fallback, network guard, demo flag,
// interrupted-transaction marker.
import { afterEach, describe, expect, it } from "vitest";
import { isDemoMode, walletNetworkProblem } from "../config";
import { NS_PER_MS, estimateChainNowNs, mergeClock, remainingMs, sampleClock } from "./countdown";
import { DOCUMENTED_V1_SPLIT, describeSplit, economicsFromMarket, isCompleteSplit } from "./economics";
import { claimableFor, detectSettlement, paidWinsOf } from "./game";
import { clearPending, markPending, takeInterrupted } from "./pendingTx";
import { buyPriceImpactBps, maxGasCost, sellPriceImpactBps } from "./pricing";
import { GAS, buildBuyTx, describeResult, totalGas } from "./transactions";
import { IDLE_TX, txReducer } from "./txMachine";
import { type ChainSnapshot, verifyOnChain } from "./txVerify";
import type { AccountState, GameState, MarketState, RoundView } from "./types";

const NEAR = 10n ** 24n;
const LAST = 10n ** 18n;
const S = 1_000_000_000n;

// ---------------------------------------------------------------- clock

describe("chain clock sampling & merging", () => {
  it("attributes the block time to the request midpoint (half RTT)", () => {
    expect(sampleClock(10n * S, 1_000, 1_400)).toEqual({ chainNowNs: 10n * S, localAtMs: 1_200 });
    expect(sampleClock(10n * S, 1_000, 900).localAtMs).toBe(1_000); // clock skew guard
  });

  it("a slower poll never makes the countdown jump back up", () => {
    const a = { chainNowNs: 100n * S, localAtMs: 0 };
    // 3 s later a laggier sample implies chain time 102.2 s instead of 103 s → keep `a`.
    const b = { chainNowNs: 102n * S + 200n * 1_000_000n, localAtMs: 3_000 };
    expect(mergeClock(a, b)).toBe(a);
    const deadline = 200n * S;
    const r1 = remainingMs(deadline, estimateChainNowNs(mergeClock(a, b), 3_000));
    expect(r1).toBe(97_000);
  });

  it("a fresher sample is adopted", () => {
    const a = { chainNowNs: 100n * S, localAtMs: 0 };
    const b = { chainNowNs: 104n * S, localAtMs: 3_000 };
    expect(mergeClock(a, b)).toBe(b);
  });

  it("resyncs when the local clock was moved (system time change)", () => {
    const a = { chainNowNs: 100n * S, localAtMs: 0 };
    // local clock jumped +60 s: predicted chain = 160 s but the chain says 101 s
    const b = { chainNowNs: 101n * S, localAtMs: 60_000 };
    expect(mergeClock(a, b)).toBe(b);
  });

  it("sleep/resume: local and chain time advanced together, estimate stays consistent", () => {
    const a = { chainNowNs: 100n * S, localAtMs: 0 };
    const afterSleep = estimateChainNowNs(a, 600_000); // 10 min asleep
    expect(afterSleep).toBe(700n * S);
    expect(remainingMs(220n * S, afterSleep)).toBe(0); // round over by then → phase from contract
    expect(NS_PER_MS).toBe(1_000_000n);
  });

  it("the first sample is taken as is", () => {
    const b = { chainNowNs: 1n, localAtMs: 1 };
    expect(mergeClock(null, b)).toBe(b);
  });
});

// ---------------------------------------------------------------- economics & pricing

const market = (p: Partial<MarketState> = {}): MarketState => ({
  nearReserve: 3n * NEAR,
  lastInventory: 1_000_000n * LAST,
  totalBuyVolume: 0n,
  totalSellVolume: 0n,
  buyCount: 0n,
  sellCount: 0n,
  treasuryReserve: 0n,
  opsReserve: 0n,
  buyFeeBps: 400,
  sellFeeBps: 200,
  minEligibleBuy: 3n * 10n ** 22n,
  roundDurationNs: 120n * S,
  ...p,
});

describe("economics — read from contract where the API allows, V1 only", () => {
  it("fees, minimum and duration come from get_market_state", () => {
    const e = economicsFromMarket(market({ buyFeeBps: 350, minEligibleBuy: 5n * 10n ** 22n, roundDurationNs: 3_600n * S }));
    expect(e.buyFeeBps).toBe(350);
    expect(e.minEligibleBuy).toBe(5n * 10n ** 22n);
    expect(e.roundDurationNs).toBe(3_600n * S);
  });

  it("the split is the documented V1 70/10/15/5, labelled as such — never Crown Economy V2", () => {
    const e = economicsFromMarket(market());
    expect(e.model).toBe("v1");
    expect(e.splitSource).toBe("documented-v1");
    expect(e.split.map((s) => s.bps)).toEqual([7000, 1000, 1500, 500]);
    expect(isCompleteSplit(DOCUMENTED_V1_SPLIT)).toBe(true);
    expect(describeSplit(e.split)).toBe("70% current jackpot · 10% next-round seed · 15% treasury · 5% ops");
    expect(describeSplit(e.split)).not.toMatch(/85%/);
  });
});

describe("price impact & network gas", () => {
  it("0.03 NEAR into the 3 NEAR demo pool ≈ 0.95% impact (fee excluded)", () => {
    const net = 288n * 10n ** 20n; // 0.0288 NEAR after the 4% fee
    const out = (1_000_000n * LAST * net) / (3n * NEAR + net);
    const bps = buyPriceImpactBps(3n * NEAR, 1_000_000n * LAST, net, out);
    expect(bps >= 94n && bps <= 96n).toBe(true);
  });

  it("1 NEAR into the thin pool has a large impact (> 20%)", () => {
    const net = 96n * 10n ** 22n;
    const out = (1_000_000n * LAST * net) / (3n * NEAR + net);
    expect(buyPriceImpactBps(3n * NEAR, 1_000_000n * LAST, net, out) > 2_000n).toBe(true);
  });

  it("sell impact and degenerate inputs", () => {
    const tokensIn = 100_000n * LAST;
    const gross = (3n * NEAR * tokensIn) / (1_000_000n * LAST + tokensIn);
    const bps = sellPriceImpactBps(3n * NEAR, 1_000_000n * LAST, tokensIn, gross);
    expect(bps >= 900n && bps <= 910n).toBe(true); // ≈ 9.09%
    expect(buyPriceImpactBps(0n, 0n, 1n, 1n)).toBe(0n);
    expect(sellPriceImpactBps(1n, 1n, 0n, 0n)).toBe(0n);
  });

  it("max NEAR network fee = attached gas × gas price (separate from the LAST fee)", () => {
    const tx = buildBuyTx({ contractId: "c", grossYocto: NEAR, minTokensOut: 1n, storageDeposit: 10n ** 21n, label: "" });
    expect(totalGas(tx)).toBe(GAS.storageDeposit + GAS.buy);
    expect(maxGasCost(totalGas(tx), 100_000_000n)).toBe(6n * 10n ** 21n); // 0.006 NEAR upper bound
  });
});

// ---------------------------------------------------------------- verification

const game = (p: Partial<GameState> = {}): GameState => ({
  status: "ACTIVE",
  roundId: 1n,
  leader: "a.testnet",
  startedAtNs: 0n,
  deadlineNs: 120n * S,
  activePot: 0n,
  nextSeedPot: 0n,
  qualifyingBuyCount: 1,
  lastSettledRoundId: null,
  nowNs: 0n,
  ...p,
});
const acct = (p: Partial<AccountState> = {}): AccountState => ({
  registered: true,
  lastBalance: 0n,
  creditAvailable: 0n,
  creditInFlight: 0n,
  claimableRounds: [],
  ...p,
});
const round = (p: Partial<RoundView> = {}): RoundView => ({
  roundId: 1n,
  winner: "b.testnet",
  prize: NEAR,
  startedAtNs: 0n,
  endedAtNs: 1n,
  qualifyingBuyCount: 3,
  claimStatus: "AVAILABLE",
  ...p,
});
const snap = (p: Partial<ChainSnapshot> = {}): ChainSnapshot => ({ game: game(), market: market(), account: acct(), rounds: new Map(), ...p });

describe("a transaction is confirmed only when fresh contract state shows its effect", () => {
  it("buy / sell: counters must move (finality lag → wait)", () => {
    const before = snap();
    expect(verifyOnChain("buy", {}, before, snap()).status).toBe("wait");
    expect(verifyOnChain("buy", {}, before, snap({ market: market({ buyCount: 1n }) })).status).toBe("confirmed");
    expect(verifyOnChain("sell", {}, before, snap({ market: market({ sellCount: 1n }) })).status).toBe("confirmed");
  });

  it("settle: last_settled_round_id must reach the round", () => {
    const after = snap({ game: game({ status: "IDLE", roundId: 2n, lastSettledRoundId: 1n }) });
    expect(verifyOnChain("settle", { roundId: 1n }, snap(), after).status).toBe("confirmed");
    expect(verifyOnChain("settle", { roundId: 1n }, snap(), snap()).status).toBe("wait");
  });

  it("claim: PAID confirms; IN_FLIGHT is never a success", () => {
    const paid = snap({ rounds: new Map([["1", round({ claimStatus: "PAID" })]]) });
    const inflight = snap({ rounds: new Map([["1", round({ claimStatus: "IN_FLIGHT" })]]) });
    expect(verifyOnChain("claim", { roundId: 1n }, snap(), paid).status).toBe("confirmed");
    const v = verifyOnChain("claim", { roundId: 1n }, snap(), inflight);
    expect(v.status).toBe("wait");
    expect(v.status === "wait" && v.note).toMatch(/IN_FLIGHT/);
  });

  it("claim without get_round: leaving claimable_rounds confirms", () => {
    const before = snap({ account: acct({ claimableRounds: [1n] }) });
    expect(verifyOnChain("claim", { roundId: 1n }, before, before).status).toBe("wait");
    expect(verifyOnChain("claim", { roundId: 1n }, before, snap({ account: acct({ claimableRounds: [] }) })).status).toBe("confirmed");
  });

  it("withdraw: in-flight credit is not a success; a reduced credit is", () => {
    const before = snap({ account: acct({ creditAvailable: 5n }) });
    expect(verifyOnChain("withdraw", {}, before, snap({ account: acct({ creditInFlight: 5n }) })).status).toBe("wait");
    expect(verifyOnChain("withdraw", {}, before, snap({ account: acct() })).status).toBe("confirmed");
  });

  it("tx machine: pending → unresolved keeps the note and frees the UI", () => {
    let s = txReducer(IDLE_TX, { type: "SIGN", kind: "claim", label: "c" });
    s = txReducer(s, { type: "OUTCOME_OK", hash: "H" });
    s = txReducer(s, { type: "UNRESOLVED", note: "IN_FLIGHT" });
    expect(s.phase).toBe("unresolved");
    expect(s.note).toBe("IN_FLIGHT");
    expect(txReducer(s, { type: "RESET" }).phase).toBe("idle");
  });

  it("describes what a buy actually did (crown vs tokens only)", () => {
    expect(describeResult("buy", { eligible: true })).toMatch(/took the crown/);
    expect(describeResult("buy", { eligible: false })).toMatch(/crown and timer unchanged/);
    expect(describeResult("sell", {})).toMatch(/withdrawable NEAR credit/);
  });
});

// ---------------------------------------------------------------- rewards

describe("rewards lists", () => {
  it("empty claimable_rounds is a normal empty state", () => {
    expect(claimableFor(acct(), new Map(), "b.testnet")).toEqual([]);
    expect(claimableFor(null, new Map(), "b.testnet")).toEqual([]);
  });

  it("without get_round, claimable ids are still listed (no details)", () => {
    expect(claimableFor(acct({ claimableRounds: [4n] }), new Map(), "b.testnet")).toEqual([{ roundId: 4n, round: null }]);
  });

  it("PAID or other-winner rounds are not claimable; PAID wins are listed for the double-claim demo", () => {
    const rounds = new Map([
      ["1", round({ claimStatus: "PAID" })],
      ["2", round({ roundId: 2n, winner: "x.testnet" })],
      ["3", round({ roundId: 3n })],
    ]);
    const items = claimableFor(acct({ claimableRounds: [1n, 2n, 3n] }), rounds, "b.testnet");
    expect(items.map((i) => i.roundId)).toEqual([3n]);
    expect(paidWinsOf(rounds, "b.testnet").map((r) => r.roundId)).toEqual([1n]);
  });

  it("detects a settlement between two confirmed reads", () => {
    expect(detectSettlement(game(), game({ status: "IDLE", lastSettledRoundId: 1n }))).toBe(1n);
    expect(detectSettlement(game({ lastSettledRoundId: 1n }), game({ lastSettledRoundId: 1n }))).toBeNull();
    expect(detectSettlement(null, game({ lastSettledRoundId: 1n }))).toBeNull();
  });
});

// ---------------------------------------------------------------- wallet / demo / reload

describe("wallet network guard, demo flag, interrupted transactions", () => {
  afterEach(() => clearPending());

  it("rejects mainnet wallet accounts, accepts testnet / implicit / eth-implicit", () => {
    expect(walletNetworkProblem("alice.near")).toMatch(/not a NEAR Testnet account/);
    expect(walletNetworkProblem("alice.testnet")).toBeNull();
    expect(walletNetworkProblem("f".repeat(64))).toBeNull();
    expect(walletNetworkProblem(`0x${"a".repeat(40)}`)).toBeNull();
  });

  it("demo mode only with ?demo=1", () => {
    expect(isDemoMode("?demo=1")).toBe(true);
    expect(isDemoMode("?demo=0")).toBe(false);
    expect(isDemoMode("")).toBe(false);
  });

  it("a transaction interrupted by a reload is reported once, stale markers are ignored", () => {
    markPending({ label: "Buy", accountId: "a.testnet", at: 1_000 });
    expect(takeInterrupted(2_000)).toEqual({ label: "Buy", accountId: "a.testnet", at: 1_000 });
    expect(takeInterrupted(2_000)).toBeNull(); // consumed
    markPending({ label: "Old", accountId: null, at: 0 });
    expect(takeInterrupted(3_600_001)).toBeNull();
  });
});

// ---------------------------------------------------------------- API v0.3 (Gate 2 merge)

import { isSolvent, parseIntegrity } from "./types";

describe("CONTRACT_API v0.3 integrity (in_flight)", () => {
  const raw = {
    account_balance: "100",
    storage_cost: "10",
    total_obligations: "95",
    market_near_reserve: "50",
    active_pot: "0",
    next_seed_pot: "0",
    treasury_reserve: "0",
    ops_reserve: "0",
    credits_outstanding: "20",
    prizes_outstanding: "25",
    in_flight: "5",
    surplus: "0",
  };

  it("parses in_flight and applies balance + in_flight >= storage + obligations", () => {
    const i = parseIntegrity(raw);
    expect(i.inFlight).toBe(5n);
    // 100 + 5 >= 10 + 95 → covered, although balance alone (100) < 105
    expect(isSolvent(i)).toBe(true);
    expect(isSolvent({ ...i, inFlight: 0n })).toBe(false);
  });

  it("a v0.2-shaped integrity (no in_flight) is rejected, not read as 0", () => {
    const { in_flight: _drop, ...v02 } = raw;
    void _drop;
    expect(() => parseIntegrity(v02)).toThrow(/in_flight/);
  });
});
