import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { config } from "./config";
import { LastProvider } from "./hooks/useLast";
import type { LastReader } from "./lib/reader";
import { LiveLastReader } from "./lib/reader";
import { createRpcClient } from "./lib/rpc";
import { HotConnectWriter, type LastWriter } from "./lib/wallet";
import "./index.css";

async function boot() {
  let reader: LastReader | null = null;
  let writer: LastWriter | null = null;

  // `import.meta.env.DEV` is a compile-time `false` in production builds, so the bundler drops this
  // branch and the SIMULATED adapter is not even shipped (config.ts enforces the same rule at runtime).
  if (import.meta.env.DEV && config.source === "simulated") {
    const { SimulatedChain } = await import("./lib/mock");
    const q = new URLSearchParams(location.search);
    const sim = new SimulatedChain({ gate2: q.get("gate2") === "1", bots: q.get("bots") !== "0" });
    reader = sim;
    writer = sim;
  } else if (config.source === "live" && config.contractId) {
    reader = new LiveLastReader(createRpcClient(config.rpcUrls), config.contractId);
    writer = new HotConnectWriter(config.rpcUrls);
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <LastProvider config={config} reader={reader} writer={writer}>
        <App />
      </LastProvider>
    </StrictMode>,
  );
}

void boot();
