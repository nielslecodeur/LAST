// UNIT (no network, no wallet). Exact transaction shapes, Gate 2 gating, outcome interpretation,
// tx lifecycle (pending / confirmed / failed), storage + buy limits, error classification.
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config";
import { classifyError, extractErrorCode } from "./errors";
import { RpcError, toBase64 } from "./rpc";
import { buildBuyTx, buildClaimTx, buildSellTx, buildSettleTx, buildWithdrawTx, interpretOutcome } from "./transactions";
import { IDLE_TX, txReducer } from "./txMachine";
import { type AccountState, type Capabilities, NO_GATE2 } from "./types";
import { GAS_RESERVE_YOCTO, checkBuy, checkSell } from "./validation";

const NEAR = 10n ** 24n;
const GATE2: Capabilities = { settleRound: true, claimReward: true, withdrawNearCredit: true, getRound: true, source: "wasm-exports" };
const b64json = (v: unknown) => toBase64(new TextEncoder().encode(JSON.stringify(v)));

describe("transaction builders (CONTRACT_API v0.2)", () => {
  it("buy: payable gross, min_tokens_out as decimal string, 30 Tgas", () => {
    const tx = buildBuyTx({ contractId: "last.testnet", grossYocto: 3n * 10n ** 22n, minTokensOut: 9_400n * 10n ** 18n, label: "b" });
    expect(tx.actions).toEqual([
      { type: "FunctionCall", params: { methodName: "buy", args: { min_tokens_out: "9400000000000000000000" }, gas: "30000000000000", deposit: "30000000000000000000000" } },
    ]);
  });

  it("unregistered buyer: storage_deposit (bounds.min) then buy, in ONE transaction", () => {
    const tx = buildBuyTx({ contractId: "last.testnet", grossYocto: NEAR, minTokensOut: 1n, storageDeposit: 1_250_000_000_000_000_000_000n, label: "b" });
    expect(tx.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "buy"]);
    expect(tx.actions[0]!.params.deposit).toBe("1250000000000000000000");
    expect(tx.actions[0]!.params.args).toEqual({ registration_only: true });
  });

  it("sell: exactly 1 yoctoNEAR", () => {
    const tx = buildSellTx({ contractId: "last.testnet", tokensIn: 10n ** 18n, minNearOut: 5n, label: "s" });
    expect(tx.actions[0]!.params).toEqual({ methodName: "sell", args: { tokens_in: "1000000000000000000", min_near_out: "5" }, gas: "30000000000000", deposit: "1" });
  });

  it("rejects non-positive amounts", () => {
    expect(() => buildBuyTx({ contractId: "c", grossYocto: 0n, minTokensOut: 0n, label: "" })).toThrow();
    expect(() => buildSellTx({ contractId: "c", tokensIn: 0n, minNearOut: 0n, label: "" })).toThrow();
  });

  it("Gate 2 builders refuse while the contract does not export the method", () => {
    expect(() => buildSettleTx("c", NO_GATE2, 1n)).toThrow(/settle_round.*Gate 2/);
    expect(() => buildClaimTx("c", NO_GATE2, 1n)).toThrow(/claim_reward/);
    expect(() => buildWithdrawTx("c", NO_GATE2)).toThrow(/withdraw_near_credit/);
    expect(classifyError(catchErr(() => buildSettleTx("c", NO_GATE2, 1n))).kind).toBe("unavailable");
  });

  it("Gate 2 builders produce the agreed signatures once available", () => {
    expect(buildSettleTx("c", GATE2, 4n).actions[0]!.params).toMatchObject({ methodName: "settle_round", args: {}, deposit: "0" });
    expect(buildClaimTx("c", GATE2, 4n).actions[0]!.params).toMatchObject({ methodName: "claim_reward", args: { round_id: "4" }, gas: "50000000000000", deposit: "0" });
    expect(buildWithdrawTx("c", GATE2).actions[0]!.params).toMatchObject({ methodName: "withdraw_near_credit", deposit: "1", gas: "50000000000000" });
  });
});

