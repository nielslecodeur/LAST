import { useLast } from "../hooks/useLast";
import { formatCompact, formatLast, formatNear, spotPriceYoctoPerLast } from "../lib/amounts";
import { isSolvent } from "../lib/types";
import { Badge, Card, Dash, Stat } from "./ui";

export function MarketPanel() {
  const { market, game, integrity } = useLast();
  const price = market ? spotPriceYoctoPerLast(market.nearReserve, market.lastInventory) : null;
  const solvent = integrity ? isSolvent(integrity) : null;

  return (
    <Card title="Market">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Spot price" value={price !== null ? `${formatCompact(price, 24, 4)} NEAR` : <Dash />} hint="per LAST · marginal, indicative" />
        <Stat label="Buy volume" value={market ? `${formatNear(market.totalBuyVolume, 2)} N` : <Dash />} hint="gross NEAR in" />
        <Stat label="Sell volume" value={market ? `${formatNear(market.totalSellVolume, 2)} N` : <Dash />} hint="gross NEAR out" />
        <Stat label="Buys" value={market ? market.buyCount.toString() : <Dash />} hint="all buys, any size" />
        <Stat label="Sells" value={market ? market.sellCount.toString() : <Dash />} />
        <Stat label="Eligible buys" value={game ? game.qualifyingBuyCount : <Dash />} hint="this round · not unique players" />
        <Stat label="NEAR reserve" value={market ? `${formatNear(market.nearReserve, 3)} N` : <Dash />} hint="AMM X" />
        <Stat label="LAST inventory" value={market ? formatLast(market.lastInventory, 0) : <Dash />} hint="AMM Y" />
        <Stat label="Treasury · Ops" value={market ? `${formatNear(market.treasuryReserve, 3)} · ${formatNear(market.opsReserve, 3)}` : <Dash />} hint="reserved, not withdrawable in MVP" />
      </div>

      <div className="mt-4 rounded-xl border border-line bg-panel-2/60 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-mute">Proof of reserves</span>
          {solvent === null ? <Badge>—</Badge> : solvent ? <Badge tone="acid">Covered</Badge> : <Badge tone="heat">Shortfall</Badge>}
        </div>
        {integrity ? (
          <p className="mt-2 font-mono text-xs leading-relaxed text-text/80">
            balance {formatNear(integrity.accountBalance, 4)}
            {integrity.inFlight > 0n && <> + in flight {formatNear(integrity.inFlight, 4)}</>} ≥ storage {formatNear(integrity.storageCost, 4)} +
            obligations {formatNear(integrity.totalObligations, 4)} · surplus {formatNear(integrity.surplus, 4)} NEAR
          </p>
        ) : (
          <p className="mt-2 text-xs text-mute">From <code className="font-mono">get_integrity()</code> once deployed.</p>
        )}
      </div>
    </Card>
  );
}
