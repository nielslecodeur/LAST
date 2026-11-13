// UI tests (jsdom). MOCKED: no network, no wallet. "Not deployed" uses no reader at all; the other
// cases use the SIMULATED adapter. They check what the user sees in each state.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { type AppConfig, resolveConfig } from "../config";
import { LastProvider } from "../hooks/useLast";
import { SIM_USER, SimulatedChain } from "../lib/mock";
import type { LastReader } from "../lib/reader";

afterEach(cleanup);

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function mount(config: AppConfig, reader: LastReader | null, writer: SimulatedChain | null = null) {
  return render(
    <LastProvider config={config} reader={reader} writer={writer} pollMs={60_000}>
      <App />
    </LastProvider>,
  );
}

const buttons = (name: RegExp) => screen.getAllByRole("button", { name }) as HTMLButtonElement[];
const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

async function simulated(sim: SimulatedChain) {
  mount(resolveConfig({ MODE: "mock", DEV: true }), sim, sim);
  await flush();
  await flush();
}

describe("CONTRACT NOT DEPLOYED", () => {
  it("shows the banner, no invented numbers, every action disabled", async () => {
    mount(resolveConfig({}), null);
    await flush();
    expect(screen.getAllByText(/CONTRACT NOT DEPLOYED/).length).toBeGreaterThan(0);
    expect(button(/Connect wallet/).disabled).toBe(true);
    const blocked = buttons(/Contract not deployed/);
    expect(blocked.length).toBeGreaterThanOrEqual(2); // Buy + Withdraw
    expect(blocked.every((b) => b.disabled)).toBe(true);
    expect(screen.queryByText(/SIMULATED/)).toBeNull();
    const hero = screen.getByRole("region", { name: /LAST live game/ });
    expect(within(hero).getAllByText("—").length).toBeGreaterThan(0); // jackpot is a dash, not 0
    expect(within(hero).queryByText(/^0$/)).toBeNull();
  });

  it("refuses a mainnet contract id", async () => {
    mount(resolveConfig({ VITE_LAST_CONTRACT_ID: "last.near" }), null);
    await flush();
    expect(screen.getByText(/Configuration refused/)).toBeTruthy();
  });
});

