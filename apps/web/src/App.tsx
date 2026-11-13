import { explorerAccountUrl } from "./config";
import { useLast } from "./hooks/useLast";
import { ActivityPanel } from "./components/ActivityPanel";
import { CreditPanel } from "./components/CreditPanel";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";
import { MainnetBanner } from "./components/MainnetBanner";
import { MarketPanel } from "./components/MarketPanel";
import { RewardsPanel } from "./components/RewardsPanel";
import { StatusBanner } from "./components/StatusBanner";
import { TopBar } from "./components/TopBar";
import { TradePanel } from "./components/TradePanel";
import { TxToast } from "./components/TxToast";
import { ExternalLink } from "./components/ui";

export function App() {
  const { reader, simulated, deployed, config } = useLast();
  return (
    <div id="top" className="relative">
      <MainnetBanner />
      <TopBar />
      <StatusBanner />
      <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:py-8">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7">
            <Hero />
          </div>
          <div className="min-w-0 lg:col-span-5">
            <TradePanel />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="min-w-0 space-y-5 lg:col-span-7">
            <RewardsPanel />
            <MarketPanel />
          </div>
          <div className="min-w-0 space-y-5 lg:col-span-5">
            <CreditPanel />
            <ActivityPanel />
          </div>
        </div>
        <HowItWorks />
      </main>
      <footer className="border-t-2 border-text">
        <div className="mx-auto max-w-7xl space-y-2 px-4 py-6 text-xs text-mute sm:px-6">
          <p>
            <strong className="text-text/80">NEAR Testnet only — no monetary value.</strong> Experimental, unaudited prize game. Price impact, fees, bots and
            transaction ordering can cause losses. Not an investment. 20% of fees are locked in V1 (no withdraw method), and the
            contract is not immutable while its account keeps a full-access key (see Market → Disclosure).
          </p>
          <p>
            Contract:{" "}
            {simulated ? (
              <span className="font-mono text-heat">SIMULATED (local)</span>
            ) : deployed && reader ? (
              <ExternalLink href={explorerAccountUrl(reader.contractId, config.explorerUrl)} className="font-mono">
                {reader.contractId}
              </ExternalLink>
            ) : (
              <span className="font-mono">not deployed</span>
            )}{" "}
            · Winner, pots and balances are read from contract state only.
          </p>
        </div>
      </footer>
      <TxToast />
    </div>
  );
}
