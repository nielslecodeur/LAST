// UNIT (no network). Chain-synced countdown helpers used by the jackpot page.
import { describe, expect, it } from "vitest";
import { shortAccount } from "./accounts";
import { estimateChainNowNs, formatCountdown, formatDuration, mergeClock, remainingMs, sampleClock } from "./countdown";

const S = 1_000_000_000n; // ns per second

describe("chain-synced countdown", () => {
  it("advances chain time by local elapsed time, never backwards", () => {
    const clock = { chainNowNs: 1_000n * S, localAtMs: 50_000 };
    expect(estimateChainNowNs(clock, 50_000)).toBe(1_000n * S);
    expect(estimateChainNowNs(clock, 52_500)).toBe(1_002n * S + 500_000_000n);
    expect(estimateChainNowNs(clock, 40_000)).toBe(1_000n * S);
  });

  it("remaining time is 0 at or after the deadline", () => {
    expect(remainingMs(1_060n * S, 1_000n * S)).toBe(60_000);
    expect(remainingMs(1_000n * S, 1_000n * S)).toBe(0);
    expect(remainingMs(1_000n * S, 1_001n * S)).toBe(0);
  });

  it("a slower sample cannot make the countdown jump back up", () => {
    const a = sampleClock(1_000n * S, 0, 200);
    const later = mergeClock(a, sampleClock(1_000n * S, 5_000, 5_100));
    expect(estimateChainNowNs(later, 5_100)).toBeGreaterThanOrEqual(estimateChainNowNs(a, 5_100) - 200_000_000n);
  });
});

describe("formatting", () => {
  it("formats countdowns, rounding up to the second", () => {
    expect(formatCountdown(125_400)).toBe("02:06");
    expect(formatCountdown(3_600_000)).toBe("1:00:00");
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5)).toBe("00:00");
  });

  it("formats round durations", () => {
    expect(formatDuration(3_600n * S)).toBe("60 min");
    expect(formatDuration(90n * S)).toBe("90 s");
  });

  it("shortens long and implicit account ids", () => {
    expect(shortAccount("alice.near")).toBe("alice.near");
    expect(shortAccount("16f9aa6f925adaba5c10bc5c28e8f58a3cb891b199bc57d3f0b76404ced122ee")).toBe("16f9aa…22ee");
    expect(shortAccount("a-very-long-account-name-for-tests.near").length).toBeLessThanOrEqual(22);
  });
});
