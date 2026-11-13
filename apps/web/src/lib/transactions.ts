/**
 * Transaction layer: builds the exact actions of CONTRACT_API v0.2 and interprets the outcome.
 * It never signs by itself — a `LastWriter` (wallet or SIMULATED) does. Amounts go out as decimal
 * strings built from `bigint`.
 */

import { FeatureUnavailableError, extractErrorCode } from "./errors";
import { fromBase64 } from "./rpc";
import type { Capabilities } from "./types";

export const TGAS = 1_000_000_000_000n;
export const GAS = {
  buy: 30n * TGAS,
  sell: 30n * TGAS,
  storageDeposit: 30n * TGAS,
  settle: 30n * TGAS,
  withdraw: 50n * TGAS,
  claim: 50n * TGAS,
} as const;
export const ONE_YOCTO = 1n;

export interface FunctionCallAction {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
}

/** Session-key management: AddKey / DeleteKey on the user's own account, signed in the wallet. */
export interface AddKeyAction {
  type: "AddKey";
  params: {
    publicKey: string;
    accessKey: { permission: { receiverId: string; allowance?: string; methodNames: string[] } };
  };
}
export interface DeleteKeyAction {
  type: "DeleteKey";
  params: { publicKey: string };
}
export type TxAction = FunctionCallAction | AddKeyAction | DeleteKeyAction;

export type TxKind = "buy" | "sell" | "withdraw" | "settle" | "claim" | "register" | "session" | "deposit";

export interface TxRequest {
  kind: TxKind;
  receiverId: string;
  actions: TxAction[];
  /** Signed by the in-browser session key (no wallet popup) instead of the wallet. */
  auto?: boolean;
  /** Human summary for the confirmation toast. */
  label: string;
  /** Round targeted by settle / claim (used to verify the on-chain effect). */
  meta?: { roundId?: bigint };
}

/** Total gas attached to a transaction (upper bound of what it can burn). */
export function totalGas(tx: TxRequest): bigint {
  return tx.actions.reduce((sum, a) => (a.type === "FunctionCall" ? sum + BigInt(a.params.gas) : sum), 0n);
}

function call(methodName: string, args: Record<string, unknown>, gas: bigint, deposit: bigint): FunctionCallAction {
  return { type: "FunctionCall", params: { methodName, args, gas: gas.toString(), deposit: deposit.toString() } };
}

/**
 * NEP-145 registration. Deposit = `storage_balance_bounds().min`, read from the contract (never
 * hard-coded). `registration_only: true` refunds anything above the minimum.
 */
export function storageDepositAction(minDeposit: bigint): FunctionCallAction {
  if (minDeposit <= 0n) throw new RangeError("storage deposit must be positive");
  return call("storage_deposit", { registration_only: true }, GAS.storageDeposit, minDeposit);
}

/**
 * `buy(min_tokens_out)`, payable with the gross amount. An unregistered user gets ONE transaction
 * with two actions: `storage_deposit` then `buy` (CONTRACT_API §2), so both succeed or both revert.
 */
export function buildBuyTx(p: {
  contractId: string;
  grossYocto: bigint;
  minTokensOut: bigint;
  /** Set when the buyer is not registered yet. */
  storageDeposit?: bigint | null;
  /** The round is EXPIRED on-chain: settle it in the same transaction, then buy (one signature). */
  settleFirst?: boolean;
  label: string;
}): TxRequest {
  if (p.grossYocto <= 0n) throw new RangeError("buy amount must be positive");
  if (p.minTokensOut < 0n) throw new RangeError("min_tokens_out must be >= 0");
  const actions: FunctionCallAction[] = [];
  if (p.settleFirst) actions.push(settleAction());
  if (p.storageDeposit != null) actions.push(storageDepositAction(p.storageDeposit));
  actions.push(call("buy", { min_tokens_out: p.minTokensOut.toString() }, GAS.buy, p.grossYocto));
  return { kind: "buy", receiverId: p.contractId, actions, label: p.label };
}

/** `sell(tokens_in, min_near_out)` with exactly 1 yoctoNEAR. Creates a withdrawable credit. */
export function buildSellTx(p: { contractId: string; tokensIn: bigint; minNearOut: bigint; settleFirst?: boolean; label: string }): TxRequest {
  if (p.tokensIn <= 0n) throw new RangeError("tokens_in must be positive");
  return {
    kind: "sell",
    receiverId: p.contractId,
    actions: [
      ...(p.settleFirst ? [settleAction()] : []),
      call("sell", { tokens_in: p.tokensIn.toString(), min_near_out: p.minNearOut.toString() }, GAS.sell, ONE_YOCTO),
    ],
    label: p.label,
  };
}

