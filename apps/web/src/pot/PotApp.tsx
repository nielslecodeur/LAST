import { useMemo } from "react";
import { formatNear } from "../lib/amounts";
import { formatCountdown, formatDuration } from "../lib/countdown";
import { shortAccount } from "../lib/game";
import { CrownIcon, cx } from "../components/ui";
import { PotReader, type PotRound } from "./potReader";
import { usePot } from "./usePot";

const env = import.meta.env as Record<string, string | undefined>;
export const POT_ID = (env.VITE_POT_ID ?? "").trim() || "pot.heavycat9990.near";
const TRADE_URL = (env.VITE_TOKEN_TRADE_URL ?? "").trim();
const REPO_URL = "https://github.com/nielslecodeur/LAST";
const EXPLORER = "https://nearblocks.io";

const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;
const txUrl = (h: string) => `${EXPLORER}/txns/${h}`;

function Ext({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx("underline decoration-line underline-offset-4 hover:text-acid hover:decoration-acid", className)}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function BuyButton({ tokenId, className }: { tokenId: string | null; className?: string }) {
  const href = TRADE_URL || (tokenId ? `${EXPLORER}/token/${tokenId}` : "");
  if (!href) {
    return <span className={cx("inline-flex items-center gap-2 border-2 border-line bg-panel-2 px-4 py-2 font-semibold text-mute", className)}>Token launching soon</span>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx("hard press inline-flex items-center gap-2 bg-acid px-4 py-2 font-semibold text-panel-2", className)}>
      <CrownIcon className="h-4 w-4" /> Buy $LAST{TRADE_URL ? " on Nearly" : ""}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function PotApp() {
  const reader = useMemo(() => new PotReader(POT_ID), []);
  const { state, config, rounds, error, remaining } = usePot(reader);

  const min = config ? formatNear(config.minEligibleBuy, 2) : "0.5";
  const dur = config ? formatDuration(config.roundDurationNs) : "60 min";
  const share = config ? config.winnerShareBps / 100 : 90;
  const status = state?.status ?? null;
  const closing = status === "ACTIVE" && remaining === 0;
  const urgent = status === "ACTIVE" && remaining > 0 && remaining < 5 * 60_000;
  const digits =
    status === "ACTIVE" ? formatCountdown(remaining) : status === "EXPIRED" ? "00:00" : config ? formatCountdown(Number(config.roundDurationNs / 1_000_000n)) : "--:--";

  return (
    <div id="top">
      <header className="sticky top-0 z-30 border-b-2 border-text bg-ink">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <a href="#top" className="flex items-center gap-2" aria-label="$LAST home">
            <CrownIcon className="h-7 w-7 text-acid" />
            <span className="font-poster riso text-3xl leading-none">$LAST</span>
          </a>
          <div className="flex items-center gap-2">
            <span className="hidden border border-text bg-panel-2 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider sm:inline">NEAR mainnet</span>
            <span className={cx("border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider", error && !state ? "border-heat bg-heat text-panel-2" : state ? "border-acid bg-acid text-panel-2" : "border-line bg-panel-2 text-mute")}>
              {error && !state ? "RPC error" : state ? "Live" : "Connecting…"}
            </span>
            <div className="hidden sm:block">
              <BuyButton tokenId={config?.tokenId ?? null} className="text-sm" />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:py-10">
        {/* Round */}
        <section aria-labelledby="round-title" className="hard bg-panel">
          <h1 id="round-title" className="sr-only">$LAST jackpot round</h1>
          <div className="flex flex-wrap items-center gap-2 border-b-2 border-text px-5 py-3 sm:px-7">
            <span className={cx("border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider", status === "ACTIVE" ? "border-acid bg-acid text-panel-2" : status === "EXPIRED" ? "border-heat bg-heat text-panel-2" : "border-text bg-panel-2")}>
              {status === "ACTIVE" ? (closing ? "Closing · waiting for the chain" : "Round live") : status === "EXPIRED" ? "Ended · paying the winner" : status === "IDLE" ? "Waiting for the first buy" : "Loading"}
            </span>
            {state && <span className="border border-text bg-panel-2 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider">Round #{state.roundId.toString()}</span>}
            <span className="border border-text bg-panel-2 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider">Timer {dur}</span>
          </div>

          <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-mute">Time left</div>
              <div
                role="timer"
                aria-label={status === "ACTIVE" ? `Time left, estimated: ${digits}` : undefined}
                className={cx(
                  "font-poster text-[24vw] leading-[0.9] tabular sm:text-[9rem] lg:text-[10rem]",
                  status === "IDLE" || !status ? "text-text/25" : urgent ? "anim-urgent text-heat" : status === "EXPIRED" ? "text-heat" : "text-text",
                )}
              >
                {digits}
              </div>
              <p className="mt-2 max-w-xl text-sm">
                {status === "IDLE"
                  ? `No round running. The first buy of at least ${min} NEAR starts the ${dur} countdown and takes the crown.`
                  : status === "EXPIRED"
                    ? "The timer hit zero on-chain. The round is being settled and the winner paid automatically."
                    : `Any buy of at least ${min} NEAR takes the crown and resets the timer to ${dur}.`}
              </p>
            </div>

            <div className="space-y-4 lg:col-span-2">
              <div className="hard bg-panel-2 p-4 sm:-rotate-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-mute">Jackpot</div>
                <div className="flex items-baseline gap-2">
                  <span className="font-poster text-5xl tabular text-acid">{state ? formatNear(state.pot, 4) : "—"}</span>
                  <span className="font-poster text-lg">NEAR</span>
                </div>
                <div className="mt-1 text-xs text-mute">
                  Winner gets {share}%: <span className="font-mono text-text">{state ? `${formatNear(state.prizeIfSettledNow, 4)} NEAR` : "—"}</span> right now. Grows with every trade.
                </div>
              </div>

              <div className={cx("hard flex items-center gap-3 p-4 sm:rotate-1", state?.leader ? "bg-flame" : "bg-panel-2")}>
                <div className={cx("grid h-12 w-12 shrink-0 place-items-center border-2 border-text", state?.leader ? "bg-acid text-panel-2" : "bg-panel text-line")}>
                  <CrownIcon className="h-7 w-7" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-mute">{status === "EXPIRED" ? "Winner" : "Crown holder"}</div>
                  <div className="truncate font-mono text-lg font-semibold">
                    {state?.leader ? <Ext href={accountUrl(state.leader)}>{shortAccount(state.leader, 28)}</Ext> : <span className="text-mute">Nobody yet</span>}
                  </div>
                  {state?.lastTxHash && (
                    <div className="text-xs">
                      <Ext href={txUrl(state.lastTxHash)}>Crown buy transaction</Ext> · {state.eligibleBuys} crown buy{state.eligibleBuys === 1 ? "" : "s"} this round
                    </div>
                  )}
                </div>
              </div>

              <BuyButton tokenId={config?.tokenId ?? null} className="w-full justify-center py-3 text-base" />
            </div>
          </div>
        </section>

        {/* How to play */}
        <section className="hard bg-panel p-5 sm:p-7">
          <h2 className="font-poster mb-4 text-2xl uppercase">How it works</h2>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Buy $LAST", `Buy at least ${min} NEAR of $LAST in its pool. You take the crown.`],
              ["Reset the clock", `Every crown buy restarts the ${dur} countdown. Smaller buys don't touch the crown.`],
              ["Hold the crown", "If nobody buys before zero, the last crown holder wins the round."],
              ["Get paid", `${share}% of the jackpot is sent to the winner automatically. ${100 - share}% seeds the next round.`],
            ].map(([t, d], i) => (
              <li key={t} className="border-2 border-text bg-panel-2 p-4">
                <div className="font-poster text-3xl text-acid">0{i + 1}</div>
                <div className="mt-1 font-semibold">{t}</div>
                <p className="mt-1 text-sm text-mute">{d}</p>
              </li>
            ))}
          </ol>
        </section>

        <div className="grid gap-6 lg:grid-cols-5">
          {/* Past rounds */}
          <section className="hard bg-panel p-5 sm:p-7 lg:col-span-3">
            <h2 className="font-poster mb-4 text-2xl uppercase">Past rounds</h2>
            {rounds.length === 0 ? (
              <p className="text-sm text-mute">No round settled yet. The first winner will show up here with the payout status.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-mute">
                    <tr>
                      <th className="py-1 pr-3">Round</th>
                      <th className="py-1 pr-3">Winner</th>
                      <th className="py-1 pr-3">Prize</th>
                      <th className="py-1 pr-3">Payout</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rounds.map((r: PotRound) => (
                      <tr key={r.roundId.toString()} className="border-t border-line">
                        <td className="py-2 pr-3 font-mono">#{r.roundId.toString()}</td>
                        <td className="py-2 pr-3 font-mono">
                          <Ext href={accountUrl(r.winner)}>{shortAccount(r.winner, 20)}</Ext>
                        </td>
                        <td className="py-2 pr-3 font-mono">{formatNear(r.prize, 4)} NEAR</td>
                        <td className="py-2 pr-3">
                          <span className={cx("border px-1.5 py-0.5 font-mono text-[10px] font-semibold", r.status === "PAID" ? "border-acid bg-acid text-panel-2" : "border-text bg-panel-2")}>
                            {r.status === "IN_FLIGHT" ? "SENDING" : r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Transparency */}
          <section className="hard bg-panel p-5 text-sm sm:p-7 lg:col-span-2">
            <h2 className="font-poster mb-4 text-2xl uppercase">On-chain</h2>
            <ul className="space-y-2">
              <li>
                Jackpot contract: <Ext href={accountUrl(POT_ID)} className="font-mono">{POT_ID}</Ext>
              </li>
              {config?.tokenId && (
                <li>
                  Token: <Ext href={`${EXPLORER}/token/${config.tokenId}`} className="font-mono">{shortAccount(config.tokenId, 30)}</Ext>
                </li>
              )}
              <li>Total paid to winners: <span className="font-mono">{state ? formatNear(state.totalPaid, 4) : "—"} NEAR</span></li>
              <li>Crown buys recorded: <span className="font-mono">{state ? state.totalBuysRecorded.toString() : "—"}</span></li>
            </ul>
            <p className="mt-4 text-xs text-mute">
              Trading fees and tax from the $LAST pool are sent to the jackpot contract every few minutes. Crown buys are recorded by
              {" "}<span className="font-mono">{config ? config.reporterId : "the reporter"}</span>, each with its transaction hash so anyone can check it.
              Nobody can withdraw the jackpot: it only leaves the contract as a prize.
            </p>
          </section>
        </div>
      </main>

      <footer className="border-t-2 border-text">
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-6 text-xs text-mute sm:px-6">
          <p>
            <strong className="text-text">Experimental and unaudited.</strong> Bots and multiple wallets can play. Price moves, fees and
            transaction ordering can cause losses. Only risk what you can afford to lose. Countdown is estimated from chain time; the
            contract alone decides when a round ends.
          </p>
          <p>
            Source code: <Ext href={REPO_URL}>github.com/nielslecodeur/LAST</Ext> · MIT license
            {error && state ? <span className="text-heat"> · RPC hiccup, retrying ({error.slice(0, 80)})</span> : null}
          </p>
        </div>
      </footer>
    </div>
  );
}
