import { useEffect, useRef, useState } from "react";
import { explorerAccountUrl } from "../config";
import { useCountdown } from "../hooks/useCountdown";
import { useLast } from "../hooks/useLast";
import { NEAR_DECIMALS, formatCompact, formatNear, formatUnits } from "../lib/amounts";
import { type DisplayPhase, formatCountdown, formatDuration, isUrgent, progressLeft } from "../lib/countdown";
import { detectLeaderChange, detectSettlement, shortAccount } from "../lib/game";
import type { GameState } from "../lib/types";
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
    // overflow-clip (not hidden): clips the decorative glow without creating a scroll container
    // that scrollIntoView could shift sideways.
    <section aria-labelledby="hero-title" className="relative overflow-clip rounded-3xl border border-line bg-panel/80 p-5 sm:p-8">
      <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-acid/10 blur-3xl" aria-hidden />
      <h1 id="hero-title" className="sr-only">LAST live game</h1>
      <p className="sr-only" aria-live="polite">{announce}</p>

      <div className="flex flex-wrap items-center gap-2">
        {phase ? <Badge tone={PHASE_BADGE[phase].tone}>{PHASE_BADGE[phase].text}</Badge> : <Badge>{deployed ? "Loading" : deployment === "checking" ? "Connecting to contract…" : "No live data"}</Badge>}
        {game && <Badge tone="sky">Round #{game.roundId.toString()}</Badge>}
        {duration !== null && <Badge>Timer {formatDuration(duration)}</Badge>}
      </div>

      {/* Jackpot + crown holder */}
      <div className="mt-6 grid gap-5 sm:grid-cols-2 sm:items-end">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-mute">Jackpot</div>
          <div className="mt-1 flex items-baseline gap-2">
            {game ? (
              <span className="font-mono text-5xl font-extrabold tabular text-jackpot sm:text-6xl">{formatNear(game.activePot, 4)}</span>
            ) : deployed ? (
              <span className="skeleton inline-block h-12 w-40 rounded-lg" aria-label="Loading" />
            ) : (
              <span className="font-mono text-5xl font-extrabold text-mute sm:text-6xl">—</span>
            )}
            <span className="font-mono text-xl font-bold text-gold/80">NEAR</span>
          </div>
          <div className="mt-1 text-sm text-mute">
            Next round seed: <span className="font-mono text-text/90">{game ? `${formatNear(game.nextSeedPot, 4)} NEAR` : "—"}</span>
          </div>
        </div>

        <div
          className={cx(
            "relative flex items-center gap-4 rounded-2xl border p-4",
            youLead ? "border-acid/60 bg-acid/10" : "border-line bg-panel-2/70",
          )}
        >
          <div
            key={flashKey}
            className={cx("grid h-14 w-14 shrink-0 place-items-center rounded-2xl", leader ? "bg-acid text-ink" : "bg-panel text-line", flashKey > 0 && "anim-crown anim-flash")}
          >
            <CrownIcon className="h-8 w-8" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-mute">
              {phase === "EXPIRED" ? "Leader at expiry" : "Crown holder"}
            </div>
            <div className="truncate font-mono text-lg font-bold sm:text-xl">
              {leader ? (
                simulated ? shortAccount(leader, 28) : <ExternalLink href={explorerAccountUrl(leader, config.explorerUrl)}>{shortAccount(leader, 28)}</ExternalLink>
              ) : (
                <span className="text-mute">Nobody — take it</span>
              )}
            </div>
            {youLead && <div className="text-sm font-semibold text-acid">That's you.</div>}
          </div>
          {stolen && (
            <div role="status" className="anim-crown absolute -top-3 right-3 rounded-full bg-heat px-3 py-1 font-mono text-[11px] font-extrabold uppercase text-white shadow-lg">
              Crown stolen{stolen.thief === accountId ? " by you" : ""}!
            </div>
          )}
        </div>
      </div>

      {/* Countdown */}
      <div className="mt-6">
        <div
          role="timer"
          aria-label={phase === "ACTIVE" ? `Time left, estimated: ${digits}` : PHASE_BADGE[phase ?? "IDLE"].text}
          className={cx(
            "font-mono text-[22vw] font-extrabold leading-none tabular sm:text-[9rem] lg:text-[10rem]",
            phase === "ACTIVE" && !urgent && "text-acid glow-acid",
            urgent && "anim-urgent text-heat glow-heat",
            phase === "CLOSING" && "text-gold",
            phase === "EXPIRED" && "text-heat",
            phase === "IDLE" && "text-text/15",
            phase === null && "text-line",
          )}
        >
          {digits}
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-panel-2" aria-hidden>
          <div
            className={cx("h-full rounded-full transition-[width] duration-300", urgent ? "bg-heat" : phase === "EXPIRED" ? "bg-heat/40" : "bg-acid")}
            style={{ width: `${(pct * 100).toFixed(2)}%` }}
          />
        </div>
        <p className="mt-3 text-sm text-text/80">
          {phase === null && deployment === "checking" ? "Reading the LAST contract on NEAR Testnet…" : phaseHint(phase, youLead, minBuy, duration, game)}
        </p>
      </div>

      {/* Victory (after on-chain settlement) */}
      {showVictory && (
        <div
          key={celebrate?.toString() ?? "victory"}
          className={cx("mt-5 rounded-2xl border border-gold/50 bg-gold/10 p-4", celebrate !== null && "anim-crown")}
        >
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-gold">
            <CrownIcon className="h-4 w-4" /> Round #{lastSettled!.toString()} settled on-chain
          </div>
          {lastRound ? (
            <p className="mt-1 text-sm">
              Winner <span className="font-mono font-bold">{shortAccount(lastRound.winner, 28)}</span>
              {lastRound.winner === accountId && <span className="font-bold text-acid"> (you!)</span>} · prize{" "}
              <span className="font-mono font-bold text-gold">{formatNear(lastRound.prize)} NEAR</span> · claim {lastRound.claimStatus}
            </p>
          ) : (
            <p className="mt-1 text-sm text-mute">Winner details appear when the contract exposes get_round (Gate 2).</p>
          )}
        </div>
      )}

      {/* Steal the crown CTA + how a win is confirmed */}
      <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-line bg-panel-2/60 p-4 sm:flex-row sm:items-center sm:justify-between">
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
