// UI FLOW tests (jsdom) through the real React tree, the real tx lifecycle and the real outcome
// parsing — MOCKED chain: the SIMULATED adapter (or a stub). No network, no wallet, no signature.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { resolveConfig } from "../config";
import { LastProvider } from "../hooks/useLast";
import { SIM_USER, SimulatedChain } from "../lib/mock";
import type { LastReader } from "../lib/reader";
import type { LastWriter } from "../lib/wallet";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

const NEAR = 10n ** 24n;
const S = 1_000_000_000n;
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function mount(reader: LastReader, writer: LastWriter, simulatedConfig = true) {
  const config = simulatedConfig ? resolveConfig({ MODE: "mock", DEV: true }) : resolveConfig({ VITE_LAST_CONTRACT_ID: "last.testnet" });
  return render(
    <LastProvider config={config} reader={reader} writer={writer} pollMs={60_000} verifyIntervalMs={0}>
      <App />
    </LastProvider>,
  );
}

const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const hero = () => screen.getByRole("region", { name: /LAST live game/ });

async function ready() {
  await flush();
  await flush();
}

describe("buy flows", () => {
  it("a buy below the minimum gives tokens but does NOT steal the crown", async () => {
    const sim = new SimulatedChain({ latencyMs: 0 });
    sim.balances.set("rival.simulated", 0n);
    sim.buy("rival.simulated", 5n * 10n ** 22n, 0n); // rival holds the crown
    sim.balances.set(SIM_USER, 0n);
    await sim.connect();
    mount(sim, sim);
    await ready();
    expect(within(hero()).getByText(/rival\.simulated/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.01" } });
    await waitFor(() => expect(screen.getByText(/tokens only, no crown/)).toBeTruthy());
    fireEvent.click(button(/^Buy \$LAST$/));
    await waitFor(() => expect(screen.getAllByText(/crown and timer unchanged/).length).toBeGreaterThan(0));
    expect(within(hero()).getByText(/rival\.simulated/)).toBeTruthy(); // crown unchanged
    expect(sim.balances.get(SIM_USER)! > 0n).toBe(true); // but tokens received
  });

  it("an eligible buy from an unregistered wallet registers + steals the crown in one transaction", async () => {
    const sim = new SimulatedChain({ latencyMs: 0 });
    sim.balances.set("rival.simulated", 0n);
    sim.buy("rival.simulated", 5n * 10n ** 22n, 0n);
    await sim.connect();
    mount(sim, sim);
    await ready();
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.1" } });
    await waitFor(() => expect(screen.getByText(/Storage registration \(once\)/)).toBeTruthy());
    await waitFor(() => expect(button(/Buy \$LAST & steal the crown/).disabled).toBe(false));
    fireEvent.click(button(/Buy \$LAST & steal the crown/));
    await waitFor(() => expect(screen.getAllByText(/you took the crown/).length).toBeGreaterThan(0));
    expect(within(hero()).getByText(/That's you/)).toBeTruthy();
    expect(sim.balances.has(SIM_USER)).toBe(true);
  });
});

describe("stale registration (Gate 4 finding)", () => {
  it("re-reads registration before signing: no storage_deposit for an already registered account", async () => {
    const sim = new SimulatedChain({ latencyMs: 0 });
    await sim.connect();
    sim.balances.set(SIM_USER, 0n); // registered on-chain
    let stale = true; // polled data says "not registered" (e.g. RPC was rate-limited)
    const reader: LastReader = Object.assign(Object.create(sim), {
      getAccountState: async (id: string) => ({ ...(await sim.getAccountState(id)), registered: stale ? false : true }),
    });
    const sent: string[][] = [];
    const writer: LastWriter = Object.assign(Object.create(sim), {
      send: (tx: Parameters<LastWriter["send"]>[0]) => {
        sent.push(tx.actions.map((a) => a.params.methodName));
        return sim.send(tx);
      },
    });
    mount(reader, writer);
    await ready();
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.05" } });
    await waitFor(() => expect(screen.getByText(/Storage registration \(once\)/)).toBeTruthy()); // stale UI
    await waitFor(() => expect(button(/Buy \$LAST & steal the crown/).disabled).toBe(false));
    stale = false; // the chain truth, read at submit time
    fireEvent.click(button(/Buy \$LAST & steal the crown/));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual(["buy"]);
  });
});

describe("expiry → settle → claim → double claim rejected (Gate 2 simulated)", () => {
  it("runs the whole end of round, confirming each step from contract state", async () => {
    window.history.replaceState({}, "", "/?demo=1");
    let now = 1_000n * S;
    const sim = new SimulatedChain({ gate2: true, now: () => now, latencyMs: 0 });
    await sim.connect();
    sim.balances.set(SIM_USER, 0n);
    sim.buy(SIM_USER, 5n * 10n ** 22n, 0n); // you lead round 1
    now += 121n * S; // deadline passed on-"chain"
    mount(sim, sim);
    await ready();

    // Expired on-chain, not settled: trading blocked, settle offered, you are told it is pending.
    expect(screen.getAllByText(/settlement pending/i).length).toBeGreaterThan(0);
    expect(button(/Round over — settle first/).disabled).toBe(true);
    fireEvent.click(button(/Settle round #1/));
    await waitFor(() => expect(screen.getByText(/Round #1 settled on-chain/)).toBeTruthy());

    // The winner claims; confirmation requires claim_status PAID on-chain.
    const before = sim.near.get(SIM_USER)!;
    await waitFor(() => expect(button(/^Claim reward$/).disabled).toBe(false));
    fireEvent.click(button(/^Claim reward$/));
    await waitFor(() => expect(screen.getAllByText(/Prize paid to your wallet/).length).toBeGreaterThan(0));
    expect(sim.near.get(SIM_USER)! > before).toBe(true);

    // Double claim: the CONTRACT rejects it (ERR_ALREADY_PAID), nothing is paid twice.
    const afterFirst = sim.near.get(SIM_USER)!;
    fireEvent.click(button(/Claim round #1 again/));
    await waitFor(() => expect(screen.getAllByText(/already paid/).length).toBeGreaterThan(0));
    expect(sim.near.get(SIM_USER)).toBe(afterFirst);

    // A new round can start.
    expect(screen.getAllByText(/crown up for grabs/).length).toBeGreaterThan(0);
    expect(within(hero()).getByText(/Round #2/)).toBeTruthy();
  });
});

describe("wallet & network failures", () => {
  it("wallet rejection is shown as rejected, nothing is marked confirmed", async () => {
    const sim = new SimulatedChain({ latencyMs: 0 });
    await sim.connect();
    sim.balances.set(SIM_USER, 0n);
    const writer: LastWriter = Object.assign(Object.create(sim), {
      send: async () => {
        throw new Error("User rejected the request");
      },
    });
    mount(sim, writer);
    await ready();
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.05" } });
    await waitFor(() => expect(button(/Buy \$LAST & steal the crown/).disabled).toBe(false));
    fireEvent.click(button(/Buy \$LAST & steal the crown/));
    await waitFor(() => expect(screen.getByText(/Rejected in wallet/)).toBeTruthy());
    expect(screen.queryByText(/^Confirmed/)).toBeNull();
  });

  it("while the wallet is open the UI shows the pending state and blocks a second transaction", async () => {
    const sim = new SimulatedChain({ latencyMs: 0 });
    await sim.connect();
    sim.balances.set(SIM_USER, 0n);
    let release: () => void = () => undefined;
    const writer: LastWriter = Object.assign(Object.create(sim), {
      send: (tx: Parameters<LastWriter["send"]>[0]) => new Promise((res) => (release = () => res(sim.send(tx)))),
    });
    mount(sim, writer);
    await ready();
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.05" } });
    await waitFor(() => expect(button(/Buy \$LAST & steal the crown/).disabled).toBe(false));
    fireEvent.click(button(/Buy \$LAST & steal the crown/));
    await waitFor(() => expect(screen.getByText(/Confirm in your wallet/)).toBeTruthy());
    expect(button(/Confirm in wallet…/).disabled).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(screen.getAllByText(/you took the crown/).length).toBeGreaterThan(0));
  });

  it("RPC failure keeps the last real values as stale — no simulated fallback", async () => {
    const sim = new SimulatedChain({ latencyMs: 0 });
    let fail = false;
    const reader: LastReader = Object.assign(Object.create(sim), {
      kind: "live",
      getGameState: async () => {
        if (fail) throw Object.assign(new Error("Cannot reach rpc"), { name: "RpcError" });
        return sim.getGameState();
      },
    });
    const { rerender } = mount(reader, sim, false);
    await ready();
    expect(screen.queryByText(/data may be stale/)).toBeNull();
    fail = true;
    // trigger a refresh via focus (resync path)
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.getByText(/data may be stale/)).toBeTruthy());
    expect(screen.queryByText(/SIMULATED —/)).toBeNull();
    void rerender;
  });

  it("a mainnet wallet account is refused in live mode", async () => {
    const sim = new SimulatedChain({ latencyMs: 0 });
    const reader: LastReader = Object.assign(Object.create(sim), { kind: "live" });
    const writer: LastWriter = Object.assign(Object.create(sim), { getAccountId: async () => "alice.near" });
    mount(reader, writer, false);
    await ready();
    await waitFor(() => expect(screen.getAllByText(/not a NEAR Testnet account/).length).toBeGreaterThan(0));
    expect(button(/^Wrong network$/).disabled).toBe(true);
  });

  it("a wallet with no NEAR cannot buy", async () => {
    const sim = new SimulatedChain({ latencyMs: 0 });
    await sim.connect();
    sim.balances.set(SIM_USER, 0n);
    sim.near.set(SIM_USER, 0n);
    mount(sim, sim);
    await ready();
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.05" } });
    await waitFor(() => expect(button(/Insufficient NEAR/).disabled).toBe(true));
    expect(screen.getByText(/testnet faucet/)).toBeTruthy();
    expect(NEAR).toBe(10n ** 24n);
  });
});
