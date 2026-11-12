import { useEffect } from "react";
import { explorerTxUrl } from "../config";
import { useLast } from "../hooks/useLast";
import { Button, ExternalLink, cx } from "./ui";

const TEXT = {
  signing: "Confirm in your wallet…",
  pending: "Executed on-chain — syncing contract state…",
  confirmed: "Confirmed on-chain",
  failed: "Transaction failed",
  rejected: "Rejected in wallet",
} as const;

export function TxToast() {
  const { tx, resetTx, simulated, config } = useLast();

  useEffect(() => {
    if (tx.phase === "confirmed" || tx.phase === "rejected") {
      const t = setTimeout(resetTx, 6_000);
      return () => clearTimeout(t);
    }
  }, [tx.phase, resetTx]);

  if (tx.phase === "idle") return null;
  const tone =
    tx.phase === "confirmed" ? "border-acid/60" : tx.phase === "failed" ? "border-heat/60" : tx.phase === "rejected" ? "border-line" : "border-gold/60";

  return (
    <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-4 z-50 sm:inset-x-auto sm:right-6 sm:w-96">
      <div className={cx("rounded-2xl border bg-panel/95 p-4 shadow-2xl backdrop-blur", tone)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold">
              {(tx.phase === "signing" || tx.phase === "pending") && <span className="h-2 w-2 animate-pulse rounded-full bg-gold" aria-hidden />}
              {simulated ? TEXT[tx.phase].replace(" on-chain", "") : TEXT[tx.phase]}
              {simulated && <span className="font-mono text-[10px] text-heat">SIMULATED</span>}
            </div>
            <div className="mt-0.5 truncate text-sm text-mute">{tx.label}</div>
            {tx.error && <div className="mt-1 text-sm text-heat">{tx.error.message}{tx.error.code && <span className="ml-1 font-mono text-xs">({tx.error.code})</span>}</div>}
            {tx.hash && !simulated && (
              <ExternalLink href={explorerTxUrl(tx.hash, config.explorerUrl)} className="mt-1 inline-block font-mono text-xs">
                View on explorer
              </ExternalLink>
            )}
          </div>
          {tx.phase !== "signing" && tx.phase !== "pending" && (
            <Button variant="ghost" className="px-2 py-1 text-sm" onClick={resetTx} aria-label="Dismiss">
              ✕
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
