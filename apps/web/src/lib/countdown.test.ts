// UNIT (no network). Countdown sync, phases (IDLE / ACTIVE / CLOSING / EXPIRED) and leader changes.
import { describe, expect, it } from "vitest";
import {
  displayPhase,
  estimateChainNowNs,
  formatCountdown,
  formatDuration,
  isUrgent,
  progressLeft,
  remainingMs,
} from "./countdown";
import { canSettle, detectLeaderChange, recentRoundIds, shortAccount } from "./game";
import { type GameState, NO_GATE2 } from "./types";

const S = 1_000_000_000n; // ns per second
const DUR = 120n * S;

function game(p: Partial<GameState>): GameState {
  return {
    status: "ACTIVE",
    roundId: 1n,
    leader: "alice.testnet",
    startedAtNs: 1_000n * S,
    deadlineNs: 1_120n * S,
    activePot: 0n,
    nextSeedPot: 0n,
    qualifyingBuyCount: 1,
    lastSettledRoundId: null,
    nowNs: 1_000n * S,
    ...p,
  };
}

describe("chain-synced countdown", () => {
  it("advances chain time by local elapsed time", () => {
    const clock = { chainNowNs: 1_000n * S, localAtMs: 50_000 };
    expect(estimateChainNowNs(clock, 50_000)).toBe(1_000n * S);
    expect(estimateChainNowNs(clock, 52_500)).toBe(1_002n * S + 500_000_000n);
    // A local clock going backwards never rewinds chain time.
    expect(estimateChainNowNs(clock, 40_000)).toBe(1_000n * S);
  });

  it("is independent of the local wall-clock offset (only deltas matter)", () => {
    const deadline = 1_120n * S;
    const a = remainingMs(deadline, estimateChainNowNs({ chainNowNs: 1_000n * S, localAtMs: 0 }, 30_000));
    const b = remainingMs(deadline, estimateChainNowNs({ chainNowNs: 1_000n * S, localAtMs: 9e12 }, 9e12 + 30_000));
    expect(a).toBe(90_000);
    expect(b).toBe(90_000);
  });

  it("remaining is floored at zero; exactly at deadline is 0", () => {
    expect(remainingMs(1_120n * S, 1_120n * S)).toBe(0);
    expect(remainingMs(1_120n * S, 1_200n * S)).toBe(0);
    expect(remainingMs(1_120n * S, 1_119n * S)).toBe(1_000);
  });

  it("formats MM:SS, H:MM:SS and rounds up partial seconds", () => {
    expect(formatCountdown(120_000)).toBe("02:00");
    expect(formatCountdown(119_001)).toBe("02:00");
    expect(formatCountdown(1)).toBe("00:01");
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(3_600_000)).toBe("1:00:00");
    expect(formatCountdown(-5)).toBe("00:00");
  });

  it("uses the dynamic round duration from the contract (120 s demo, 60 min concept)", () => {
    expect(formatDuration(120n * S)).toBe("2 min");
    expect(formatDuration(3_600n * S)).toBe("60 min");
    expect(formatDuration(90n * S)).toBe("90 s");
    expect(progressLeft(60_000, DUR)).toBeCloseTo(0.5);
    expect(progressLeft(60_000, 3_600n * S)).toBeCloseTo(1 / 60);
    expect(isUrgent(20_000, DUR)).toBe(true);
    expect(isUrgent(40_000, DUR)).toBe(false);
    expect(isUrgent(0, DUR)).toBe(false);
  });
});

describe("display phase — contract status always wins", () => {
  it("IDLE and EXPIRED come only from the contract", () => {
    expect(displayPhase("IDLE", 50_000)).toBe("IDLE");
    expect(displayPhase("EXPIRED", 50_000)).toBe("EXPIRED"); // even if local clock says time left
  });

  it("ACTIVE with local 0 is CLOSING, never EXPIRED", () => {
    expect(displayPhase("ACTIVE", 1)).toBe("ACTIVE");
    expect(displayPhase("ACTIVE", 0)).toBe("CLOSING");
  });

  it("settle is offered only on contract EXPIRED and only if Gate 2 exports settle_round", () => {
    const caps = { ...NO_GATE2, settleRound: true, source: "wasm-exports" as const };
    expect(canSettle(game({ status: "ACTIVE" }), caps).allowed).toBe(false);
    expect(canSettle(game({ status: "EXPIRED" }), caps).allowed).toBe(true);
    const off = canSettle(game({ status: "EXPIRED" }), NO_GATE2);
    expect(off.allowed).toBe(false);
    expect(off.reason).toMatch(/Gate 2/);
  });
});

describe("leader changes", () => {
  it("first load is not a change", () => {
    expect(detectLeaderChange(null, game({}))).toBeNull();
  });

  it("new leader in the same round", () => {
    const c = detectLeaderChange(game({}), game({ leader: "bob.testnet", deadlineNs: 1_150n * S }));
    expect(c).toEqual({ previous: "alice.testnet", next: "bob.testnet", roundId: 1n });
  });

  it("same leader re-buying (deadline moved) is a reset", () => {
    expect(detectLeaderChange(game({}), game({ deadlineNs: 1_130n * S }))).not.toBeNull();
  });

  it("dust buy / sell / plain refresh: same leader, same deadline → no change", () => {
    expect(detectLeaderChange(game({}), game({ activePot: 99n, nowNs: 1_010n * S }))).toBeNull();
  });

  it("IDLE → new round counts; IDLE has no leader", () => {
    const idle = game({ status: "IDLE", roundId: 2n, leader: null, deadlineNs: null, startedAtNs: null });
    expect(detectLeaderChange(game({}), idle)).toBeNull();
    expect(detectLeaderChange(idle, game({ roundId: 2n, leader: "carol.testnet" }))).toEqual({
      previous: null,
      next: "carol.testnet",
      roundId: 2n,
    });
  });
});

describe("misc helpers", () => {
  it("recent round ids, newest first, capped", () => {
    expect(recentRoundIds(null)).toEqual([]);
    expect(recentRoundIds(3n)).toEqual([3n, 2n, 1n]);
    expect(recentRoundIds(20n, 3)).toEqual([20n, 19n, 18n]);
  });

  it("shortens long and implicit accounts", () => {
    expect(shortAccount("bob.testnet")).toBe("bob.testnet");
    expect(shortAccount("a".repeat(64).replace(/a/g, "f"))).toBe("ffffff…ffff");
  });
});
