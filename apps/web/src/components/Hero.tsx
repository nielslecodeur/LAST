import { useEffect, useRef, useState } from "react";
import { explorerAccountUrl } from "../config";
import { useCountdown } from "../hooks/useCountdown";
import { useLast } from "../hooks/useLast";
import { NEAR_DECIMALS, formatCompact, formatNear, formatUnits } from "../lib/amounts";
import { type DisplayPhase, formatCountdown, formatDuration, isUrgent, progressLeft } from "../lib/countdown";
import { detectLeaderChange, detectSettlement, shortAccount } from "../lib/game";
import type { GameState } from "../lib/types";
import { FlameCanvas } from "./FlameCanvas";
import { Badge, Button, CrownIcon, Dash, ExternalLink, cx } from "./ui";

const PHASE_BADGE: Record<DisplayPhase, { tone: "acid" | "heat" | "gold" | "mute"; text: string }> = {
  IDLE: { tone: "mute", text: "IDLE · crown up for grabs" },
  ACTIVE: { tone: "acid", text: "LIVE · round active" },
  CLOSING: { tone: "gold", text: "CLOSING · confirming on-chain" },
  EXPIRED: { tone: "heat", text: "EXPIRED · settlement pending" },
};

/** Ask the trade panel to prefill a buy (decoupled through a DOM event). */
export const PREFILL_BUY_EVENT = "last:prefill-buy";

