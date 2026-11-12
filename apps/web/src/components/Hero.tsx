import { useEffect, useRef, useState } from "react";
import { explorerAccountUrl } from "../config";
import { useCountdown } from "../hooks/useCountdown";
import { useLast } from "../hooks/useLast";
import { formatCompact, formatNear } from "../lib/amounts";
import { type DisplayPhase, formatCountdown, formatDuration, isUrgent, progressLeft } from "../lib/countdown";
import { detectLeaderChange, shortAccount } from "../lib/game";
import type { GameState } from "../lib/types";
import { Badge, CrownIcon, Dash, ExternalLink, cx } from "./ui";

const PHASE_BADGE: Record<DisplayPhase, { tone: "acid" | "heat" | "gold" | "mute"; text: string }> = {
  IDLE: { tone: "mute", text: "IDLE · waiting for first buy" },
  ACTIVE: { tone: "acid", text: "ACTIVE" },
  CLOSING: { tone: "gold", text: "CLOSING · confirming on-chain" },
  EXPIRED: { tone: "heat", text: "EXPIRED · awaiting settlement" },
};

export function Hero() {
  const { game, market, clock, accountId, deployed, simulated, config } = useLast();
  const { remaining, phase } = useCountdown(game, clock);

  // Crown change → animation + screen-reader announcement (only on confirmed reads).
  const prev = useRef<GameState | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    if (!game) return;
    const change = detectLeaderChange(prev.current, game);
    if (change) {
      setFlashKey((k) => k + 1);
      setAnnounce(`${change.next === accountId ? "You are" : `${change.next} is`} now the last buyer. Timer reset.`);
    }
    prev.current = game;
  }, [game, accountId]);

  const duration = market?.roundDurationNs ?? null;
  const urgent = phase === "ACTIVE" && duration !== null && isUrgent(remaining, duration);
  const leader = game?.leader ?? null;
  const youLead = leader !== null && leader === accountId;

  // IDLE shows the full round length, dimmed: that is what the first eligible buy will start.
  let digits = phase === "IDLE" && duration !== null ? formatCountdown(Number(duration / 1_000_000n)) : "--:--";
  if (phase === "ACTIVE" || phase === "CLOSING") digits = formatCountdown(remaining);
  if (phase === "EXPIRED") digits = "00:00";
  const pct = phase === "ACTIVE" && duration ? progressLeft(remaining, duration) : phase === "IDLE" ? 1 : 0;

  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden rounded-3xl border border-line bg-panel/80 p-5 sm:p-8">
      <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-acid/10 blur-3xl" aria-hidden />
      <h1 id="hero-title" className="sr-only">LAST live game</h1>
      <p className="sr-only" aria-live="polite">{announce}</p>

      <div className="flex flex-wrap items-center gap-2">
        {phase ? <Badge tone={PHASE_BADGE[phase].tone}>{PHASE_BADGE[phase].text}</Badge> : <Badge>{deployed ? "Loading" : "No live data"}</Badge>}
        {game && <Badge tone="sky">Round #{game.roundId.toString()}</Badge>}
        {duration !== null && <Badge>Timer {formatDuration(duration)}{simulated ? "" : " · testnet demo"}</Badge>}
      </div>

      {/* Jackpot */}
      <div className="mt-6">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-mute">Jackpot</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className={cx("font-mono text-5xl font-extrabold tabular sm:text-7xl", game ? "text-jackpot" : "text-mute")}>
            {game ? formatNear(game.activePot, 4) : "—"}
          </span>
          <span className="font-mono text-xl font-bold text-gold/80 sm:text-2xl">NEAR</span>
        </div>
        <div className="mt-1 text-sm text-mute">
          Next round seed: <span className="font-mono text-text/90">{game ? `${formatNear(game.nextSeedPot, 4)} NEAR` : "—"}</span>
          {game && game.status === "IDLE" && game.nextSeedPot > 0n && " · becomes the jackpot on the first eligible buy"}
        </div>
      </div>

      {/* Countdown */}
      <div className="mt-8">
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
        <p className="mt-3 text-sm text-mute">{phaseHint(phase, market?.minEligibleBuy ?? null, duration, game)}</p>
      </div>

      {/* Crown */}
      <div className="mt-6 flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-panel-2/70 p-4">
        <div key={flashKey} className={cx("grid h-14 w-14 shrink-0 place-items-center rounded-2xl", leader ? "bg-acid text-ink" : "bg-panel text-line", flashKey > 0 && "anim-crown anim-flash")}>
          <CrownIcon className="h-8 w-8" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-mute">{phase === "EXPIRED" ? "Winner (pending settlement)" : "Last buyer"}</div>
          <div className="truncate font-mono text-lg font-bold sm:text-xl">
            {leader ? (
              simulated ? shortAccount(leader, 32) : <ExternalLink href={explorerAccountUrl(leader, config.explorerUrl)}>{shortAccount(leader, 32)}</ExternalLink>
            ) : (
              <span className="text-mute">No leader yet</span>
            )}
          </div>
          {youLead && <div className="mt-0.5 text-sm font-semibold text-acid">That's you. Hold the crown until the timer runs out.</div>}
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-mute">Eligible buys</div>
            <div className="font-mono text-lg font-bold tabular">{game ? game.qualifyingBuyCount : <Dash />}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-mute">Min to lead</div>
            <div className="font-mono text-lg font-bold tabular">{market ? `${formatCompact(market.minEligibleBuy, 24)} N` : <Dash />}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function phaseHint(phase: DisplayPhase | null, minBuy: bigint | null, duration: bigint | null, game: GameState | null): string {
  const min = minBuy !== null ? `${formatCompact(minBuy, 24)} NEAR` : "the minimum";
  const dur = duration !== null ? formatDuration(duration) : "the round duration";
  switch (phase) {
    case "ACTIVE":
      return `Every buy of at least ${min} takes the crown and resets the timer to ${dur}. Countdown estimated from chain time.`;
    case "CLOSING":
      return "The local countdown reached zero. Waiting for the contract to confirm expiry — a buy confirmed before the deadline still counts.";
    case "EXPIRED":
      return `Round #${game?.roundId ?? ""} is over on-chain. Trading is paused until anyone settles it; the winner then claims the jackpot.`;
    case "IDLE":
      return `No active round. The first buy of at least ${min} starts round #${game?.roundId ?? ""} and takes the crown.`;
    default:
      return "Live game state appears here once the contract is deployed on NEAR Testnet.";
  }
}