/** Gate 2 — `withdraw_near_credit()`, 1 yocto. */
export function buildWithdrawTx(contractId: string, caps: Capabilities): TxRequest {
  if (!caps.withdrawNearCredit) throw new FeatureUnavailableError("withdraw_near_credit");
  return {
    kind: "withdraw",
    receiverId: contractId,
    actions: [call("withdraw_near_credit", {}, GAS.withdraw, ONE_YOCTO)],
    label: "Withdraw NEAR credit",
  };
}

function settleAction(): FunctionCallAction {
  return call("settle_round", {}, GAS.settle, 0n);
}

/** Gate 2 — `settle_round()`, permissionless, no deposit. */
export function buildSettleTx(contractId: string, caps: Capabilities, roundId: bigint): TxRequest {
  if (!caps.settleRound) throw new FeatureUnavailableError("settle_round");
  return {
    kind: "settle",
    receiverId: contractId,
    actions: [settleAction()],
    label: `Settle round #${roundId}`,
    meta: { roundId },
  };
}

/** Gate 2 — `claim_reward(round_id)`, winner only, no deposit. */
export function buildClaimTx(contractId: string, caps: Capabilities, roundId: bigint): TxRequest {
  if (!caps.claimReward) throw new FeatureUnavailableError("claim_reward");
  return {
    kind: "claim",
    receiverId: contractId,
    actions: [call("claim_reward", { round_id: roundId.toString() }, GAS.claim, 0n)],
    label: `Claim round #${roundId} prize`,
    meta: { roundId },
  };
}

/**
 * The round's own winner settles AND claims in one transaction (two actions, run in order: if the
 * claim fails, the settle reverts with it). Used by auto mode.
 */
export function buildSettleAndClaimTx(contractId: string, caps: Capabilities, roundId: bigint): TxRequest {
  if (!caps.settleRound) throw new FeatureUnavailableError("settle_round");
  if (!caps.claimReward) throw new FeatureUnavailableError("claim_reward");
  return {
    kind: "claim",
    receiverId: contractId,
    actions: [settleAction(), call("claim_reward", { round_id: roundId.toString() }, GAS.claim, 0n)],
    label: `Settle round #${roundId} & claim your prize`,
    meta: { roundId },
  };
}

// ---------- session key (auto mode) ----------

/**
 * The only methods the session key may call. None takes a deposit (a function-call key cannot
 * attach one): it can settle, claim, and trade the owner's play balance / tokens — never send NEAR
 * or LAST to anyone else. Methods the deployed contract lacks are simply never called.
 */
export const SESSION_METHODS = ["settle_round", "claim_reward", "buy_from_balance", "sell_to_balance"] as const;
/** Lifetime gas budget of the session key: 0.25 NEAR. */
export const SESSION_ALLOWANCE = 250_000_000_000_000_000_000_000n;

/** v0.4 — put NEAR in the play balance (wallet signature; registers storage first if needed). */
export function buildDepositTx(p: { contractId: string; amount: bigint; storageDeposit?: bigint | null; label: string }): TxRequest {
  if (p.amount <= 0n) throw new RangeError("deposit must be positive");
  const actions: FunctionCallAction[] = [];
  if (p.storageDeposit != null) actions.push(storageDepositAction(p.storageDeposit));
  actions.push(call("deposit_balance", {}, GAS.buy, p.amount));
  return { kind: "deposit", receiverId: p.contractId, actions, label: p.label };
}

/** v0.4 — buy from the play balance: no deposit, so the session key signs it (no popup). */
export function buildBuyFromBalanceTx(p: { contractId: string; amount: bigint; minTokensOut: bigint; settleFirst?: boolean; label: string }): TxRequest {
  if (p.amount <= 0n) throw new RangeError("buy amount must be positive");
  return {
    kind: "buy",
    receiverId: p.contractId,
    actions: [
      ...(p.settleFirst ? [settleAction()] : []),
      call("buy_from_balance", { amount: p.amount.toString(), min_tokens_out: p.minTokensOut.toString() }, GAS.buy, 0n),
    ],
    label: p.label,
    auto: true,
  };
}

/** v0.4 — sell into the play balance without the 1 yocto (session key). */
export function buildSellToBalanceTx(p: { contractId: string; tokensIn: bigint; minNearOut: bigint; settleFirst?: boolean; label: string }): TxRequest {
  if (p.tokensIn <= 0n) throw new RangeError("tokens_in must be positive");
  return {
    kind: "sell",
    receiverId: p.contractId,
    actions: [
      ...(p.settleFirst ? [settleAction()] : []),
      call("sell_to_balance", { tokens_in: p.tokensIn.toString(), min_near_out: p.minNearOut.toString() }, GAS.sell, 0n),
    ],
    label: p.label,
    auto: true,
  };
}

