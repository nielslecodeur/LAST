import type { Capabilities } from "../lib/types";
import { Badge } from "./ui";

const METHODS: Array<[keyof Omit<Capabilities, "source">, string]> = [
  ["settleRound", "settle_round"],
  ["claimReward", "claim_reward"],
  ["withdrawNearCredit", "withdraw_near_credit"],
  ["getRound", "get_round"],
];

export function missingGate2(caps: Capabilities): string[] {
  return METHODS.filter(([k]) => !caps[k]).map(([, m]) => m);
}

/** Small honest chip: which Gate 2 methods the deployed contract does not export (yet). */
export function Gate2Badge({ caps, deployed }: { caps: Capabilities; deployed: boolean }) {
  if (!deployed) return null;
  const missing = missingGate2(caps);
  if (missing.length === 0) return <Badge tone="acid">Gate 2 live</Badge>;
  return (
    <span title={`Not exported by the deployed contract: ${missing.join(", ")}`}>
      <Badge tone="gold">Gate 2 pending</Badge>
    </span>
  );
}
