// UI tests (jsdom). MOCKED: no network, no wallet. "Not deployed" uses no reader at all; the other
// cases use the SIMULATED adapter. They check what the user sees in each state.
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
    expect(screen.getAllByText(/^ACTIVE$/).length).toBeGreaterThan(0);
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
