// MOCKED (fetch is stubbed — no real network). RPC errors, endpoint fallback, view decoding,
// deployment probing and Gate 2 detection from WASM exports.
import { describe, expect, it, vi } from "vitest";
import { LiveLastReader, capabilitiesFromExports } from "./reader";
import type { Capabilities } from "./types";
import { RpcError, createRpcClient, toBase64, viewFunction } from "./rpc";
import { wasmFunctionExports } from "./wasm";

const enc = new TextEncoder();
/** Resolves with the rejection reason; fails the test if the promise resolves. */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e as RpcError,
  );
const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), { status: 200 });
const viewResult = (value: unknown) => ok({ result: Array.from(enc.encode(JSON.stringify(value))), logs: [] });

/** Builds a minimal WASM module exporting the given function names. */
function wasmWithExports(names: string[]): Uint8Array {
  const body: number[] = [names.length];
  names.forEach((n, i) => {
    const b = Array.from(enc.encode(n));
    body.push(b.length, ...b, 0x00, i);
  });
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x01, 0x01, 0x00 /* empty type section */, 0x07, body.length, ...body]);
}

const GAME = {
  status: "ACTIVE",
  round_id: "3",
  leader: "bob.testnet",
  started_at_ns: "1000",
  deadline_ns: "121000000001000",
  active_pot: "28000000000000000000000",
  next_seed_pot: "4000000000000000000000",
  qualifying_buy_count: 7,
  last_settled_round_id: "2",
  now_ns: "1000",
};

describe("RPC client", () => {
  it("decodes a view call and sends base64 JSON args", async () => {
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.params.request_type).toBe("call_function");
      expect(atob(body.params.args_base64)).toBe('{"account_id":"a.testnet"}');
      return viewResult({ registered: true });
    });
    const rpc = createRpcClient(["https://a.example"], { fetch });
    await expect(viewFunction(rpc, "c.testnet", "get_account_state", { account_id: "a.testnet" })).resolves.toEqual({ registered: true });
  });

  it("falls back to the next endpoint on transport failure only", async () => {
    const fetch = vi
      .fn<(u: string, i: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(viewResult(1));
    const rpc = createRpcClient(["https://down.example", "https://up.example"], { fetch });
    await expect(viewFunction(rpc, "c.testnet", "x")).resolves.toBe(1);
    expect(fetch.mock.calls[1]![0]).toBe("https://up.example");
  });

  it("a -429 'endpoint deprecated' answer (HTTP 200) falls back to the next endpoint (Gate 4 finding)", async () => {
    const fetch = vi
      .fn<(u: string, i: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -429, message: "WARNING! THIS ENDPOINT IS DEPRECATED!" } })),
      )
      .mockResolvedValueOnce(viewResult(7));
    const rpc = createRpcClient(["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"], { fetch });
    await expect(viewFunction(rpc, "c.testnet", "x")).resolves.toBe(7);
    expect(fetch.mock.calls[1]![0]).toBe("https://test.rpc.fastnear.com");
  });

  it("default endpoints put FastNEAR first (rpc.testnet.near.org is deprecated)", async () => {
    const { DEFAULT_RPC_URLS } = await import("../config");
    expect(DEFAULT_RPC_URLS[0]).toBe("https://test.rpc.fastnear.com");
  });

  it("throws a network RpcError when every endpoint fails (no silent fallback)", async () => {
    const fetch = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const rpc = createRpcClient(["https://a.example", "https://b.example"], { fetch });
    const err = await failure(viewFunction(rpc, "c.testnet", "x"));
    expect(err).toBeInstanceOf(RpcError);
    expect(err.kind).toBe("network");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry semantic errors (unknown account)", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "account x does not exist while viewing" } }),
      ),
    );
    const rpc = createRpcClient(["https://a.example", "https://b.example"], { fetch });
    const err = await failure(viewFunction(rpc, "x.testnet", "get_game_state"));
    expect(err.kind).toBe("unknown_account");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies MethodNotFound and contract panics returned as result.error", async () => {
    const mk = (msg: string) => vi.fn(async () => ok({ error: msg, logs: [] }));
    const nf = createRpcClient(["https://a.example"], { fetch: mk("wasm execution failed with error: MethodResolveError(MethodNotFound)") });
    expect((await failure(viewFunction(nf, "c.testnet", "get_round"))).kind).toBe("method_not_found");
    const p = createRpcClient(["https://a.example"], { fetch: mk("Smart contract panicked: ERR_OVERFLOW") });
    const e = await failure(viewFunction(p, "c.testnet", "quote_buy"));
    expect(e.kind).toBe("contract_panic");
    expect(e.message).toContain("ERR_OVERFLOW");
  });
});

