/**
 * Marker for a transaction that was waiting for the wallet when the page was reloaded or closed.
 * Its outcome is unknown to this page (the wallet may still have sent it), so after a reload we
 * show an honest notice — the balances shown are re-read from the chain anyway.
 * sessionStorage only, wrapped: it may be unavailable (private mode, blocked storage).
 */

const KEY = "last:pending-tx";

export interface PendingTxMarker {
  label: string;
  accountId: string | null;
  at: number;
}

export function markPending(m: PendingTxMarker): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable: nothing to recover later, acceptable */
  }
}

export function clearPending(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Reads and clears a marker left by a previous page load (max 1 h old). */
export function takeInterrupted(now = Date.now()): PendingTxMarker | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as PendingTxMarker;
    if (typeof m.label !== "string" || typeof m.at !== "number" || now - m.at > 3_600_000) return null;
    return m;
  } catch {
    return null;
  }
}
