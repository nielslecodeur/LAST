import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode, serializeTx, sha256, signTx } from "./nearTx";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Vector produced with @near-js/transactions 2.x (createTransaction + encodeTransaction): our bytes
// were byte-identical (227 bytes), so the sha256 below pins the borsh layout.
const VECTOR = {
  signerId: "nifelst.testnet",
  publicKey: new Uint8Array(32).map((_, i) => i + 1),
  nonce: 123456789012345n,
  receiverId: "last-armand.testnet",
  blockHash: new Uint8Array(32).map((_, i) => 255 - i),
  actions: [
    { methodName: "settle_round", args: {}, gas: 30_000_000_000_000n, deposit: 0n },
    { methodName: "claim_reward", args: { round_id: "3" }, gas: 50_000_000_000_000n, deposit: 0n },
  ],
};

describe("NEAR transaction encoding", () => {
  it("matches the @near-js/transactions borsh layout", async () => {
    const bytes = serializeTx(VECTOR);
    expect(bytes.length).toBe(227);
    expect(hex(await sha256(bytes))).toBe("9b55c36891e03343abb126fb9cbdb0773c5bb23750138c466c2ba7b176e91dc3");
  });

  it("base58 round-trips, keeping leading zero bytes", () => {
    const raw = new Uint8Array([0, 0, 1, 2, 250, 251]);
    expect(base58Decode(base58Encode(raw))).toEqual(raw);
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });

  it("signs sha256(tx) with ed25519; the signature verifies against the public key", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const tx = { ...VECTOR, publicKey: pub };
    const { signed, hash } = await signTx(tx, kp.privateKey);
    const body = serializeTx(tx);
    expect(signed.length).toBe(body.length + 65);
    expect(signed[body.length]).toBe(0); // ed25519 key type
    const digest = await sha256(body);
    expect(hash).toBe(base58Encode(digest));
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, signed.slice(body.length + 1) as BufferSource, digest as BufferSource);
    expect(ok).toBe(true);
  });

  it("refuses out-of-range integers", () => {
    expect(() => serializeTx({ ...VECTOR, nonce: -1n })).toThrow();
    expect(() => serializeTx({ ...VECTOR, actions: [{ ...VECTOR.actions[0]!, deposit: 1n << 128n }] })).toThrow();
  });
});
