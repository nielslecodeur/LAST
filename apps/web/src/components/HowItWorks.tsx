import { useLast } from "../hooks/useLast";
import { formatCompact } from "../lib/amounts";
import { formatDuration } from "../lib/countdown";
import { Card } from "./ui";

export function HowItWorks() {
  const { market } = useLast();
  const min = market ? `${formatCompact(market.minEligibleBuy, 24)} NEAR` : "the minimum (0.03 NEAR on the demo)";
  const dur = market ? formatDuration(market.roundDurationNs) : "the round timer (2 min on the testnet demo, 60 min in the final concept)";
  const steps = [
    ["Buy LAST", `Buy at least ${min} through LAST's own market. You become the last buyer.`],
    ["Reset the clock", `Every eligible buy restarts the countdown to ${dur}. Smaller buys get LAST but not the crown.`],
    ["Last one standing", "If nobody buys before the timer ends, the last buyer wins the NEAR jackpot."],
    ["Settle & claim", "Anyone settles the expired round on-chain; the winner then claims the prize to their wallet."],
  ];
  return (
    <Card title="How it works" id="how">
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(([t, d], i) => (
          <li key={t} className="rounded-xl border border-line bg-panel-2/60 p-4">
            <div className="font-mono text-xs font-bold text-acid">0{i + 1}</div>
            <div className="mt-1 font-semibold">{t}</div>
            <p className="mt-1 text-sm text-mute">{d}</p>
          </li>
        ))}
      </ol>
      <ul className="mt-4 grid gap-1 text-xs text-mute sm:grid-cols-2">
        <li>• Fees: 4% on buys, 2% on sells → 70% jackpot · 10% next-round seed · 15% treasury · 5% ops.</li>
        <li>• Selling or transferring LAST never changes the leader. The leader can sell and still win.</li>
        <li>• Once the deadline passes, trading pauses until the round is settled.</li>
        <li>• Bots and multiple wallets are allowed by the protocol. No fairness or anti-bot guarantee.</li>
      </ul>
    </Card>
  );
}