describe("outcome interpretation", () => {
  it("SuccessValue → ok with decoded JSON", () => {
    const r = interpretOutcome({ status: { SuccessValue: b64json({ tokens_out: "1", eligible: true }) }, transaction: { hash: "H" } }, "buy");
    expect(r).toEqual({ ok: true, hash: "H", value: { tokens_out: "1", eligible: true } });
  });

  it("contract panic → failed with ERR code", () => {
    const r = interpretOutcome(
      { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_SLIPPAGE" } } } } }, transaction: { hash: "H" } },
      "buy",
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("ERR_SLIPPAGE");
  });

  it("a failed receipt fails the tx even if the top-level status looks fine", () => {
    const r = interpretOutcome({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { x: "ERR_INSOLVENT" } } } }] }, "sell");
    expect(!r.ok && r.code).toBe("ERR_INSOLVENT");
  });

  it("claim callback success:false is a failed payout, not a success", () => {
    const r = interpretOutcome({ status: { SuccessValue: b64json({ round_id: "1", amount: "5", success: false }) } }, "claim");
    expect(r.ok).toBe(false);
    const w = interpretOutcome({ status: { SuccessValue: b64json({ amount: "5", success: true }) } }, "withdraw");
    expect(w.ok).toBe(true);
  });

  it("no final status → not confirmed", () => {
    expect(interpretOutcome({ status: "Started" }, "buy").ok).toBe(false);
  });
});

describe("tx lifecycle: idle → signing → pending → confirmed / failed / rejected", () => {
  it("happy path only confirms after reconciliation", () => {
    let s = txReducer(IDLE_TX, { type: "SIGN", kind: "buy", label: "b" });
    expect(s.phase).toBe("signing");
    s = txReducer(s, { type: "OUTCOME_OK", hash: "H" });
    expect(s.phase).toBe("pending");
    expect(s.hash).toBe("H");
    s = txReducer(s, { type: "RECONCILED" });
    expect(s.phase).toBe("confirmed");
  });

  it("contract failure", () => {
    let s = txReducer(IDLE_TX, { type: "SIGN", kind: "sell", label: "s" });
    s = txReducer(s, { type: "OUTCOME_FAILED", hash: "H", error: classifyError("ERR_ROUND_EXPIRED") });
    expect(s.phase).toBe("failed");
    expect(s.error?.code).toBe("ERR_ROUND_EXPIRED");
  });

  it("wallet rejection vs thrown network error", () => {
    const sig = txReducer(IDLE_TX, { type: "SIGN", kind: "buy", label: "b" });
    expect(txReducer(sig, { type: "THROWN", error: classifyError(new Error("User rejected the request")) }).phase).toBe("rejected");
    expect(txReducer(sig, { type: "THROWN", error: classifyError(new Error("socket hang up")) }).phase).toBe("failed");
  });

  it("one transaction at a time; cannot reset while busy", () => {
    const sig = txReducer(IDLE_TX, { type: "SIGN", kind: "buy", label: "b" });
    expect(txReducer(sig, { type: "SIGN", kind: "sell", label: "s" })).toBe(sig);
    expect(txReducer(sig, { type: "RESET" })).toBe(sig);
    expect(txReducer(IDLE_TX, { type: "RECONCILED" })).toBe(IDLE_TX);
  });
});

