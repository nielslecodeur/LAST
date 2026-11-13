import { useState } from "react";
import { useLast } from "../hooks/useLast";
import { NEAR_DECIMALS, formatNear, tryParseUnits } from "../lib/amounts";
import { buildDepositTx } from "../lib/transactions";
import { isBusy } from "../lib/txMachine";
import { Badge, Button, cx } from "./ui";

const PRESETS = ["0.2", "0.5", "1"];

/**
 * Instant trading (the default way to play): ONE wallet signature adds a limited session key and,
 * on a v0.4 contract, fills the play balance. Buys, sells, settles and claims then run with no
 * wallet popup. Only topping up and withdrawing go through the wallet.
 */
export function InstantTradingCard() {
  const { autoMode, enableAuto, disableAuto, accountId, walletError, tx, run, capabilities, deployed, reader, simulated, account, storage } = useLast();
  const [amount, setAmount] = useState("0.5");
  if (!deployed || !accountId || walletError || !capabilities.settleRound || autoMode.state === "none") return null;

  const busy = isBusy(tx);
  const on = autoMode.state === "on";
  const trading = capabilities.playBalance;
  const deposit = tryParseUnits(amount, NEAR_DECIMALS);
  const balance = account?.creditAvailable ?? null;

  const topUp = () => {
    if (!reader || !deposit) return;
    const needsStorage = account !== null && !account.registered;
    void run(
      buildDepositTx({
        contractId: reader.contractId,
        amount: deposit,
        storageDeposit: needsStorage ? (storage?.min ?? null) : null,
        label: `Add ${amount} NEAR to play balance`,
      }),
    );
  };

  const amountPicker = trading && (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => (
        <button
          key={p}
          onClick={() => setAmount(p)}
          className={cx(
            "rounded-lg border px-3 py-1.5 font-mono text-xs font-bold",
            amount === p ? "border-acid bg-acid/15 text-acid" : "border-line text-mute hover:text-text",
          )}
        >
          {p} NEAR
        </button>
      ))}
      <input
        aria-label="Play balance amount"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-20 rounded-lg border border-line bg-transparent px-2 py-1.5 font-mono text-xs outline-none focus:border-acid"
      />
    </div>
  );

  if (autoMode.state === "unsupported") {
    return (
      <p className="mb-4 rounded-xl border border-gold/40 bg-gold/10 p-3 text-xs text-gold">
        Instant trading needs Ed25519 WebCrypto (recent Chrome, Firefox or Safari). You can still trade with a wallet signature per trade.
      </p>
    );
  }

  if (!on) {
    return (
      <div className="mb-4 rounded-2xl border-2 border-acid/60 bg-acid/10 p-4">
        <div className="flex items-center gap-2 text-lg font-extrabold">
          ⚡ {trading ? "Instant trading" : "Auto-settle & claim"}
          <Badge tone="mute">{autoMode.state === "checking" ? "…" : "OFF"}</Badge>
        </div>
        <p className="mt-1 text-sm text-text/85">
          {trading
            ? "One signature, then every buy and sell is instant — no wallet popup. Rounds settle and prizes pay out automatically."
            : "One signature, then rounds settle and your prizes are paid automatically, with no wallet popup."}
        </p>
        {amountPicker}
        <Button
          className="mt-3 w-full py-3.5 text-base"
          disabled={busy || autoMode.state === "checking" || (trading && !deposit)}
          onClick={() => void enableAuto(trading ? (deposit ?? 0n) : 0n)}
        >
          {busy && tx.kind !== "buy" && tx.kind !== "sell" ? "Confirm in wallet…" : trading ? `Enable — 1 signature${deposit ? ` · ${amount} NEAR balance` : ""}` : "Enable — 1 signature"}
        </Button>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {simulated
            ? "SIMULATED: no key is created; actions run against the local simulation."
            : <>Adds a key to your account kept only in this browser (non-exportable). It can call only settle / claim{trading ? " / buy-from-balance / sell-to-balance" : ""} on <span className="font-mono">{reader?.contractId}</span> and attach no NEAR: it can never send your NEAR or LAST to anyone. Gas comes from a 0.25 NEAR budget. Withdrawing your balance always asks your wallet.</>}
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-acid/60 bg-acid/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-bold">
          ⚡ {trading ? "Instant trading" : "Auto-settle & claim"} <Badge tone="acid">ON</Badge>
        </div>
        <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => void disableAuto()}>
          Turn off
        </Button>
      </div>
      {trading && (
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-mute">
            Play balance{" "}
            <span className="font-mono text-lg font-extrabold text-text">{balance === null ? "…" : `${formatNear(balance, 4)} NEAR`}</span>
          </span>
          <span className="flex items-center gap-2">
            <Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={busy || !deposit} onClick={topUp}>
              + {amount} NEAR
            </Button>
          </span>
        </div>
      )}
      <p className="mt-1 text-[11px] text-mute">
        {trading ? "Buys and sells use your play balance with no popup. " : "Buys still ask your wallet on this contract version. "}
        {autoMode.allowance !== null && <>Gas budget left: <span className="font-mono">{formatNear(autoMode.allowance, 4)} NEAR</span>.</>}
      </p>
    </div>
  );
}
