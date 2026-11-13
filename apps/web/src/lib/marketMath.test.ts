// UNIT (no network). Pins the SIMULATED adapter's math to Builder A's Rust test vectors
// (contracts/last/src/market.rs tests). Live screens never use this math: they call quote_*.
import { describe, expect, it } from "vitest";
import { calcBuy, calcSell, splitFee } from "./marketMath";
import { applySlippage, parseSlippagePercent } from "./slippage";

const NEAR = 10n ** 24n;
const X0 = 3n * NEAR;
const Y0 = 10n ** 24n;

describe("AMM math parity with market.rs", () => {
  it("demo_min_buy_quote: 0.03 NEAR → fee 0.0012, ~9,508.x LAST", () => {
    const q = calcBuy(X0, Y0, (3n * NEAR) / 100n);
    expect(q.fee).toBe(12n * 10n ** 20n);
    expect(q.tokensOut > 9_508n * 10n ** 18n).toBe(true);
    expect(q.tokensOut < 9_509n * 10n ** 18n).toBe(true);
  });

  it("buy never decreases k and conserves gross = fee + net", () => {
    for (const gross of [1n, 26n, 1000n, NEAR / 1000n, NEAR, 50n * NEAR, 10_000n * NEAR]) {
      const q = calcBuy(X0, Y0, gross);
      expect((X0 + q.netNear) * (Y0 - q.tokensOut) >= X0 * Y0).toBe(true);
      expect(q.fee + q.netNear).toBe(gross);
    }
  });

  it("sell never drains the reserve", () => {
    for (const t of [1n, 10n ** 18n, Y0 / 100n, Y0, 1000n * Y0]) {
      const q = calcSell(X0, Y0, t);
      expect(q.grossNearOut < X0).toBe(true);
      expect(q.fee + q.payout).toBe(q.grossNearOut);
    }
  });

  it("dust produces zero output", () => {
    expect(calcBuy(X0, Y0, 1n).tokensOut).toBe(0n);
    expect(calcSell(X0, Y0, 0n).payout).toBe(0n);
  });

  it("70/10/15/5 split conserves every yoctoNEAR, remainder to treasury", () => {
    for (const fee of [0n, 1n, 7n, 99n, 12n * 10n ** 20n, 10n ** 30n + 3n]) {
      const s = splitFee(fee);
      expect(s.jackpot + s.nextSeed + s.ops + s.treasury).toBe(fee);
    }
    // README example: 1 NEAR buy → 0.04 fee → 0.028 / 0.004 / 0.006 / 0.002
    const s = splitFee(4n * 10n ** 22n);
    expect(s).toEqual({ jackpot: 28n * 10n ** 21n, nextSeed: 4n * 10n ** 21n, ops: 2n * 10n ** 21n, treasury: 6n * 10n ** 21n });
  });
});

describe("slippage", () => {
  it("min out = floor(quote * (1 - s))", () => {
    expect(applySlippage(10_000n, 100n)).toBe(9_900n);
    expect(applySlippage(999n, 100n)).toBe(989n); // floor(989.01)
    expect(applySlippage(5n, 0n)).toBe(5n);
    expect(() => applySlippage(1n, 5_001n)).toThrow(RangeError);
    expect(() => applySlippage(1n, -1n)).toThrow(RangeError);
  });

  it("parses percent input to bps", () => {
    expect(parseSlippagePercent("0.5")).toBe(50n);
    expect(parseSlippagePercent("1")).toBe(100n);
    expect(parseSlippagePercent("50")).toBe(5_000n);
    expect(parseSlippagePercent("51")).toBeNull();
    expect(parseSlippagePercent("0.123")).toBeNull();
    expect(parseSlippagePercent("abc")).toBeNull();
  });
});
