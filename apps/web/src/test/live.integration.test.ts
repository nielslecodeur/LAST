// REAL INTEGRATION (NEAR Testnet RPC, read-only — never signs, never spends).
// Skipped unless LAST_LIVE_CONTRACT_ID is set, e.g.:
//   LAST_LIVE_CONTRACT_ID=last-demo.testnet pnpm test src/test/live.integration.test.ts
// Run it only once Builder A has deployed the contract at Gate 3.
import { describe, expect, it } from "vitest";
import { DEFAULT_RPC_URLS, isTestnetAccountId } from "../config";
import { LiveLastReader } from "../lib/reader";
import { createRpcClient } from "../lib/rpc";
import { isSolvent } from "../lib/types";

const id = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LAST_LIVE_CONTRACT_ID;

describe.skipIf(!id)("LIVE testnet contract (read-only)", () => {
  const reader = new LiveLastReader(createRpcClient(DEFAULT_RPC_URLS), id ?? "");

  it("is a testnet account with deployed code", async () => {
    expect(isTestnetAccountId(id!)).toBe(true);
    const st = await reader.probeDeployment();
    expect(st.state).toBe("deployed");
  });

  it("views parse and are internally consistent", async () => {
    const [game, market, integrity, storage] = await Promise.all([
      reader.getGameState(),
      reader.getMarketState(),
      reader.getIntegrity(),
      reader.getStorageBounds(),
    ]);
    expect(["IDLE", "ACTIVE", "EXPIRED"]).toContain(game.status);
    expect(market.buyFeeBps).toBe(400);
    expect(market.sellFeeBps).toBe(200);
    expect(storage.min > 0n).toBe(true);
    expect(isSolvent(integrity)).toBe(true); // v0.3: balance + in_flight >= storage + obligations
    expect(integrity.marketNearReserve).toBe(market.nearReserve);
  });

  it("Gate 2 methods are exported by the deployed code", async () => {
    const caps = await reader.getCapabilities();
    expect(caps).toMatchObject({ settleRound: true, claimReward: true, withdrawNearCredit: true, getRound: true });
  });

  it("quote_buy at the minimum is eligible", async () => {
    const market = await reader.getMarketState();
    const q = await reader.quoteBuy(market.minEligibleBuy);
    expect(q.eligible).toBe(true);
    expect(q.fee + q.netNear).toBe(market.minEligibleBuy);
  });
});
