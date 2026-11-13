import { useCallback, useEffect, useMemo, useState } from "react";
import { useLast } from "../hooks/useLast";
import { useQuote } from "../hooks/useQuote";
import {
  LAST_DECIMALS,
  NEAR_DECIMALS,
  formatBps,
  formatCompact,
  formatLast,
  formatNear,
  formatUnits,
  tryParseUnits,
} from "../lib/amounts";
import { HIGH_IMPACT_BPS, buyPriceImpactBps, maxGasCost, sellPriceImpactBps } from "../lib/pricing";
import { DEFAULT_SLIPPAGE_BPS, SLIPPAGE_PRESETS_BPS, applySlippage, parseSlippagePercent } from "../lib/slippage";
import { GAS, buildBuyTx, buildSellTx } from "../lib/transactions";
import { isBusy } from "../lib/txMachine";
import type { BuyQuote, SellQuote } from "../lib/types";
import { BLOCKER_TEXT, type Blocker, checkBuy, checkSell } from "../lib/validation";
import type { Deployment } from "../hooks/useLast";

/** While the contract is being probed, "not deployed" would be a false statement. */
function blockerText(b: Blocker, deployment: Deployment): string {
  return b === "NOT_DEPLOYED" && deployment === "checking" ? "Connecting to contract…" : BLOCKER_TEXT[b];
}
import { PREFILL_BUY_EVENT } from "./Hero";
import { Button, Card, CrownIcon, Row, cx } from "./ui";

type Side = "buy" | "sell";

export function TradePanel() {
  const [side, setSide] = useState<Side>("buy");
  const [slippageBps, setSlippageBps] = useState<bigint>(DEFAULT_SLIPPAGE_BPS);
  const [prefill, setPrefill] = useState<{ value: string; n: number } | null>(null);
  const { account, nearBalance, accountId, walletError } = useLast();

  useEffect(() => {
    const onPrefill = (e: Event) => {
      setSide("buy");
      setPrefill((p) => ({ value: String((e as CustomEvent).detail ?? ""), n: (p?.n ?? 0) + 1 }));
    };
    window.addEventListener(PREFILL_BUY_EVENT, onPrefill);
    return () => window.removeEventListener(PREFILL_BUY_EVENT, onPrefill);
  }, []);

  return (
    <Card id="trade" title="Trade" aside={<SlippageControl value={slippageBps} onChange={setSlippageBps} />} className="h-full">
      <div role="tablist" aria-label="Trade side" className="grid grid-cols-2 gap-1 rounded-xl bg-panel-2 p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={side === s}
            onClick={() => setSide(s)}
            className={cx(
              "rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider transition-colors",
              side === s ? (s === "buy" ? "bg-acid text-ink" : "bg-text text-ink") : "text-mute hover:text-text",
            )}
          >
            {s === "buy" ? "Buy LAST" : "Sell LAST"}
          </button>
        ))}
      </div>

      {walletError && <p className="mt-4 rounded-lg border border-heat/50 bg-heat/10 px-3 py-2 text-sm text-heat">{walletError}</p>}

      {accountId && !walletError && (
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <Balance label="NEAR available" value={nearBalance === null ? null : formatNear(nearBalance, 4)} />
          <Balance label="LAST balance" value={account ? formatLast(account.lastBalance) : null} />
        </div>
      )}

      <div className="mt-4">
        {side === "buy" ? <BuyForm slippageBps={slippageBps} prefill={prefill} /> : <SellForm slippageBps={slippageBps} />}
      </div>
    </Card>
  );
}

function Balance({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border border-line/70 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-mute">{label}</div>
      <div className="font-mono font-bold tabular">{value ?? "…"}</div>
    </div>
  );
}

/** NEAR network fee, shown apart from the LAST market fee. */
function GasRow({ gas }: { gas: bigint }) {
  const { gasPrice } = useLast();
  return (
    <Row
      label="NEAR network gas (max, unused refunded)"
      value={gasPrice === null ? "—" : `≤ ${formatCompact(maxGasCost(gas, gasPrice), 24, 2)} NEAR`}
    />
  );
}

