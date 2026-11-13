import { useEffect } from "react";
import { explorerTxUrl } from "../config";
import { useLast } from "../hooks/useLast";
import type { TxPhase } from "../lib/txMachine";
import { Button, ExternalLink, cx } from "./ui";

const TEXT: Record<Exclude<TxPhase, "idle">, string> = {
  signing: "Confirm in your wallet…",
  pending: "Executed — verifying contract state…",
  confirmed: "Confirmed on-chain",
  unresolved: "Submitted — not final yet",
  failed: "Transaction failed",
  rejected: "Rejected in wallet",
};

const BORDER: Record<Exclude<TxPhase, "idle">, string> = {
  signing: "border-gold/60",
  pending: "border-gold/60",
  confirmed: "border-acid/60",
  unresolved: "border-gold/60",
  failed: "border-heat/60",
  rejected: "border-line",
};

export function TxToast() {
  const { tx, resetTx, simulated, config } = useLast();

  useEffect(() => {
    if (tx.phase === "confirmed" || tx.phase === "rejected") {
      const t = setTimeout(resetTx, 7_000);
      return () => clearTimeout(t);
    }
  }, [tx.phase, resetTx]);

  if (tx.phase === "idle") return null;
  const busy = tx.phase === "signing" || tx.phase === "pending";
  const text = tx.auto && tx.phase === "signing" ? "Auto mode — signing with your session key…" : TEXT[tx.phase];
  const title = simulated ? text.replace(" on-chain", "") : text;

  return (
    <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-4 z-50 sm:inset-x-auto sm:right-6 sm:w-96">
      <div className={cx("rounded-2xl border bg-panel/95 p-4 shadow-2xl backdrop-blur", BORDER[tx.phase])}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold">
              {busy && <span className="h-2 w-2 animate-pulse rounded-full bg-gold" aria-hidden />}
              {title}
              {simulated && <span className="font-mono text-[10px] text-heat">SIMULATED</span>}
            </div>
            <div className="mt-0.5 truncate text-sm text-mute">{tx.label}</div>
            {tx.note && <div className={cx("mt-1 text-sm", tx.phase === "confirmed" ? "text-acid" : "text-gold")}>{tx.note}</div>}
            {tx.error && (
              <div className="mt-1 text-sm text-heat">
                {tx.error.message}
                {tx.error.code && <span className="ml-1 font-mono text-xs">({tx.error.code})</span>}
              </div>
            )}
            {tx.hash && !simulated && (
              <ExternalLink href={explorerTxUrl(tx.hash, config.explorerUrl)} className="mt-1 inline-block font-mono text-xs">
                View on explorer
              </ExternalLink>
            )}
          </div>
          {!busy && (
            <Button variant="ghost" className="px-2 py-1 text-sm" onClick={resetTx} aria-label="Dismiss">
              ✕
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
