/**
 * Money is integers (CLAUDE.md): yoctoNEAR (24 decimals) and atomic LAST (18 decimals) as `bigint`.
 * No floats, no JS `Number` anywhere an amount is computed. Strings in, strings out.
 */

export const NEAR_DECIMALS = 24;
export const LAST_DECIMALS = 18;
export const YOCTO_PER_NEAR = 10n ** 24n;
export const ATOMS_PER_LAST = 10n ** 18n;
export const U128_MAX = (1n << 128n) - 1n;
export const U64_MAX = (1n << 64n) - 1n;
export const BPS = 10_000n;

export type AmountErrorCode = "EMPTY" | "INVALID" | "TOO_MANY_DECIMALS" | "TOO_LARGE";

export class AmountError extends Error {
  constructor(public readonly code: AmountErrorCode, message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const DECIMAL_RE = /^(\d+)?(?:\.(\d*))?$/;

/** "1.5" with 24 decimals → 1500000000000000000000000n. Rejects signs, exponents, extra decimals. */
export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim().replace(/_/g, "").replace(/,/g, "");
  if (s === "" || s === ".") throw new AmountError("EMPTY", "Enter an amount");
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new AmountError("INVALID", "Not a valid number");
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    throw new AmountError("TOO_MANY_DECIMALS", `At most ${decimals} decimals`);
  }
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (value > U128_MAX) throw new AmountError("TOO_LARGE", "Amount too large");
  return value;
}

/** Non-throwing variant for live input fields. */
export function tryParseUnits(input: string, decimals: number): bigint | null {
  try {
    return parseUnits(input, decimals);
  } catch {
    return null;
  }
}

export interface FormatOptions {
  /** Max fraction digits shown; the rest is truncated (floor), never rounded up. Default: all. */
  maxFractionDigits?: number;
  /** Thousands separators on the integer part. Default true. */
  group?: boolean;
}

/** Floor-formats an atomic amount. 1500000000000000000000000n, 24 → "1.5". */
export function formatUnits(value: bigint, decimals: number, opts: FormatOptions = {}): string {
  const { maxFractionDigits = decimals, group = true } = opts;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFractionDigits));
  frac = frac.replace(/0+$/, "");
  let wholeStr = whole.toString();
  if (group) wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeStr}${frac ? `.${frac}` : ""}`;
}

/**
 * Human display with a sensible precision: big numbers get few decimals, tiny ones keep
 * `sigDigits` significant digits (e.g. a spot price of 0.000003012 NEAR). Still floor, still bigint.
 */
export function formatCompact(value: bigint, decimals: number, sigDigits = 4): string {
  if (value === 0n) return "0";
  const base = 10n ** BigInt(decimals);
  const abs = value < 0n ? -value : value;
  if (abs >= base * 1000n) return formatUnits(value, decimals, { maxFractionDigits: 2 });
  if (abs >= base) return formatUnits(value, decimals, { maxFractionDigits: 4 });
  // < 1: keep `sigDigits` digits after the leading zeros.
  const fracStr = (abs % base).toString().padStart(decimals, "0");
  const leadingZeros = fracStr.length - fracStr.replace(/^0+/, "").length;
  return formatUnits(value, decimals, { maxFractionDigits: Math.min(decimals, leadingZeros + sigDigits) });
}

export const parseNear = (s: string) => parseUnits(s, NEAR_DECIMALS);
export const parseLast = (s: string) => parseUnits(s, LAST_DECIMALS);
export const formatNear = (v: bigint, maxFractionDigits = 4) =>
  formatUnits(v, NEAR_DECIMALS, { maxFractionDigits });
export const formatLast = (v: bigint, maxFractionDigits = 2) =>
  formatUnits(v, LAST_DECIMALS, { maxFractionDigits });

/** Strict JSON U128/U64 decoder: decimal string only, within range. */
export function parseU128(raw: unknown, field = "value"): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new TypeError(`${field}: expected a decimal string, got ${JSON.stringify(raw)}`);
  }
  const v = BigInt(raw);
  if (v > U128_MAX) throw new RangeError(`${field}: exceeds u128`);
  return v;
}

export function parseU64(raw: unknown, field = "value"): bigint {
  const v = parseU128(raw, field);
  if (v > U64_MAX) throw new RangeError(`${field}: exceeds u64`);
  return v;
}

/**
 * Marginal spot price, in yoctoNEAR per 1 whole LAST:
 * (near_reserve / 10^24) / (last_inventory / 10^18) NEAR = near_reserve * 10^18 / last_inventory yocto.
 * Indicative only; a trade moves the price.
 */
export function spotPriceYoctoPerLast(nearReserve: bigint, lastInventory: bigint): bigint {
  if (lastInventory === 0n) return 0n;
  return (nearReserve * ATOMS_PER_LAST) / lastInventory;
}

/** `floor(amount * bps / 10000)` — same rounding as the contract's `fee_of`. */
export function bpsOf(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / BPS;
}

/** "400" bps → "4%", "250" → "2.5%". */
export function formatBps(bps: number | bigint): string {
  return `${formatUnits(BigInt(bps), 2, { group: false })}%`;
}
