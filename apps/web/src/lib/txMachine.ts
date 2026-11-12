/**
 * Transaction lifecycle, independent of React:
 *
 *   idle → signing → pending → confirmed
 *              │         └──→ failed
 *              └──→ rejected | failed
 *
 * - signing:   waiting for the wallet (user approval + broadcast + execution).
 * - pending:   the wallet returned a successful outcome; we are re-reading contract views so the
 *              UI shows *confirmed state*, not an optimistic guess (SPEC §1.2: no optimistic
 *              winner update).
 * - confirmed: outcome succeeded and views were refreshed.
 */

import type { UiError } from "./errors";
import type { TxKind } from "./transactions";

export type TxPhase = "idle" | "signing" | "pending" | "confirmed" | "failed" | "rejected";

export interface TxState {
  phase: TxPhase;
  kind: TxKind | null;
  label: string | null;
  hash: string | null;
  error: UiError | null;
}

export type TxEvent =
  | { type: "SIGN"; kind: TxKind; label: string }
  | { type: "OUTCOME_OK"; hash: string | null }
  | { type: "OUTCOME_FAILED"; hash: string | null; error: UiError }
  | { type: "THROWN"; error: UiError }
  | { type: "RECONCILED" }
  | { type: "RESET" };

export const IDLE_TX: TxState = { phase: "idle", kind: null, label: null, hash: null, error: null };

export function txReducer(state: TxState, ev: TxEvent): TxState {
  switch (ev.type) {
    case "SIGN":
      if (isBusy(state)) return state; // one transaction at a time
      return { phase: "signing", kind: ev.kind, label: ev.label, hash: null, error: null };
    case "OUTCOME_OK":
      return state.phase === "signing" ? { ...state, phase: "pending", hash: ev.hash } : state;
    case "OUTCOME_FAILED":
      return state.phase === "signing" ? { ...state, phase: "failed", hash: ev.hash, error: ev.error } : state;
    case "THROWN":
      if (state.phase !== "signing") return state;
      return { ...state, phase: ev.error.kind === "rejected" ? "rejected" : "failed", error: ev.error };
    case "RECONCILED":
      return state.phase === "pending" ? { ...state, phase: "confirmed" } : state;
    case "RESET":
      return isBusy(state) ? state : IDLE_TX;
  }
}

export function isBusy(s: TxState): boolean {
  return s.phase === "signing" || s.phase === "pending";
}
