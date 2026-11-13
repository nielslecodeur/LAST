import type { ReactNode } from "react";
import { useLast } from "../hooks/useLast";

/** Always-visible truth about where the numbers come from. */
export function StatusBanner() {
  return (
    <>
      <SourceBanner />
      <WalletBanner />
    </>
  );
}

/** Wallet-level problems: wrong network, or a transaction interrupted by a page reload. */
function WalletBanner() {
  const { walletError, interrupted, dismissInterrupted, accountId } = useLast();
  if (walletError) return <Banner tone="heat" title="Wrong network">{walletError}</Banner>;
  if (interrupted && (!interrupted.accountId || interrupted.accountId === accountId || !accountId)) {
    return (
      <Banner tone="gold" title="Interrupted transaction">
        "{interrupted.label}" was waiting for your wallet when the page was reloaded. Its outcome is unknown to this page: it may or may
        not have been sent. Balances below are re-read from the chain — check your wallet history or the explorer before retrying.{" "}
        <button className="underline" onClick={dismissInterrupted}>
          Dismiss
        </button>
      </Banner>
    );
  }
  return null;
}

function SourceBanner() {
  const { deployment, simulated, rpcError, config, lastUpdatedMs } = useLast();

  if (deployment === "checking") return null; // brief: the top bar shows CHECKING…
  if (simulated) {
    return (
      <Banner tone="heat" title="SIMULATED — local UI development only">
        Every number on this page is generated in your browser by a local simulation. Nothing is on-chain, nothing is real.
        Run without <code className="font-mono">--mode mock</code> to read the real testnet contract.
      </Banner>
    );
  }
  if (deployment === "wrong_network") {
    return <Banner tone="heat" title="Wrong network — refused">{rpcError} $LAST runs on NEAR Testnet only; nothing is read from this endpoint.</Banner>;
  }
  if (deployment === "config_error") {
    return <Banner tone="heat" title="Configuration refused">{config.configError}</Banner>;
  }
  if (deployment === "not_configured" || deployment === "no_account" || deployment === "no_code") {
    const detail =
      deployment === "no_account"
        ? `Account ${config.contractId} does not exist on NEAR Testnet yet.`
        : deployment === "no_code"
          ? `Account ${config.contractId} exists but has no contract code.`
          : "No contract id configured (VITE_LAST_CONTRACT_ID).";
    return (
      <Banner tone="mute" title="CONTRACT NOT DEPLOYED">
        {detail} The $LAST contract has not been deployed to testnet yet, so there is no live data to show and every
        blockchain action is disabled. No figures on this page are invented.
      </Banner>
    );
  }
  if (deployment === "probe_failed") {
    return (
      <Banner tone="heat" title="Cannot reach NEAR Testnet RPC">
        {rpcError ?? "Unknown error"} — retrying automatically; nothing is shown until the contract answers.
      </Banner>
    );
  }
  if (rpcError) {
    const age = lastUpdatedMs ? Math.round((Date.now() - lastUpdatedMs) / 1000) : null;
    return (
      <Banner tone="gold" title="RPC error — data may be stale">
        {rpcError}
        {age !== null && ` Last successful update ${age}s ago.`} Values below are the last real contract reads; retrying automatically.
      </Banner>
    );
  }
  return null;
}

function Banner({ tone, title, children }: { tone: "heat" | "mute" | "gold"; title: string; children: ReactNode }) {
  const tones = {
    heat: "border-heat/50 bg-heat/10",
    gold: "border-gold/50 bg-gold/10",
    mute: "border-line bg-panel-2",
  } as const;
  const titleTone = { heat: "text-heat", gold: "text-gold", mute: "text-text" } as const;
  return (
    <div role="status" className={`mx-auto mt-4 max-w-7xl px-4 sm:px-6`}>
      <div className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
        <strong className={`mr-2 font-mono text-xs font-extrabold uppercase tracking-wider ${titleTone[tone]}`}>{title}</strong>
        <span className="text-text/85">{children}</span>
      </div>
    </div>
  );
}