export function Hero() {
  const { game, market, clock, accountId, deployed, deployment, simulated, config, rounds } = useLast();
  const { remaining, phase } = useCountdown(game, clock);

  // Crown change / settlement → animation + announcement (only on confirmed reads).
  const prev = useRef<GameState | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const [stolen, setStolen] = useState<{ thief: string; from: string } | null>(null);
  const [celebrate, setCelebrate] = useState<bigint | null>(null);
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    if (!game) return;
    const change = detectLeaderChange(prev.current, game);
    if (change) {
      setFlashKey((k) => k + 1);
      const who = change.next === accountId ? "You" : change.next;
      setAnnounce(`${who} ${change.next === accountId ? "are" : "is"} now the last buyer. Timer reset.`);
      if (change.previous && change.previous !== change.next) setStolen({ thief: change.next, from: change.previous });
    }
    const settled = detectSettlement(prev.current, game);
    if (settled !== null) {
      setCelebrate(settled);
      setAnnounce(`Round ${settled} settled on-chain.`);
    }
    prev.current = game;
  }, [game, accountId]);
  useEffect(() => {
    if (!stolen) return;
    const t = setTimeout(() => setStolen(null), 4_500);
    return () => clearTimeout(t);
  }, [stolen]);

  const duration = market?.roundDurationNs ?? null;
  const urgent = phase === "ACTIVE" && duration !== null && isUrgent(remaining, duration);
  const leader = game?.leader ?? null;
  const youLead = leader !== null && leader === accountId;
  const minBuy = market?.minEligibleBuy ?? null;

  // IDLE shows the full round length, dimmed: that is what the first eligible buy will start.
  let digits = phase === "IDLE" && duration !== null ? formatCountdown(Number(duration / 1_000_000n)) : "--:--";
  if (phase === "ACTIVE" || phase === "CLOSING") digits = formatCountdown(remaining);
  if (phase === "EXPIRED") digits = "00:00";
  const pct = phase === "ACTIVE" && duration ? progressLeft(remaining, duration) : phase === "IDLE" ? 1 : 0;

  // Flame height = share of the round time left. Decorative: the contract alone decides expiry.
  const flameLevel = phase === "ACTIVE" ? pct : phase === "IDLE" ? 0.22 : phase === "CLOSING" ? 0.04 : phase === "EXPIRED" ? 0 : 0.12;

  // Victory banner: the most recent settled round while the next one has not started yet.
  const lastSettled = game?.lastSettledRoundId ?? null;
  const lastRound = lastSettled !== null ? (rounds.get(lastSettled.toString()) ?? null) : null;
  const showVictory = game?.status === "IDLE" && lastSettled !== null;

  const stealTheCrown = () => {
    if (minBuy !== null) window.dispatchEvent(new CustomEvent(PREFILL_BUY_EVENT, { detail: formatUnits(minBuy, NEAR_DECIMALS, { group: false }) }));
    document.getElementById("buy-amount")?.scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("buy-amount")?.focus({ preventScroll: true });
  };

  return (
    // overflow-clip (not hidden): clips the tilted stickers without creating a scroll container
    // that scrollIntoView could shift sideways.
    <section aria-labelledby="hero-title" className="hard relative overflow-clip bg-panel">
      <h1 id="hero-title" className="sr-only">$LAST live game</h1>
      <p className="sr-only" aria-live="polite">{announce}</p>

      {/* Stage: blue flames whose height is the time left */}
      <div className="relative">
        <FlameCanvas level={flameLevel} className="absolute inset-0 h-full w-full" />
        <div className="relative flex min-h-[400px] flex-col justify-between p-5 sm:min-h-[440px] sm:p-7">
          <div className="flex flex-wrap items-center gap-2">
            {phase ? (
              <Badge tone={PHASE_BADGE[phase].tone}>{PHASE_BADGE[phase].text}</Badge>
            ) : (
              <Badge>{deployed ? "Loading" : deployment === "checking" ? "Connecting to contract…" : "No live data"}</Badge>
            )}
            {game && <Badge tone="sky">Round #{game.roundId.toString()}</Badge>}
            {duration !== null && <Badge tone="sky">Timer {formatDuration(duration)}</Badge>}
          </div>

          <div
            role="timer"
            aria-label={phase === "ACTIVE" ? `Time left, estimated: ${digits}` : PHASE_BADGE[phase ?? "IDLE"].text}
            className={cx(
              "font-poster my-4 text-center text-[26vw] leading-[0.85] tabular sm:text-[11rem] lg:text-[12rem]",
              phase === "ACTIVE" && !urgent && "text-text mix-blend-multiply",
              urgent && "anim-urgent text-heat",
              phase === "CLOSING" && "text-acid",
              phase === "EXPIRED" && "text-heat",
              phase === "IDLE" && "text-text/25",
              phase === null && "text-line",
            )}
          >
            {digits}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
            <div className="hard bg-panel-2 p-3 sm:-rotate-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-mute">Jackpot</div>
              <div className="flex items-baseline gap-2">
                {game ? (
                  <span className="font-poster text-4xl tabular text-acid sm:text-5xl">{formatNear(game.activePot, 4)}</span>
                ) : deployed ? (
                  <span className="skeleton inline-block h-10 w-36" aria-label="Loading" />
                ) : (
                  <span className="font-poster text-4xl text-mute sm:text-5xl">—</span>
                )}
                <span className="font-poster text-lg text-text">NEAR</span>
              </div>
              <div className="mt-0.5 text-[11px] text-mute">
                {game?.status === "IDLE" ? "Starting pot" : "Next round's starting pot"}:{" "}
                <span className="font-mono text-text">{game ? `${formatNear(game.nextSeedPot, 4)} NEAR` : "—"}</span>
                {game?.status === "IDLE" && game.nextSeedPot > 0n && <> · joins the jackpot on the first eligible buy</>}
              </div>
            </div>

            <div className={cx("hard relative flex items-center gap-3 p-3 sm:rotate-1", youLead ? "bg-flame" : "bg-panel-2")}>
              <div
                key={flashKey}
                className={cx(
                  "grid h-12 w-12 shrink-0 place-items-center border-2 border-text",
                  leader ? "bg-acid text-panel-2" : "bg-panel text-line",
                  flashKey > 0 && "anim-crown anim-flash",
                )}
              >
                <CrownIcon className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-mute">{phase === "EXPIRED" ? "Leader at expiry" : "Crown holder"}</div>
                <div className="truncate font-mono text-base font-semibold sm:text-lg">
                  {leader ? (
                    simulated ? (
                      shortAccount(leader, 28)
                    ) : (
                      <ExternalLink href={explorerAccountUrl(leader, config.explorerUrl)}>{shortAccount(leader, 28)}</ExternalLink>
                    )
                  ) : (
                    <span className="text-mute">Nobody — take it</span>
                  )}
                </div>
                {youLead && <div className="text-sm font-semibold text-acid">That's you.</div>}
              </div>
              {stolen && (
                <div role="status" className="anim-crown absolute -top-3 right-3 border-2 border-text bg-heat px-3 py-1 font-mono text-[11px] font-bold uppercase text-panel-2">
                  Crown stolen{stolen.thief === accountId ? " by you" : ""}!
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 border-t-2 border-text p-5 sm:p-6">
        <p className="text-sm text-text">
          {phase === null && deployment === "checking" ? "Reading the $LAST contract on NEAR Testnet…" : phaseHint(phase, youLead, minBuy, duration, game)}
        </p>

        {/* Victory (after on-chain settlement) */}
        {showVictory && (
          <div key={celebrate?.toString() ?? "victory"} className={cx("hard bg-flame p-4", celebrate !== null && "anim-crown")}>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text">
              <CrownIcon className="h-4 w-4" /> Round #{lastSettled!.toString()} settled on-chain
            </div>
            {lastRound ? (
              <p className="mt-1 text-sm">
                Winner <span className="font-mono font-bold">{shortAccount(lastRound.winner, 28)}</span>
                {lastRound.winner === accountId && <span className="font-bold text-acid"> (you!)</span>} · prize{" "}
                <span className="font-mono font-bold text-acid">{formatNear(lastRound.prize)} NEAR</span> · claim {lastRound.claimStatus}
              </p>
            ) : (
              <p className="mt-1 text-sm text-mute">Winner details appear when the contract exposes get_round (Gate 2).</p>
            )}
          </div>
        )}

        {/* Steal the crown CTA + how a win is confirmed */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <div className="font-semibold">
              {minBuy !== null ? (
                <>
                  Buy <span className="font-mono text-acid">≥ {formatCompact(minBuy, 24)} NEAR</span> to steal the crown
                  {duration !== null && <> and reset the timer to {formatDuration(duration)}</>}.
                </>
              ) : (
                <>
                  Buy at least the minimum to steal the crown. <Dash />
                </>
              )}
            </div>
            <div className="mt-0.5 text-xs text-mute">Win = timer expires on-chain → anyone settles → winner claims. Your browser's 00:00 alone never decides.</div>
          </div>
          <Button className="shrink-0" onClick={stealTheCrown} disabled={!deployed || phase === "EXPIRED" || minBuy === null}>
            <CrownIcon className="h-4 w-4" /> Steal the crown
          </Button>
        </div>
      </div>
    </section>
  );
}

function phaseHint(phase: DisplayPhase | null, youLead: boolean, minBuy: bigint | null, duration: bigint | null, game: GameState | null): string {
  const min = minBuy !== null ? `${formatCompact(minBuy, 24)} NEAR` : "the minimum";
  const dur = duration !== null ? formatDuration(duration) : "the round duration";
  switch (phase) {
    case "ACTIVE":
      return youLead
        ? `You hold the crown. Any buy of ${min} or more steals it and resets the clock. Countdown estimated from chain time.`
        : `Every buy of at least ${min} steals the crown and resets the timer to ${dur}. Countdown estimated from chain time.`;
    case "CLOSING":
      return youLead
        ? "Your browser shows 00:00 — you win only if the chain confirms no later eligible buy. Waiting for the contract."
        : "Local countdown reached zero. Waiting for the contract to confirm expiry — a buy confirmed before the deadline still counts.";
    case "EXPIRED":
      return youLead
        ? `You won round #${game?.roundId ?? ""} on-chain. The prize becomes claimable once the round is settled.`
        : `Round #${game?.roundId ?? ""} is over on-chain. Trading is paused until anyone settles it; the winner then claims the jackpot.`;
    case "IDLE":
      return `No active round. The first buy of at least ${min} starts round #${game?.roundId ?? ""} and takes the crown.`;
    default:
      return "Live game state appears here once the contract is deployed on NEAR Testnet.";
  }
}