describe("WASM export parsing → Gate 2 capabilities", () => {
  it("reads function export names", () => {
    const names = wasmFunctionExports(wasmWithExports(["buy", "sell", "get_game_state"]));
    expect([...names]).toEqual(["buy", "sell", "get_game_state"]);
    expect(() => wasmFunctionExports(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });

  it("Gate 1 contract → every Gate 2 action off", () => {
    const caps = capabilitiesFromExports(wasmFunctionExports(wasmWithExports(["buy", "sell", "quote_buy", "get_account_state"])));
    expect(caps).toEqual({ settleRound: false, claimReward: false, withdrawNearCredit: false, getRound: false, source: "wasm-exports" });
  });

  it("Gate 2 contract → actions on", () => {
    const caps = capabilitiesFromExports(new Set(["settle_round", "claim_reward", "withdraw_near_credit", "get_round"]));
    expect(caps.settleRound && caps.claimReward && caps.withdrawNearCredit && caps.getRound).toBe(true);
  });
});

describe("LiveLastReader", () => {
  /** Stub RPC: answers `status` as testnet unless overridden; `handler` gets `query` params. */
  function reader(handler: (params: Record<string, unknown>) => Response, chain = "testnet") {
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "status") return ok({ chain_id: chain });
      if (body.method === "gas_price") return ok({ gas_price: "100000000" });
      return handler(body.params);
    });
    return new LiveLastReader(createRpcClient(["https://a.example"], { fetch }), "last.testnet", { get: () => null, set: () => undefined });
  }

  it("probes: unknown account / no code / deployed", async () => {
    const noAcc = reader(() => new Response(JSON.stringify({ error: { cause: { name: "UNKNOWN_ACCOUNT" }, data: "" } })));
    await expect(noAcc.probeDeployment()).resolves.toEqual({ state: "no_account" });
    const noCode = reader(() => new Response(JSON.stringify({ error: { cause: { name: "NO_CONTRACT_CODE" }, data: "" } })));
    await expect(noCode.probeDeployment()).resolves.toEqual({ state: "no_code" });
    const dep = reader(() => ok({ code_base64: toBase64(wasmWithExports(["buy", "get_round"])) }));
    const st = await dep.probeDeployment();
    expect(st.state).toBe("deployed");
  });

  it("downloads the WASM once per code hash, then reuses the cached capabilities", async () => {
    const store = new Map<string, Capabilities>();
    const cache = {
      get: (id: string, h: string) => store.get(`${id}:${h}`) ?? null,
      set: (id: string, h: string, c: Capabilities) => void store.set(`${id}:${h}`, c),
    };
    const calls: string[] = [];
    let hash = "HASH_A";
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "status") return ok({ chain_id: "testnet" });
      calls.push(body.params.request_type);
      if (body.params.request_type === "view_account") return ok({ amount: "1", storage_usage: 1, code_hash: hash });
      return ok({ code_base64: toBase64(wasmWithExports(["settle_round", "claim_reward", "withdraw_near_credit", "get_round"])) });
    });
    const rpc = createRpcClient(["https://a.example"], { fetch });
    await new LiveLastReader(rpc, "last.testnet", cache).probeDeployment();
    await new LiveLastReader(rpc, "last.testnet", cache).probeDeployment();
    expect(calls).toEqual(["view_account", "view_code", "view_account"]); // second load: no download
    hash = "HASH_B"; // redeploy → new hash → re-download
    const st = await new LiveLastReader(rpc, "last.testnet", cache).probeDeployment();
    expect(calls.slice(3)).toEqual(["view_account", "view_code"]);
    expect(st.state === "deployed" && st.capabilities.claimReward).toBe(true);
  });

  it("empty code hash → no contract deployed", async () => {
    const r = reader(() => ok({ amount: "1", storage_usage: 1, code_hash: "11111111111111111111111111111111" }));
    await expect(r.probeDeployment()).resolves.toEqual({ state: "no_code" });
  });

  it("refuses a non-testnet RPC endpoint before reading anything", async () => {
    const calls: string[] = [];
    const r = reader((p) => {
      calls.push(String(p.request_type));
      return ok({});
    }, "mainnet");
    await expect(r.probeDeployment()).resolves.toEqual({ state: "wrong_network", chainId: "mainnet" });
    expect(calls).toEqual([]);
  });

  it("NEAR balance excludes the storage-locked part; gas price is read from the network", async () => {
    const r = reader(() => ok({ amount: "5000000000000000000000000", storage_usage: 182 }));
    // 5 NEAR − 182 bytes × 10^19
    await expect(r.getNearBalance("a.testnet")).resolves.toBe(5n * 10n ** 24n - 182n * 10n ** 19n);
    await expect(r.getGasPrice()).resolves.toBe(100_000_000n);
  });

  it("parses get_game_state into bigint fields", async () => {
    const r = reader(() => viewResult(GAME));
    const g = await r.getGameState();
    expect(g.status).toBe("ACTIVE");
    expect(g.activePot).toBe(28n * 10n ** 21n);
    expect(g.lastSettledRoundId).toBe(2n);
    expect(typeof g.qualifyingBuyCount).toBe("number");
  });

  it("rejects a malformed view instead of showing zeros", async () => {
    const r = reader(() => viewResult({ ...GAME, active_pot: 5 }));
    await expect(r.getGameState()).rejects.toThrow(/active_pot/);
    const r2 = reader(() => viewResult({ ...GAME, status: "PAUSED" }));
    await expect(r2.getGameState()).rejects.toThrow(/status/);
  });

  it("get_round is refused before Gate 2 without calling the contract", async () => {
    const calls: string[] = [];
    const r = reader((p) => {
      calls.push(String(p.request_type));
      return ok({ code_base64: toBase64(wasmWithExports(["buy"])) });
    });
    await expect(r.getRound(1n)).rejects.toThrow(/pending Gate 2/);
    expect(calls).toEqual(["view_account", "view_code"]); // probe only — never call_function get_round
  });

  it("unreadable code → capabilities stay off", async () => {
    const r = reader(() => new Response("x", { status: 500 }));
    const caps = await r.getCapabilities();
    expect(caps.source).toBe("unknown");
    expect(caps.claimReward).toBe(false);
  });
});
