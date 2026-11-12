import { useLast } from "../hooks/useLast";
import { formatCompact, formatLast, formatNear, spotPriceYoctoPerLast } from "../lib/amounts";
import { isSolvent } from "../lib/types";
import { Badge, Card, Dash, Stat } from "./ui";

export function MarketPanel() {
  const { market, game, integrity, fullAccessKeys } = useLast();
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
        <Stat label="Treasury · Ops" value={market ? `${formatNear(market.treasuryReserve, 3)} · ${formatNear(market.opsReserve, 3)}` : <Dash />} hint="locked · no withdraw method in V1" />
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

      <div className="mt-3 rounded-xl border border-gold/30 bg-gold/5 p-4 text-xs leading-relaxed text-text/85">
        <div className="mb-1 font-semibold uppercase tracking-wider text-gold">Disclosure</div>
        <p>
          20% of every LAST fee (15% treasury, 5% ops
          {market ? <>, now {formatNear(market.treasuryReserve + market.opsReserve, 4)} NEAR</> : null}) is locked: the deployed V1 code has no
          withdraw method for it. It goes neither to players nor to the team.
        </p>
        <p className="mt-1">
          {fullAccessKeys === null ? (
            <>Contract key status: not read yet.</>
          ) : fullAccessKeys > 0 ? (
            <>
              The contract account still holds {fullAccessKeys === 1 ? "a full-access key" : `${fullAccessKeys} full-access keys`} (read on-chain), so
              its owner can replace the code and these rules: <strong>the contract is not immutable</strong>.
            </>
          ) : (
            <>The contract account holds no full-access key (read on-chain): its code cannot be replaced.</>
          )}
        </p>
      </div>
    </Card>
  );
}
