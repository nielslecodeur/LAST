import { explorerAccountUrl } from "../config";
import { useLast } from "../hooks/useLast";
import { formatNear } from "../lib/amounts";
import { canSettle, claimableFor, recentRoundIds, shortAccount } from "../lib/game";
import { buildClaimTx, buildSettleTx } from "../lib/transactions";
import { isBusy } from "../lib/txMachine";
import type { ClaimStatus, RoundView } from "../lib/types";
import { Gate2Badge } from "./Gate2Notice";
import { Badge, Button, Card, CrownIcon, ExternalLink } from "./ui";

const CLAIM_TONE: Record<ClaimStatus, "acid" | "gold" | "mute"> = { AVAILABLE: "acid", IN_FLIGHT: "gold", PAID: "mute" };

export function RewardsPanel() {
  const { game, account, rounds, accountId, capabilities, deployed, tx, run, reader, simulated, config } = useLast();
  const settle = canSettle(game, capabilities);
  const mine = claimableFor(account, rounds, accountId);
  const recent = recentRoundIds(game?.lastSettledRoundId ?? null)
    .map((id) => rounds.get(id.toString()) ?? null)
    .filter((r): r is RoundView => r !== null);
  const lastWinner = recent[0] ?? null;

  const accountLink = (id: string) =>
    simulated ? shortAccount(id) : <ExternalLink href={explorerAccountUrl(id, config.explorerUrl)}>{shortAccount(id)}</ExternalLink>;

  return (
    <Card title="Rounds & rewards" aside={<Gate2Badge caps={capabilities} deployed={deployed} />}>
      {/* Settle */}
      {game?.status === "EXPIRED" && (
        <div className="mb-4 rounded-xl border border-heat/40 bg-heat/10 p-4">
          <div className="font-semibold">Round #{game.roundId.toString()} has expired on-chain.</div>
          <p className="mt-1 text-sm text-text/80">
            Winner: <span className="font-mono">{game.leader ? accountLink(game.leader) : "—"}</span> · prize {formatNear(game.activePot)} NEAR. Anyone can settle; settling
            moves the prize into the winner's claim and reopens trading.
          </p>
          <Button
            variant="danger"
            className="mt-3 w-full"
            disabled={!settle.allowed || !accountId || isBusy(tx)}
            onClick={() => reader && void run(buildSettleTx(reader.contractId, capabilities, game.roundId))}
          >
            {!settle.allowed ? "Settle round — pending Gate 2" : !accountId ? "Connect wallet to settle" : isBusy(tx) && tx.kind === "settle" ? "Confirm in wallet…" : `Settle round #${game.roundId}`}
          </Button>
          {settle.reason && <p className="mt-2 text-xs text-gold">{settle.reason}</p>}
        </div>
      )}

      {/* Your prizes */}
      {accountId && mine.length > 0 && (
        <div className="mb-4 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-acid">Your prizes</div>
          {mine.map((r) => (
            <div key={r.roundId.toString()} className="flex items-center justify-between gap-3 rounded-xl border border-acid/40 bg-acid/5 p-3">
              <div>
                <div className="font-mono font-bold">{formatNear(r.prize)} NEAR</div>
                <div className="text-xs text-mute">Round #{r.roundId.toString()} · <Badge tone={CLAIM_TONE[r.claimStatus]}>{r.claimStatus}</Badge></div>
              </div>
              <Button
                disabled={!capabilities.claimReward || r.claimStatus !== "AVAILABLE" || isBusy(tx)}
                onClick={() => reader && void run(buildClaimTx(reader.contractId, capabilities, r.roundId))}
              >
                {!capabilities.claimReward ? "Pending Gate 2" : r.claimStatus === "IN_FLIGHT" ? "Payment in flight…" : "Claim reward"}
              </Button>
            </div>
          ))}
          {mine.some((r) => r.claimStatus === "IN_FLIGHT") && (
            <p className="text-xs text-gold">IN_FLIGHT means the transfer was sent but its result is not confirmed yet. It is not a final payment.</p>
          )}
        </div>
      )}

      {/* Last confirmed winner */}
      <div className="rounded-xl border border-line bg-panel-2/60 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
          <CrownIcon className="h-3.5 w-3.5 text-gold" /> Last confirmed winner
        </div>
        {lastWinner ? (
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-lg font-bold">{accountLink(lastWinner.winner)}</span>
            <span className="font-mono text-jackpot text-lg font-extrabold">{formatNear(lastWinner.prize)} NEAR</span>
          </div>
        ) : game?.lastSettledRoundId != null && !capabilities.getRound ? (
          <p className="mt-2 text-sm text-mute">Round #{game.lastSettledRoundId.toString()} was settled. Its details need <code className="font-mono">get_round</code> (Gate 2).</p>
        ) : (
          <p className="mt-2 text-sm text-mute">{deployed ? "No round has been settled yet." : "No live data."}</p>
        )}
      </div>

      {/* History */}
      {recent.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Recent settled rounds</caption>
            <thead className="text-[11px] uppercase tracking-wider text-mute">
              <tr>
                <th className="py-2 font-medium">Round</th>
                <th className="py-2 font-medium">Winner</th>
                <th className="py-2 text-right font-medium">Prize</th>
                <th className="py-2 text-right font-medium">Buys</th>
                <th className="py-2 text-right font-medium">Claim</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {recent.map((r) => (
                <tr key={r.roundId.toString()} className="border-t border-line/60">
                  <td className="py-2">#{r.roundId.toString()}</td>
                  <td className="max-w-[10rem] truncate py-2">{accountLink(r.winner)}</td>
                  <td className="py-2 text-right tabular">{formatNear(r.prize)}</td>
                  <td className="py-2 text-right tabular">{r.qualifyingBuyCount}</td>
                  <td className="py-2 text-right"><Badge tone={CLAIM_TONE[r.claimStatus]}>{r.claimStatus}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
