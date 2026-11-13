import { describe, expect, it } from "vitest";
import { nextAutoAction } from "./autoplay";
import { base58Encode, sha256 } from "./nearTx";
import { type RpcClient, fromBase64 } from "./rpc";
import { LiveSessionManager, assertSessionTx, isSessionKeyGone, memoryKeyStore } from "./sessionKey";
import { SESSION_ALLOWANCE, buildBuyTx, buildClaimTx, buildSettleAndClaimTx, buildSettleTx } from "./transactions";
import type { Capabilities, GameState } from "./types";

const C = "last.testnet";
const ME = "me.testnet";
const CAPS: Capabilities = { settleRound: true, claimReward: true, withdrawNearCredit: true, getRound: true, playBalance: true, source: "wasm-exports" };

function fakeRpc(opts: { keyExists: () => boolean; nonce?: number }) {
  const sent: string[] = [];
  const rpc: RpcClient = {
    async query<T>(params: Record<string, unknown>): Promise<T> {
      if (params.request_type !== "view_access_key") throw new Error("unexpected query");
      if (!opts.keyExists()) {
        const { RpcError } = await import("./rpc");
        throw new RpcError("contract_panic", `access key ${String(params.public_key)} does not exist while viewing`);
      }
      return {
        nonce: opts.nonce ?? 41,
        block_hash: base58Encode(new Uint8Array(32).fill(9)),
        permission: { FunctionCall: { allowance: SESSION_ALLOWANCE.toString(), receiver_id: C, method_names: ["settle_round", "claim_reward"] } },
      } as T;
    },
    async call<T>(method: string, params: unknown): Promise<T> {
      if (method !== "send_tx") throw new Error("unexpected call");
      sent.push((params as { signed_tx_base64: string }).signed_tx_base64);
      return { status: { SuccessValue: "" }, transaction: { hash: "h" }, receipts_outcome: [] } as T;
    },
  };
  return { rpc, sent };
}

describe("session key permissions", () => {
  it("the AddKey is limited to settle, claim and balance trades on the contract, with a 0.25 NEAR gas budget", async () => {
    const { rpc } = fakeRpc({ keyExists: () => false });
    const m = new LiveSessionManager(rpc, rpc, C, memoryKeyStore());
    const tx = (await m.prepareEnable(ME))!;
    expect(tx.receiverId).toBe(ME); // the user's own account
    const a = tx.actions[0]!;
    expect(a.type).toBe("AddKey");
    if (a.type !== "AddKey") return;
    expect(a.params.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(a.params.accessKey.permission).toEqual({ receiverId: C, allowance: "250000000000000000000000", methodNames: ["settle_round", "claim_reward", "buy_from_balance", "sell_to_balance"] });
  });

  it("refuses to sign anything that moves money or targets another contract", () => {
    expect(() => assertSessionTx(buildBuyTx({ contractId: C, grossYocto: 1n, minTokensOut: 0n, label: "b" }), C)).toThrow(/buy is not allowed/);
    expect(() => assertSessionTx(buildSettleTx("other.testnet", CAPS, 1n), C)).toThrow(/wrong receiver/);
    const withDeposit = buildSettleTx(C, CAPS, 1n);
    (withDeposit.actions[0] as { params: { deposit: string } }).params.deposit = "1";
    expect(() => assertSessionTx(withDeposit, C)).toThrow(/no deposit/);
    expect(() => assertSessionTx(buildSettleAndClaimTx(C, CAPS, 1n), C)).not.toThrow();
  });

  it("status: on when the key is on-chain, off when it was deleted", async () => {
    let exists = true;
    const { rpc } = fakeRpc({ keyExists: () => exists });
    const m = new LiveSessionManager(rpc, rpc, C, memoryKeyStore());
    expect((await m.status(ME)).state).toBe("off"); // no local key
    await m.prepareEnable(ME);
    expect(await m.status(ME)).toEqual({ state: "on", allowance: SESSION_ALLOWANCE });
    exists = false;
    expect((await m.status(ME)).state).toBe("off");
  });

  it("send: signs locally with nonce = chain nonce + 1 and broadcasts with send_tx", async () => {
    const { rpc, sent } = fakeRpc({ keyExists: () => true, nonce: 41 });
    const m = new LiveSessionManager(rpc, rpc, C, memoryKeyStore());
    await m.prepareEnable(ME);
    await m.send(ME, buildClaimTx(C, CAPS, 7n));
    await m.send(ME, buildClaimTx(C, CAPS, 8n)); // chain still says 41: local nonce must still increase
    const bytes = sent.map(fromBase64);
    const nonceAt = (b: Uint8Array) => {
      const off = 4 + ME.length + 1 + 32; // signer string + key type + key
      return new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, true);
    };
    expect(nonceAt(bytes[0]!)).toBe(42n);
    expect(nonceAt(bytes[1]!)).toBe(43n);
    expect((await sha256(bytes[0]!)).length).toBe(32);
  });

  it("send without a stored key fails instead of opening the wallet", async () => {
    const { rpc } = fakeRpc({ keyExists: () => true });
    const m = new LiveSessionManager(rpc, rpc, C, memoryKeyStore());
    await expect(m.send(ME, buildSettleTx(C, CAPS, 1n))).rejects.toThrow(/no session key/);
  });

  it("recognises a deleted key or a spent gas budget", () => {
    expect(isSessionKeyGone(new Error('{"InvalidTxError":{"InvalidAccessKeyError":{"NotEnoughAllowance":{}}}}'))).toBe(true);
    expect(isSessionKeyGone(new Error("access key ed25519:abc does not exist while viewing"))).toBe(true);
    expect(isSessionKeyGone(new Error("Cannot reach rpc"))).toBe(false);
  });
});