describe("SIMULATED, Gate 1 contract (Gate 2 not available)", () => {
  it("is labelled SIMULATED and keeps Gate 2 actions disabled", async () => {
    const sim = new SimulatedChain({ gate2: false });
    await sim.connect();
    sim.balances.set(SIM_USER, 0n);
    sim.credits.set(SIM_USER, { available: 10n ** 22n, inFlight: 0n });
    await simulated(sim);
    expect(screen.getAllByText(/SIMULATED/).length).toBeGreaterThan(0);
    expect(screen.getByText("Gate 2 pending")).toBeTruthy();
    expect(button(/Withdraw — pending Gate 2/).disabled).toBe(true);
  });

  it("an eligible buy makes the user the leader (after a confirmed read)", async () => {
    const sim = new SimulatedChain({ gate2: false });
    await sim.connect();
    sim.balances.set(SIM_USER, 0n);
    sim.buy(SIM_USER, 3n * 10n ** 22n, 0n);
    await simulated(sim);
    expect(screen.getByText(/That's you/)).toBeTruthy();
    expect(screen.getAllByText(/round active/).length).toBeGreaterThan(0);
  });
});

describe("SIMULATED, Gate 2 available", () => {
  it("expired round offers Settle and blocks trading", async () => {
    let now = 1_000n * 10n ** 9n;
    const sim = new SimulatedChain({ gate2: true, now: () => now });
    await sim.connect();
    sim.balances.set(SIM_USER, 0n);
    sim.buy(SIM_USER, 3n * 10n ** 22n, 0n);
    now += 121n * 10n ** 9n; // past the 120 s deadline
    await simulated(sim);
    expect(screen.getAllByText(/EXPIRED/).length).toBeGreaterThan(0);
    expect(button(/Settle round #1/).disabled).toBe(false);
    expect(button(/Round over — settle first/).disabled).toBe(true);
  });
});

describe("while the contract is being probed", () => {
  it("never claims the contract is not deployed", async () => {
    const pending = new Promise<never>(() => undefined); // probe that never answers
    const sim = new SimulatedChain();
    const reader = Object.assign(Object.create(sim), { kind: "live", getCapabilities: () => pending }) as LastReader;
    mount(resolveConfig({ VITE_LAST_CONTRACT_ID: "last.testnet" }), reader);
    await flush();
    expect(screen.queryByText(/CONTRACT NOT DEPLOYED/)).toBeNull();
    expect(screen.getAllByText(/Connecting to contract/).length).toBeGreaterThan(0);
    expect(screen.getByText("CHECKING…")).toBeTruthy();
  });
});

describe("RPC outage at load (reported during Gate 4)", () => {
  it("retries a failed deployment probe automatically and recovers", async () => {
    const sim = new SimulatedChain();
    let calls = 0;
    const reader = Object.assign(Object.create(sim), {
      kind: "live",
      getCapabilities: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("All RPC endpoints failed — Failed to fetch"), { name: "RpcError" });
        return sim.getCapabilities();
      },
    }) as LastReader;
    mount(resolveConfig({ VITE_LAST_CONTRACT_ID: "last.testnet" }), reader);
    await flush();
    expect(screen.getByText(/Cannot reach NEAR Testnet RPC/)).toBeTruthy();
    expect(screen.getByText(/retrying automatically/)).toBeTruthy();
    // first retry after 2 s → deployed, banner gone
    await waitFor(() => expect(screen.queryByText(/Cannot reach NEAR Testnet RPC/)).toBeNull(), { timeout: 4_000 });
    expect(calls).toBe(2);
  });
});

describe("RPC load (public endpoints rate-limit)", () => {
  function counting(fail = false) {
    const sim = new SimulatedChain();
    const calls: Record<string, number> = {};
    const reader = new Proxy(sim, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === "kind") return "live";
        if (typeof v !== "function" || typeof prop !== "string" || !prop.startsWith("get")) return typeof v === "function" ? v.bind(target) : v;
        return async (...args: unknown[]) => {
          calls[prop] = (calls[prop] ?? 0) + 1;
          if (fail && prop === "getGameState" && calls[prop]! > 1) throw Object.assign(new Error("Failed to fetch"), { name: "RpcError" });
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as LastReader;
    return { reader, calls };
  }

  it("light polls read only get_game_state while nothing moves", async () => {
    const { reader, calls } = counting();
    render(
      <LastProvider config={resolveConfig({ VITE_LAST_CONTRACT_ID: "last.testnet" })} reader={reader} writer={null} pollMs={20}>
        <App />
      </LastProvider>,
    );
    // waitFor (not one long act): lets React run the probe and the polling loop in real time
    await waitFor(() => expect(calls.getGameState ?? 0).toBeGreaterThan(10), { timeout: 3_000 });
    const game = calls.getGameState ?? 0;
    const market = calls.getMarketState ?? 0;
    expect(market).toBeLessThanOrEqual(Math.ceil(game / 2) + 2); // ≈ every 2nd poll, not every poll
    expect(calls.getStorageBounds).toBe(1); // read once
  });

  it("backs off while the RPC keeps failing", async () => {
    const { reader, calls } = counting(true);
    render(
      <LastProvider config={resolveConfig({ VITE_LAST_CONTRACT_ID: "last.testnet" })} reader={reader} writer={null} pollMs={20}>
        <App />
      </LastProvider>,
    );
    await waitFor(() => expect(screen.getByText(/data may be stale/)).toBeTruthy(), { timeout: 2_000 });
    const start = calls.getGameState!;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    await waitFor(() => expect(true).toBe(true)); // let pending React work flush
    // without back-off: ~30 polls in 600 ms; with ×2 back-off (20, 40, 80, 160, 320 ms): ≤ 7
    expect(calls.getGameState! - start).toBeLessThanOrEqual(8);
  });
});

describe("Council recommendations: starting pot + disclosure", () => {
  it("labels the carry-over as the Starting pot and discloses locked fees + full-access key", async () => {
    const sim = new SimulatedChain();
    sim.nextSeedPot = 795n * 10n ** 18n; // an idle round with a carried-over pot
    sim.treasury = 3n * 10n ** 21n;
    sim.ops = 10n ** 21n;
    await simulated(sim);
    expect(screen.getByText(/Starting pot/)).toBeTruthy();
    expect(screen.getByText(/joins the jackpot on the first eligible buy/)).toBeTruthy();
    expect(screen.getByText(/20% of every \$LAST fee/)).toBeTruthy();
    expect(screen.getByText(/now 0.004 NEAR/)).toBeTruthy(); // treasury + ops, read from state
    expect(screen.getAllByText(/the contract is not immutable/).length).toBeGreaterThan(0);
    expect(screen.getByText(/still holds a full-access key/)).toBeTruthy();
  });
});
