// UNIT (no network). BigInt amounts and LAST/NEAR conversions.
import { describe, expect, it } from "vitest";
import {
  AmountError,
  U128_MAX,
  bpsOf,
  formatBps,
  formatCompact,
  formatLast,
  formatNear,
  formatUnits,
  parseLast,
  parseNear,
  parseU128,
  parseU64,
  parseUnits,
  spotPriceYoctoPerLast,
  tryParseUnits,
} from "./amounts";

const NEAR = 10n ** 24n;
const LAST = 10n ** 18n;

describe("parseUnits", () => {
  it("parses NEAR to yoctoNEAR exactly", () => {
    expect(parseNear("1")).toBe(NEAR);
    expect(parseNear("0.03")).toBe(3n * 10n ** 22n);
    expect(parseNear("3")).toBe(3n * NEAR);
    expect(parseNear(".5")).toBe(NEAR / 2n);
    expect(parseNear("0.000000000000000000000001")).toBe(1n); // 1 yocto
  });

  it("parses LAST to atomic units (18 decimals)", () => {
    expect(parseLast("1000000")).toBe(10n ** 24n); // total supply
    expect(parseLast("9508.7")).toBe(95087n * 10n ** 17n);
  });

  it("never goes through floating point (0.1 + 0.2 is exact)", () => {
    expect(parseNear("0.1") + parseNear("0.2")).toBe(parseNear("0.3"));
  });

  it("accepts separators and whitespace", () => {
    expect(parseLast(" 1,000_000 ")).toBe(10n ** 24n);
  });

  it("rejects invalid input with a code", () => {
    const code = (s: string, d = 24) => {
      try {
        parseUnits(s, d);
        return null;
      } catch (e) {
        return (e as AmountError).code;
      }
    };
    expect(code("")).toBe("EMPTY");
    expect(code(".")).toBe("EMPTY");
    expect(code("-1")).toBe("INVALID");
    expect(code("1e3")).toBe("INVALID");
    expect(code("abc")).toBe("INVALID");
    expect(code("1.2.3")).toBe("INVALID");
    expect(code("0.0000000000000000001", 18)).toBe("TOO_MANY_DECIMALS");
    expect(code("1".repeat(40))).toBe("TOO_LARGE");
  });

  it("tryParseUnits returns null instead of throwing", () => {
    expect(tryParseUnits("x", 24)).toBeNull();
    expect(tryParseUnits("2", 24)).toBe(2n * NEAR);
  });
});

describe("formatUnits", () => {
  it("round-trips", () => {
    for (const s of ["0", "1", "0.03", "123456.000000000000000001", "3"]) {
      expect(formatUnits(parseNear(s), 24, { group: false })).toBe(s);
    }
  });

  it("floors (never rounds up) when truncating", () => {
    expect(formatNear(19999n * 10n ** 20n, 3)).toBe("1.999"); // 1.9999 → 1.999
    expect(formatNear(NEAR - 1n, 4)).toBe("0.9999");
  });

  it("groups thousands", () => {
    expect(formatLast(1_234_567n * LAST)).toBe("1,234,567");
  });

  it("formatCompact keeps significant digits for tiny prices", () => {
    // 3 NEAR / 1,000,000 LAST = 0.000003 NEAR per LAST
    expect(formatCompact(3n * 10n ** 18n, 24)).toBe("0.000003");
    expect(formatCompact(3_012_345n * 10n ** 12n, 24)).toBe("0.000003012");
    expect(formatCompact(0n, 24)).toBe("0");
    expect(formatCompact(1234n * NEAR + NEAR / 3n, 24)).toBe("1,234.33");
  });
});

describe("JSON U128/U64 decoding", () => {
  it("accepts decimal strings only", () => {
    expect(parseU128("340282366920938463463374607431768211455")).toBe(U128_MAX);
    expect(() => parseU128(5)).toThrow(TypeError);
    expect(() => parseU128("1.5")).toThrow(TypeError);
    expect(() => parseU128("-1")).toThrow(TypeError);
    expect(() => parseU128("340282366920938463463374607431768211456")).toThrow(RangeError);
    expect(() => parseU64("18446744073709551616")).toThrow(RangeError);
  });
});

describe("price & fees", () => {
  it("spot price of the 3 NEAR / 1M LAST demo pool is 0.000003 NEAR", () => {
    const p = spotPriceYoctoPerLast(3n * NEAR, 1_000_000n * LAST);
    expect(p).toBe(3n * 10n ** 18n);
    expect(formatCompact(p, 24)).toBe("0.000003");
    expect(spotPriceYoctoPerLast(1n, 0n)).toBe(0n);
  });

  it("bps math floors like the contract", () => {
    expect(bpsOf(3n * 10n ** 22n, 400n)).toBe(12n * 10n ** 20n); // 4% of 0.03 NEAR = 0.0012
    expect(bpsOf(24n, 400n)).toBe(0n); // floor
    expect(formatBps(400)).toBe("4%");
    expect(formatBps(250n)).toBe("2.5%");
  });
});