function ImpactRow({ bps }: { bps: bigint | null }) {
  if (bps === null) return <Row label="Price impact" value="—" />;
  const high = bps >= HIGH_IMPACT_BPS;
  return <Row label="Price impact" value={<span className={high ? "text-heat" : undefined}>{formatBps(bps)}</span>} />;
}

// ------------------------------------------------------------------ Buy

function BuyForm({ slippageBps, prefill }: { slippageBps: bigint; prefill: { value: string; n: number } | null }) {
  const { reader, market, game, account, nearBalance, storage, accountId, walletError, deployed, deployment, tx, run, connect } = useLast();
  const [input, setInput] = useState("");
  useEffect(() => {
    if (prefill) setInput(prefill.value);
  }, [prefill]);
  const gross = tryParseUnits(input, NEAR_DECIMALS);
  const invalid = input.trim() !== "" && gross === null;

  const fetcher = useCallback((a: bigint) => reader!.quoteBuy(a), [reader]);
  const marketKey = market ? `${market.nearReserve}:${market.lastInventory}` : "";
  const { quote, loading, error } = useQuote<BuyQuote>(deployed && reader ? fetcher : null, gross, marketKey);

  const check = checkBuy({
    deployed,
    accountId,
    status: game?.status ?? null,
    gross,
    quote,
    nearBalance,
    account,
    storage,
    minEligibleBuy: market?.minEligibleBuy ?? null,
  });
  const blocker = walletError ? "Wrong network" : check.blocker ? blockerText(check.blocker, deployment) : null;
  const minOut = quote ? applySlippage(quote.tokensOut, slippageBps) : null;
  const impact = quote && market ? buyPriceImpactBps(market.nearReserve, market.lastInventory, quote.netNear, quote.tokensOut) : null;
  const presets = useMemo(() => {
    const min = market?.minEligibleBuy;
    return min ? [min, min * 5n, min * 20n] : [];
  }, [market?.minEligibleBuy]);
  const gas = check.storageDeposit !== null ? GAS.storageDeposit + GAS.buy : GAS.buy;

  const submit = async () => {
    if (!reader || !quote || minOut === null || gross === null || blocker || !accountId) return;
    // Polled data can be stale (RPC hiccup): re-read registration right before signing, so an
    // already registered account never sends a needless storage_deposit (Gate 4 finding).
    let storageDeposit = check.storageDeposit;
    if (storageDeposit !== null) {
      try {
        if ((await reader.getAccountState(accountId)).registered) storageDeposit = null;
      } catch {
        /* keep it: a redundant registration is refunded by the contract, a missing one fails the buy */
      }
    }
    const ok = await run(
      buildBuyTx({
        contractId: reader.contractId,
        grossYocto: gross,
        minTokensOut: minOut,
        storageDeposit,
        label: `${quote.eligible ? "Crown buy" : "Token buy"}: ${formatCompact(quote.tokensOut, LAST_DECIMALS)} LAST for ${formatNear(gross)} NEAR`,
      }),
    );
    if (ok) setInput("");
  };

  return (
    <div className="space-y-4">
      <AmountInput id="buy-amount" label="You pay" unit="NEAR" value={input} onChange={setInput} invalid={invalid} disabled={!deployed} />
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {presets.map((p, i) => (
            <button
              key={p.toString()}
              onClick={() => setInput(formatUnits(p, NEAR_DECIMALS, { group: false }))}
              disabled={!deployed}
              className="rounded-lg border border-line px-3 py-1.5 font-mono text-xs font-bold text-mute hover:border-acid/60 hover:text-text disabled:opacity-40"
            >
              {i === 0 ? `MIN ${formatCompact(p, 24)}` : formatCompact(p, 24)}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-line bg-panel-2/60 p-3">
        <Row label="You receive (est.)" strong value={quote ? `${formatLast(quote.tokensOut)} LAST` : loading ? "Quoting…" : "—"} />
        <Row label={`LAST market fee (${market ? formatBps(market.buyFeeBps) : "4%"})`} value={quote ? `${formatNear(quote.fee, 6)} NEAR` : "—"} />
        <ImpactRow bps={impact} />
        <Row label={`Min received (${formatBps(slippageBps)} slippage)`} value={minOut !== null ? `${formatLast(minOut)} LAST` : "—"} />
        {check.storageDeposit !== null && <Row label="Storage registration (once)" value={`${formatNear(check.storageDeposit, 6)} NEAR`} />}
        <GasRow gas={gas} />
        {quote && (
          <div className={cx("mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold", quote.eligible ? "bg-acid/10 text-acid" : "bg-gold/10 text-gold")}>
            <CrownIcon className="h-4 w-4 shrink-0" />
            {quote.eligible ? "Steals the crown & resets the timer" : "Below the minimum — tokens only, no crown"}
          </div>
        )}
        {error && <p className="mt-2 text-sm text-heat">Quote failed: {error}</p>}
      </div>

      {(check.warnings.length > 0 || (impact !== null && impact >= HIGH_IMPACT_BPS)) && (
        <ul className="space-y-1 text-xs text-gold/90">
          {impact !== null && impact >= HIGH_IMPACT_BPS && <li>• High price impact ({formatBps(impact)}): the testnet pool is thin, a smaller buy gets a better price.</li>}
          {check.warnings.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
      )}
      {check.blocker === "INSUFFICIENT_NEAR" && (
        <p className="text-xs text-mute">Need testnet NEAR? Use a NEAR testnet faucet — testnet tokens have no value.</p>
      )}

      {!accountId && deployed ? (
        <Button className="w-full py-4 text-base" onClick={() => void connect()}>
          Connect wallet to buy
        </Button>
      ) : (
        <Button className="w-full py-4 text-base" disabled={blocker !== null || isBusy(tx) || minOut === null} onClick={() => void submit()}>
          {isBusy(tx) && tx.kind === "buy" ? "Confirm in wallet…" : blocker ?? (quote?.eligible ? "Buy LAST & steal the crown" : "Buy LAST")}
        </Button>
      )}
      <p className="text-[11px] leading-relaxed text-mute">
        Only buys through LAST's own market count. The contract re-checks everything; a buy confirmed at or after the deadline is rejected.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ Sell

function SellForm({ slippageBps }: { slippageBps: bigint }) {
  const { reader, market, game, account, accountId, walletError, deployed, deployment, tx, run, connect } = useLast();
  const [input, setInput] = useState("");
  const tokensIn = tryParseUnits(input, LAST_DECIMALS);
  const invalid = input.trim() !== "" && tokensIn === null;

  const fetcher = useCallback((a: bigint) => reader!.quoteSell(a), [reader]);
  const marketKey = market ? `${market.nearReserve}:${market.lastInventory}` : "";
  const { quote, loading, error } = useQuote<SellQuote>(deployed && reader ? fetcher : null, tokensIn, marketKey);

  const check = checkSell({ deployed, accountId, status: game?.status ?? null, tokensIn, quote, account });
  const blocker = walletError ? "Wrong network" : check ? blockerText(check, deployment) : null;
  const minOut = quote ? applySlippage(quote.payout, slippageBps) : null;
  const impact = quote && market && tokensIn ? sellPriceImpactBps(market.nearReserve, market.lastInventory, tokensIn, quote.grossNearOut) : null;

  const submit = async () => {
    if (!reader || !quote || minOut === null || tokensIn === null || blocker) return;
    const ok = await run(
      buildSellTx({
        contractId: reader.contractId,
        tokensIn,
        minNearOut: minOut,
        label: `Sell ${formatLast(tokensIn)} LAST → ${formatNear(quote.payout)} NEAR credit`,
      }),
    );
    if (ok) setInput("");
  };

  return (
    <div className="space-y-4">
      <AmountInput
        id="sell-amount"
        label="You sell"
        unit="LAST"
        value={input}
        onChange={setInput}
        invalid={invalid}
        disabled={!deployed}
        onMax={account && account.lastBalance > 0n ? () => setInput(formatUnits(account.lastBalance, LAST_DECIMALS, { group: false })) : undefined}
      />

      <div className="rounded-xl border border-line bg-panel-2/60 p-3">
        <Row label="Gross NEAR out" value={quote ? `${formatNear(quote.grossNearOut, 6)} NEAR` : loading ? "Quoting…" : "—"} />
        <Row label={`LAST market fee (${market ? formatBps(market.sellFeeBps) : "2%"})`} value={quote ? `${formatNear(quote.fee, 6)} NEAR` : "—"} />
        <ImpactRow bps={impact} />
        <Row label="NEAR credit (est.)" strong value={quote ? `${formatNear(quote.payout, 6)} NEAR` : "—"} />
        <Row label={`Min credit (${formatBps(slippageBps)} slippage)`} value={minOut !== null ? `${formatNear(minOut, 6)} NEAR` : "—"} />
        <GasRow gas={GAS.sell} />
        {error && <p className="mt-2 text-sm text-heat">Quote failed: {error}</p>}
      </div>

      <div className="rounded-lg border border-sky/30 bg-sky/5 px-3 py-2 text-xs leading-relaxed text-sky">
        Selling never changes the leader or the timer. Proceeds become a <strong>withdrawable NEAR credit</strong> held by the contract —
        withdrawing it is a separate signed transaction.
      </div>

      {!accountId && deployed ? (
        <Button variant="secondary" className="w-full py-4 text-base" onClick={() => void connect()}>
          Connect wallet to sell
        </Button>
      ) : (
        <Button variant="secondary" className="w-full py-4 text-base" disabled={blocker !== null || isBusy(tx) || minOut === null} onClick={() => void submit()}>
          {isBusy(tx) && tx.kind === "sell" ? "Confirm in wallet…" : blocker ?? "Sell LAST"}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ shared

function AmountInput(props: {
  id: string;
  label: string;
  unit: string;
  value: string;
  onChange(v: string): void;
  invalid: boolean;
  disabled?: boolean;
  onMax?: () => void;
}) {
  return (
    <div>
      <label htmlFor={props.id} className="text-xs font-semibold uppercase tracking-wider text-mute">
        {props.label}
      </label>
      <div className={cx("mt-1.5 flex items-center rounded-xl border bg-ink px-4 focus-within:border-acid/70", props.invalid ? "border-heat" : "border-line")}>
        <input
          id={props.id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value.replace(/[^\d.]/g, ""))}
          aria-invalid={props.invalid}
          className="min-w-0 flex-1 bg-transparent py-3.5 font-mono text-2xl font-bold tabular outline-none placeholder:text-line disabled:cursor-not-allowed"
        />
        {props.onMax && (
          <button onClick={props.onMax} className="mr-2 rounded-md border border-line px-2 py-1 font-mono text-[11px] font-bold text-mute hover:text-acid">
            MAX
          </button>
        )}
        <span className="font-mono text-sm font-bold text-mute">{props.unit}</span>
      </div>
      {props.invalid && <p className="mt-1 text-xs text-heat">Invalid amount</p>}
    </div>
  );
}

function SlippageControl({ value, onChange }: { value: bigint; onChange(v: bigint): void }) {
  const [custom, setCustom] = useState("");
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Slippage tolerance">
      <span className="mr-1 hidden text-[11px] uppercase tracking-wider text-mute sm:inline">Slippage</span>
      {SLIPPAGE_PRESETS_BPS.map((p) => (
        <button
          key={p.toString()}
          aria-pressed={value === p && custom === ""}
          onClick={() => {
            setCustom("");
            onChange(p);
          }}
          className={cx("rounded-md px-2 py-1 font-mono text-[11px] font-bold", value === p && custom === "" ? "bg-text text-ink" : "text-mute hover:text-text")}
        >
          {formatBps(p)}
        </button>
      ))}
      <input
        aria-label="Custom slippage percent"
        inputMode="decimal"
        placeholder="%"
        value={custom}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d.]/g, "");
          setCustom(v);
          const bps = parseSlippagePercent(v);
          if (bps !== null) onChange(bps);
        }}
        className="w-12 rounded-md border border-line bg-ink px-1.5 py-1 text-center font-mono text-[11px] outline-none focus:border-acid/70"
      />
    </div>
  );
}
