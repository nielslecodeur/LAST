/**
 * Transaction lifecycle, independent of React:
 *
 *   idle → signing → pending → confirmed
 *              │         ├──→ unresolved   (executed, but the on-chain effect is not visible yet,
 *              │         │                  or a payout is still IN_FLIGHT — never a success)
 *              │         └──→ failed
 *              └──→ rejected | failed
 *
 * - signing:    waiting for the wallet (user approval + broadcast + execution).
 * - pending:    the wallet returned a successful outcome; we re-read contract views until they
 *               show the expected effect (SPEC §1.2: no optimistic winner update).
 * - confirmed:  outcome succeeded AND fresh contract state shows the effect.
 */

import type { UiError } from "./errors";
import type { TxKind } from "./transactions";

export type TxPhase = "idle" | "signing" | "pending" | "confirmed" | "unresolved" | "failed" | "rejected";

export interface TxState {
  phase: TxPhase;
  kind: TxKind | null;
  label: string | null;
  hash: string | null;
  error: UiError | null;
  /** Extra context on success / unresolved (e.g. "took the crown", "IN_FLIGHT"). */
  note: string | null;
  /** Signed by the auto-mode session key, not in the wallet. */
  auto: boolean;
}

export type TxEvent =
  | { type: "SIGN"; kind: TxKind; label: string; auto?: boolean }
  | { type: "OUTCOME_OK"; hash: string | null }
  | { type: "OUTCOME_FAILED"; hash: string | null; error: UiError }
  | { type: "THROWN"; error: UiError }
  | { type: "RECONCILED"; note?: string | null }
  | { type: "UNRESOLVED"; note: string }
  | { type: "RESET" };

export const IDLE_TX: TxState = { phase: "idle", kind: null, label: null, hash: null, error: null, note: null, auto: false };

export function txReducer(state: TxState, ev: TxEvent): TxState {
  switch (ev.type) {
    case "SIGN":
      if (isBusy(state)) return state; // one transaction at a time
      return { phase: "signing", kind: ev.kind, label: ev.label, hash: null, error: null, note: null, auto: ev.auto === true };
    case "OUTCOME_OK":
      return state.phase === "signing" ? { ...state, phase: "pending", hash: ev.hash } : state;
    case "OUTCOME_FAILED":
      return state.phase === "signing" ? { ...state, phase: "failed", hash: ev.hash, error: ev.error } : state;
    case "THROWN":
      if (state.phase !== "signing") return state;
      return { ...state, phase: ev.error.kind === "rejected" ? "rejected" : "failed", error: ev.error };
    case "RECONCILED":
      return state.phase === "pending" ? { ...state, phase: "confirmed", note: ev.note ?? null } : state;
    case "UNRESOLVED":
      return state.phase === "pending" ? { ...state, phase: "unresolved", note: ev.note } : state;
    case "RESET":
      return isBusy(state) ? state : IDLE_TX;
  }
}

export function isBusy(s: TxState): boolean {
  return s.phase === "signing" || s.phase === "pending";
}
