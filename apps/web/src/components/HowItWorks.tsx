import { useLast } from "../hooks/useLast";
import { formatBps, formatCompact } from "../lib/amounts";
import { formatDuration } from "../lib/countdown";
import { DOCUMENTED_V1_SPLIT, describeSplit, economicsFromMarket } from "../lib/economics";
import { Card } from "./ui";

export function HowItWorks() {
  const { market } = useLast();
  const eco = market ? economicsFromMarket(market) : null;
  const min = eco ? `${formatCompact(eco.minEligibleBuy, 24)} NEAR` : "the minimum (0.03 NEAR on the demo)";
  const dur = eco ? formatDuration(eco.roundDurationNs) : "the round timer (2 min on the testnet demo, 60 min in the final concept)";
  const steps = [
    ["Steal the crown", `Buy at least ${min} through the $LAST market. You take the crown.`],
    ["Reset the clock", `Every eligible buy restarts the countdown to ${dur}. Smaller buys get $LAST but not the crown.`],
    ["Hold until zero", "If nobody buys before the timer ends on-chain, the crown holder takes the NEAR jackpot."],
    ["Settle & claim", "Anyone settles the expired round on-chain; the winner then claims the prize to their wallet."],
  ];
  const fees = eco ? `${formatBps(eco.buyFeeBps)} on buys, ${formatBps(eco.sellFeeBps)} on sells` : "4% on buys, 2% on sells";
  return (
    <Card title="How it works" id="how">
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(([t, d], i) => (
          <li key={t} className="border-2 border-text bg-panel-2 p-4">
            <div className="font-poster text-3xl text-acid">0{i + 1}</div>
            <div className="mt-1 font-semibold">{t}</div>
            <p className="mt-1 text-sm text-mute">{d}</p>
          </li>
        ))}
      </ol>
      <ul className="mt-4 grid gap-1 text-xs text-mute sm:grid-cols-2">
        <li>
          • $LAST market fees: {fees}
          {eco ? " (read from the contract)" : ""} → {describeSplit(eco?.split ?? DOCUMENTED_V1_SPLIT)}
          {" "}(split per CONTRACT_API v0.2, fixed at init). NEAR network gas is separate.
        </li>
        <li>• Selling or transferring $LAST never changes the leader. The leader can sell and still win.</li>
        <li>• Once the deadline passes on-chain, trading pauses until the round is settled.</li>
        <li>• Bots and multiple wallets are allowed by the protocol. No fairness or anti-bot guarantee.</li>
      </ul>
    </Card>
  );
}
