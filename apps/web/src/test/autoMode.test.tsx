// Auto mode + settle-in-the-same-transaction, through the real React tree (SIMULATED chain, no
// network, no wallet, no key on any chain).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { resolveConfig } from "../config";
import { LastProvider } from "../hooks/useLast";
import { SIM_USER, SimulatedChain } from "../lib/mock";
import { SimulatedSessionManager } from "../lib/sessionKey";
import type { LastWriter } from "../lib/wallet";

afterEach(() => cleanup());

const S = 1_000_000_000n;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const hero = () => screen.getByRole("region", { name: /LAST live game/ });

async function setup(leader: string) {
  let now = 1_000n * S;
  const sim = new SimulatedChain({ gate2: true, now: () => now, latencyMs: 0, bots: false });
  sim.balances.set(leader, 0n);
  sim.balances.set(SIM_USER, 0n);
  sim.buy(leader, 5n * 10n ** 22n, 0n); // leader holds round 1
  now += 121n * S; // expired on-"chain"
  const wallet: string[][] = [];
  const writer: LastWriter = Object.assign(Object.create(sim), {
    send: (tx: Parameters<LastWriter["send"]>[0]) => {
      wallet.push(tx.actions.map((a) => (a.type === "FunctionCall" ? a.params.methodName : a.type)));
      return sim.send(tx);
    },
  });
  await sim.connect();
  const session = new SimulatedSessionManager(sim.contractId, (tx) => sim.send(tx));
  render(
    <LastProvider config={resolveConfig({ MODE: "mock", DEV: true })} reader={sim} writer={writer} session={session} pollMs={50} verifyIntervalMs={0} autoSettleGraceMs={0}>
      <App />
    </LastProvider>,
  );
  await flush();
  await flush();
  return { sim, wallet };
}

describe("auto mode (session key)", () => {
  it("the winner's round is settled AND paid with no wallet popup once enabled", async () => {
    const { sim, wallet } = await setup(SIM_USER);
    const before = sim.near.get(SIM_USER) ?? 0n;
    fireEvent.click(button(/Enable — 1 signature/));
    await waitFor(() => expect(screen.getAllByText(/Prize paid to your wallet/).length).toBeGreaterThan(0), { timeout: 4_000 });
    expect((sim.near.get(SIM_USER) ?? 0n) > before - 5n * 10n ** 23n).toBe(true); // prize paid (0.5 NEAR went to the play balance)
    expect(wallet).toEqual([["deposit_balance"]]); // the one signature fills the play balance (simulated: no key)
    expect((await sim.getRound(1n))?.claimStatus).toBe("PAID");
  });

  it("someone else's expired round is settled for everyone; the winner's prize stays theirs", async () => {
    const { sim, wallet } = await setup("rival.simulated");
    fireEvent.click(button(/Enable — 1 signature/));
    await waitFor(() => expect(within(hero()).getByText(/Round #1 settled on-chain/)).toBeTruthy(), { timeout: 4_000 });
    const r = await sim.getRound(1n);
    expect(r?.winner).toBe("rival.simulated");
    expect(r?.claimStatus).toBe("AVAILABLE"); // only the winner can claim it
    expect(wallet).toEqual([["deposit_balance"]]);
  });
});

describe("instant trading (play balance)", () => {
  it("after ONE signature, buys need no wallet popup", async () => {
    const sim = new SimulatedChain({ gate2: true, latencyMs: 0, bots: false });
    sim.balances.set(SIM_USER, 0n); // registered
    await sim.connect();
    const wallet: string[][] = [];
    const writer: LastWriter = Object.assign(Object.create(sim), {
      send: (tx: Parameters<LastWriter["send"]>[0]) => {
        wallet.push(tx.actions.map((a) => (a.type === "FunctionCall" ? a.params.methodName : a.type)));
        return sim.send(tx);
      },
    });
    const session = new SimulatedSessionManager(sim.contractId, (tx) => sim.send(tx));
    render(
      <LastProvider config={resolveConfig({ MODE: "mock", DEV: true })} reader={sim} writer={writer} session={session} pollMs={50} verifyIntervalMs={0}>
        <App />
      </LastProvider>,
    );
    await flush();
    await flush();
    fireEvent.click(button(/Enable — 1 signature/));
    await waitFor(() => expect(sim.credits.get(SIM_USER)?.available).toBe(5n * 10n ** 23n)); // 0.5 NEAR
    expect(wallet).toEqual([["deposit_balance"]]);

    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.05" } });
    await waitFor(() => expect(button(/Buy & steal the crown — instant/).disabled).toBe(false));
    fireEvent.click(button(/Buy & steal the crown — instant/));
    await waitFor(() => expect(screen.getAllByText(/you took the crown/i).length).toBeGreaterThan(0));
    expect(within(hero()).getByText(/That's you/)).toBeTruthy();
    expect(sim.credits.get(SIM_USER)?.available).toBe(45n * 10n ** 22n); // 0.5 - 0.05
    expect(wallet).toEqual([["deposit_balance"]]); // still only the one signature

    // A big instant buy (> 5x the minimum) needs a second tap.
    const before = sim.credits.get(SIM_USER)!.available;
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.2" } });
    await waitFor(() => expect(button(/— instant/).disabled).toBe(false));
    fireEvent.click(button(/— instant/));
    await waitFor(() => expect(button(/Tap again to confirm/)).toBeTruthy());
    expect(sim.credits.get(SIM_USER)!.available).toBe(before); // nothing spent yet
    fireEvent.click(button(/Tap again to confirm/));
    await waitFor(() => expect(sim.credits.get(SIM_USER)!.available).toBe(before - 2n * 10n ** 23n));
    expect(screen.getAllByText(/TESTNET · no value|SIMULATED/).length).toBeGreaterThan(0);
  });
});

describe("buy on an expired round", () => {
  it("settles it first in the SAME transaction, then the buy opens round 2", async () => {
    const { sim, wallet } = await setup("rival.simulated");
    expect(screen.getByText(/This transaction first settles it/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: "0.05" } });
    await waitFor(() => expect(button(/Settle & buy — open the next round/).disabled).toBe(false));
    fireEvent.click(button(/Settle & buy — open the next round/));
    await waitFor(() => expect(screen.getAllByText(/you took the crown/i).length).toBeGreaterThan(0), { timeout: 4_000 });
    expect(wallet).toEqual([["settle_round", "buy"]]); // one signature
    expect((await sim.getRound(1n))?.winner).toBe("rival.simulated");
    expect(within(hero()).getByText(/Round #2/)).toBeTruthy();
  });
});