describe("pre-signature checks: storage, eligibility, limits", () => {
  const acct = (p: Partial<AccountState> = {}): AccountState => ({
    registered: true,
    lastBalance: 0n,
    creditAvailable: 0n,
    creditInFlight: 0n,
    claimableRounds: [],
    ...p,
  });
  const base = {
    deployed: true,
    accountId: "a.testnet",
    status: "ACTIVE" as const,
    gross: 3n * 10n ** 22n,
    quote: { tokensOut: 9_500n * 10n ** 18n, fee: 12n * 10n ** 20n, netNear: 288n * 10n ** 20n, eligible: true },
    nearBalance: 5n * NEAR,
    account: acct(),
    storage: { min: 125n * 10n ** 19n, max: null },
    minEligibleBuy: 3n * 10n ** 22n,
  };

  it("eligible buy passes; exactly the minimum is eligible", () => {
    const c = checkBuy(base);
    expect(c.blocker).toBeNull();
    expect(c.eligible).toBe(true);
    expect(c.storageDeposit).toBeNull();
  });

  it("below minimum: allowed but warned (no crown)", () => {
    const c = checkBuy({ ...base, gross: 3n * 10n ** 22n - 1n, quote: { ...base.quote, eligible: false } });
    expect(c.blocker).toBeNull();
    expect(c.eligible).toBe(false);
    expect(c.warnings.join(" ")).toMatch(/NOT take the crown/);
  });

  it("unregistered: storage deposit from storage_balance_bounds().min is added to the cost", () => {
    const c = checkBuy({ ...base, account: acct({ registered: false }) });
    expect(c.storageDeposit).toBe(125n * 10n ** 19n);
    expect(c.totalCost).toBe(base.gross + 125n * 10n ** 19n);
    expect(checkBuy({ ...base, account: acct({ registered: false }), storage: null }).blocker).toBe("LOADING");
  });

  it("insufficient NEAR accounts for gas reserve and storage", () => {
    const exact = base.gross + GAS_RESERVE_YOCTO;
    expect(checkBuy({ ...base, nearBalance: exact }).blocker).toBeNull();
    expect(checkBuy({ ...base, nearBalance: exact - 1n }).blocker).toBe("INSUFFICIENT_NEAR");
  });

  it("blocked states", () => {
    expect(checkBuy({ ...base, deployed: false }).blocker).toBe("NOT_DEPLOYED");
    expect(checkBuy({ ...base, accountId: null }).blocker).toBe("NO_WALLET");
    expect(checkBuy({ ...base, status: "EXPIRED" }).blocker).toBe("ROUND_EXPIRED");
    expect(checkBuy({ ...base, gross: null }).blocker).toBe("NO_AMOUNT");
    expect(checkBuy({ ...base, quote: { ...base.quote, tokensOut: 0n } }).blocker).toBe("ZERO_OUTPUT");
  });

  it("sell checks", () => {
    const s = { deployed: true, accountId: "a", status: "ACTIVE" as const, tokensIn: 10n, quote: { grossNearOut: 2n, fee: 0n, payout: 2n }, account: acct({ lastBalance: 10n }) };
    expect(checkSell(s)).toBeNull();
    expect(checkSell({ ...s, tokensIn: 11n })).toBe("INSUFFICIENT_LAST");
    expect(checkSell({ ...s, account: acct({ registered: false }) })).toBe("NOT_REGISTERED");
    expect(checkSell({ ...s, status: "EXPIRED" })).toBe("ROUND_EXPIRED");
    expect(checkSell({ ...s, quote: { grossNearOut: 0n, fee: 0n, payout: 0n } })).toBe("ZERO_OUTPUT");
  });
});

describe("errors & config", () => {
  it("extracts ERR codes from nested outcomes", () => {
    expect(extractErrorCode({ a: { b: "Smart contract panicked: ERR_NOT_WINNER" } })).toBe("ERR_NOT_WINNER");
    expect(extractErrorCode("nothing")).toBeNull();
    expect(classifyError("ERR_ALREADY_PAID").message).toMatch(/already paid/);
  });

  it("RPC errors are reported as RPC errors (wrong contract → explicit message)", () => {
    expect(classifyError(new RpcError("method_not_found", "MethodNotFound")).message).toMatch(/does not expose this LAST method/);
    const net = classifyError(new RpcError("network", "Cannot reach rpc"));
    expect(net.kind).toBe("rpc");
    expect(net.message).toMatch(/Cannot reach rpc/);
  });

  it("testnet only: mainnet ids are refused; no id = not deployed", () => {
    expect(resolveConfig({}).source).toBe("not_deployed");
    expect(resolveConfig({ VITE_LAST_CONTRACT_ID: "last.near" }).source).toBe("config_error");
    expect(resolveConfig({ VITE_LAST_CONTRACT_ID: "Bad_ID!" }).source).toBe("config_error");
    expect(resolveConfig({ VITE_LAST_CONTRACT_ID: "last-game.testnet" })).toMatchObject({ source: "live", contractId: "last-game.testnet" });
  });

  it("mock mode is reachable on the dev server only", () => {
    expect(resolveConfig({ MODE: "mock", DEV: true }).source).toBe("simulated");
    expect(resolveConfig({ MODE: "mock", DEV: false }).source).toBe("not_deployed");
  });
});

function catchErr(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return null;
}