/** Adds the limited session key to the user's own account. Signed once in the wallet. */
export function buildAddSessionKeyTx(accountId: string, contractId: string, publicKey: string): TxRequest {
  return {
    kind: "session",
    receiverId: accountId,
    actions: [
      {
        type: "AddKey",
        params: {
          publicKey,
          accessKey: {
            permission: { receiverId: contractId, allowance: SESSION_ALLOWANCE.toString(), methodNames: [...SESSION_METHODS] },
          },
        },
      },
    ],
    label: "Enable instant trading",
  };
}

/** Removes session key(s) from the user's account (one wallet signature). */
export function buildDeleteSessionKeyTx(accountId: string, publicKeys: string | string[], label?: string): TxRequest {
  const keys = Array.isArray(publicKeys) ? publicKeys : [publicKeys];
  if (keys.length === 0) throw new RangeError("no key to delete");
  return {
    kind: "session",
    receiverId: accountId,
    actions: keys.map((publicKey) => ({ type: "DeleteKey" as const, params: { publicKey } })),
    label: label ?? (Array.isArray(publicKeys) ? `Remove ${keys.length} unused session key${keys.length > 1 ? "s" : ""}` : "Turn off instant trading"),
  };
}

// ---------- outcome ----------

/** Subset of near-api-js `FinalExecutionOutcome` we rely on. */
export interface ExecutionOutcomeLike {
  status?: unknown;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
  receipts_outcome?: Array<{ outcome?: { status?: unknown } }>;
}

export type TxResult =
  | { ok: true; hash: string | null; value: unknown }
  | { ok: false; hash: string | null; code: string | null; message: string };

/**
 * A transaction is confirmed only if the final status is SuccessValue AND no receipt failed.
 * For promise-based payouts (`claim_reward`, `withdraw_near_credit`) the callback's
 * `{ success: false }` is a failed payout even though the transaction itself succeeded.
 */
export function interpretOutcome(outcome: ExecutionOutcomeLike, kind: TxKind): TxResult {
  const hash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? null;
  const status = outcome.status as Record<string, unknown> | string | undefined;

  const failures = [status, ...(outcome.receipts_outcome ?? []).map((r) => r.outcome?.status)].filter(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null && "Failure" in s,
  );
  if (failures.length > 0) {
    const code = extractErrorCode(failures);
    return { ok: false, hash, code, message: code ?? summarizeFailure(failures[0]!.Failure) };
  }
  if (typeof status !== "object" || status === null || !("SuccessValue" in status)) {
    return { ok: false, hash, code: null, message: "Transaction did not reach a final success status." };
  }

  const value = decodeSuccessValue(status.SuccessValue);
  if ((kind === "claim" || kind === "withdraw") && isPayoutResult(value) && value.success === false) {
    return {
      ok: false,
      hash,
      code: null,
      message: "The NEAR transfer failed; the contract restored your balance to AVAILABLE. You can retry.",
    };
  }
  return { ok: true, hash, value };
}

function decodeSuccessValue(v: unknown): unknown {
  if (typeof v !== "string" || v === "") return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64(v)));
  } catch {
    return null;
  }
}

function isPayoutResult(v: unknown): v is { success: boolean } {
  return typeof v === "object" && v !== null && "success" in v && typeof (v as { success: unknown }).success === "boolean";
}

function summarizeFailure(f: unknown): string {
  const s = JSON.stringify(f);
  const panic = /"(?:ExecutionError|PanicMsg)"\s*:\s*"([^"]+)"/.exec(s);
  if (panic) return panic[1]!;
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * What a confirmed transaction actually did, from its decoded return value (CONTRACT_API v0.2 §2).
 * Distinguishes a crown-taking buy from a plain token buy.
 */
export function describeResult(kind: TxKind, value: unknown): string | null {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  switch (kind) {
    case "buy":
      if (v.eligible === true) return "Eligible buy — you took the crown and reset the timer.";
      if (v.eligible === false) return "Token buy below the minimum — crown and timer unchanged.";
      return null;
    case "sell":
      return "Sold — proceeds added to your withdrawable NEAR credit (not paid out yet).";
    case "settle":
      return "Round settled — the prize is reserved for the winner to claim.";
    case "claim":
      return "Prize paid to your wallet.";
    case "withdraw":
      return "NEAR credit paid to your wallet.";
    case "register":
      return "Storage registered.";
    case "session":
      return null;
    case "deposit":
      return "Added to your play balance — trades now need no wallet popup.";
  }
}
