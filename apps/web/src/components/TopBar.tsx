import { explorerAccountUrl } from "../config";
import { shortAccount } from "../lib/game";
import { useLast } from "../hooks/useLast";
import { Badge, Button, CrownIcon, ExternalLink } from "./ui";

export function TopBar() {
  const { accountId, connect, disconnect, connecting, deployment, simulated, config } = useLast();
  const sourceBadge = simulated ? (
    <Badge tone="heat">SIMULATED</Badge>
  ) : deployment === "deployed" ? (
    <Badge tone="acid">
      <span className="h-1.5 w-1.5 rounded-full bg-acid" aria-hidden /> LIVE
    </Badge>
  ) : deployment === "checking" ? (
    <Badge tone="mute">CHECKING…</Badge>
  ) : deployment === "wrong_network" ? (
    <Badge tone="heat">WRONG NETWORK</Badge>
  ) : deployment === "probe_failed" ? (
    <Badge tone="heat">RPC UNREACHABLE</Badge>
  ) : (
    <Badge tone="mute">CONTRACT NOT DEPLOYED</Badge>
  );

  return (
    <header className="sticky top-0 z-30 border-b-2 border-text bg-ink">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <a href="#top" className="flex items-center gap-2" aria-label="$LAST home">
          <CrownIcon className="h-7 w-7 text-acid" />
          <span className="font-poster riso text-3xl leading-none">$LAST</span>
        </a>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex">
            <Badge tone="sky">NEAR TESTNET</Badge>
          </span>
          {sourceBadge}
          {accountId ? (
            <div className="flex items-center gap-1">
              <span className="hidden border-2 border-text bg-panel-2 px-3 py-2 font-mono text-sm sm:inline">
                {simulated ? shortAccount(accountId) : <ExternalLink href={explorerAccountUrl(accountId, config.explorerUrl)}>{shortAccount(accountId)}</ExternalLink>}
              </span>
              <Button variant="ghost" className="px-2 py-2 text-sm" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button className="px-4 py-2 text-sm" onClick={() => void connect()} disabled={connecting || deployment !== "deployed"}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
