import { describe, expect, it } from "vitest";
import { PotReader, parseRound, parseState } from "./potReader";

const encode = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));

const STATE = {
  status: "ACTIVE",
  round_id: "3",
  leader: "alice.near",
  started_at_ns: "1",
  deadline_ns: "3600000000001",
  settle_after_ns: "3720000000001",
  eligible_buys: 2,
  last_tx_hash: "AbC123",
  pot: "1442175686116648000000000",
  prize_if_settled_now: "1297958117504983200000000",
  prizes_outstanding: "0",
  in_flight: "0",
  total_paid: "5",
  total_buys_recorded: "7",
  last_settled_round_id: "2",
  now_ns: "100",
};

describe("pot reader", () => {
  it("parses get_state with bigint amounts", () => {
    const s = parseState(STATE);
    expect(s.status).toBe("ACTIVE");
    expect(s.pot).toBe(1442175686116648000000000n);
    expect(s.deadlineNs).toBe(3600000000001n);
    expect(s.lastSettledRoundId).toBe(2n);
    expect(s.leader).toBe("alice.near");
  });

  it("parses an idle state with nulls", () => {
    const s = parseState({ ...STATE, status: "IDLE", leader: null, deadline_ns: null, started_at_ns: null, settle_after_ns: null, last_tx_hash: null, last_settled_round_id: null });
    expect(s.leader).toBeNull();
    expect(s.deadlineNs).toBeNull();
    expect(s.lastSettledRoundId).toBeNull();
  });

  it("rejects unknown statuses", () => {
    expect(() => parseState({ ...STATE, status: "WHATEVER" })).toThrow();
    expect(() => parseRound({ round_id: "1", winner: "a.near", prize: "1", started_at_ns: "1", ended_at_ns: "2", eligible_buys: 1, winning_tx_hash: "x", status: "NOPE" })).toThrow();
  });

  it("falls back to the next RPC endpoint and decodes the view result", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url === "https://bad.example") throw new Error("down");
      return { json: async () => ({ result: { result: encode(STATE) } }) } as Response;
    }) as unknown as typeof fetch;
    const r = new PotReader("pot.heavycat9990.near", ["https://bad.example", "https://good.example"], fake);
    const s = await r.state();
    expect(calls).toEqual(["https://bad.example", "https://good.example"]);
    expect(s.totalBuysRecorded).toBe(7n);
  });

  it("returns null for an unknown round", async () => {
    const fake = (async () => ({ json: async () => ({ result: { result: encode(null) } }) }) as Response) as unknown as typeof fetch;
    const r = new PotReader("pot.heavycat9990.near", ["https://x.example"], fake);
    expect(await r.round(9n)).toBeNull();
  });
});