function game(p: Partial<GameState>): GameState {
  return {
    status: "EXPIRED",
    roundId: 3n,
    leader: "rival.testnet",
    startedAtNs: 1n,
    deadlineNs: 2n,
    activePot: 10n,
    nextSeedPot: 0n,
    qualifyingBuyCount: 1,
    lastSettledRoundId: 2n,
    nowNs: 3n,
    ...p,
  };
}
const base = { me: ME, caps: CAPS, claimable: [], expiredSeenAtMs: 1_000, nowMs: 1_000, graceMs: 20_000, tried: new Set<string>() };

describe("auto mode decisions", () => {
  it("the winner settles and claims at once", () => {
    expect(nextAutoAction({ ...base, game: game({ leader: ME }) })).toEqual({ key: "settle:3", type: "settle_claim", roundId: 3n });
  });

  it("someone else's round: settle only after the grace period", () => {
    expect(nextAutoAction({ ...base, game: game({}) })).toBeNull();
    expect(nextAutoAction({ ...base, game: game({}), nowMs: 21_000 })).toEqual({ key: "settle:3", type: "settle", roundId: 3n });
  });

  it("never acts on an ACTIVE round, and never retries a tried action", () => {
    expect(nextAutoAction({ ...base, game: game({ status: "ACTIVE", leader: ME }) })).toBeNull();
    expect(nextAutoAction({ ...base, game: game({ leader: ME }), tried: new Set(["settle:3"]) })).toBeNull();
  });

  it("claims AVAILABLE prizes, never an IN_FLIGHT one", () => {
    const round = (claimStatus: "AVAILABLE" | "IN_FLIGHT") =>
      ({ roundId: 2n, winner: ME, prize: 5n, startedAtNs: 0n, endedAtNs: 1n, qualifyingBuyCount: 1, claimStatus }) as never;
    const g = game({ status: "IDLE", leader: null });
    expect(nextAutoAction({ ...base, game: g, claimable: [{ roundId: 2n, round: round("AVAILABLE") }] })).toEqual({ key: "claim:2", type: "claim", roundId: 2n });
    expect(nextAutoAction({ ...base, game: g, claimable: [{ roundId: 2n, round: round("IN_FLIGHT") }] })).toBeNull();
  });

  it("does nothing without settle_round on the contract", () => {
    expect(nextAutoAction({ ...base, caps: { ...CAPS, settleRound: false }, game: game({ leader: ME }) })).toBeNull();
  });
});
