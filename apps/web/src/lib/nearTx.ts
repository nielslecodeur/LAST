/**
 * Minimal NEAR transaction encoding for the session key (no near-api-js dependency).
 * Only what LAST needs: an ed25519 key, FunctionCall actions, borsh serialization (Transaction V0),
 * sha256 + ed25519 signature via WebCrypto. Byte layout checked against @near-js/transactions
 * (see nearTx.test.ts).
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character "${c}"`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export interface FunctionCallSpec {
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

export interface UnsignedTx {
  signerId: string;
  /** Raw 32-byte ed25519 public key. */
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  /** Raw 32-byte block hash. */
  blockHash: Uint8Array;
  actions: FunctionCallSpec[];
}

class Writer {
  private buf: number[] = [];
  u8(v: number) {
    this.buf.push(v & 0xff);
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.buf.push((v >>> (8 * i)) & 0xff);
  }
  uint(v: bigint, bytes: number) {
    if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new RangeError("integer out of range");
    for (let i = 0; i < bytes; i++) this.buf.push(Number((v >> BigInt(8 * i)) & 0xffn));
  }
  raw(b: Uint8Array) {
    for (const x of b) this.buf.push(x);
  }
  bytes(b: Uint8Array) {
    this.u32(b.length);
    this.raw(b);
  }
  string(s: string) {
    this.bytes(new TextEncoder().encode(s));
  }
  done() {
    return Uint8Array.from(this.buf);
  }
}

const ED25519 = 0;
const ACTION_FUNCTION_CALL = 2;

/** Borsh `Transaction` (V0) — the bytes whose sha256 is signed. */
export function serializeTx(tx: UnsignedTx): Uint8Array {
  if (tx.publicKey.length !== 32) throw new Error("public key must be 32 bytes");
  if (tx.blockHash.length !== 32) throw new Error("block hash must be 32 bytes");
  const w = new Writer();
  w.string(tx.signerId);
  w.u8(ED25519);
  w.raw(tx.publicKey);
  w.uint(tx.nonce, 8);
  w.string(tx.receiverId);
  w.raw(tx.blockHash);
  w.u32(tx.actions.length);
  for (const a of tx.actions) {
    w.u8(ACTION_FUNCTION_CALL);
    w.string(a.methodName);
    w.bytes(new TextEncoder().encode(JSON.stringify(a.args)));
    w.uint(a.gas, 8);
    w.uint(a.deposit, 16);
  }
  return w.done();
}

/** Borsh `SignedTransaction`. */
export function serializeSignedTx(txBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("signature must be 64 bytes");
  const out = new Uint8Array(txBytes.length + 1 + 64);
  out.set(txBytes, 0);
  out[txBytes.length] = ED25519;
  out.set(signature, txBytes.length + 1);
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Signs sha256(tx) with an ed25519 CryptoKey. Returns the signed bytes and the tx hash (base58). */
export async function signTx(tx: UnsignedTx, privateKey: CryptoKey): Promise<{ signed: Uint8Array; hash: string }> {
  const bytes = serializeTx(tx);
  const digest = await sha256(bytes);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, digest as BufferSource));
  return { signed: serializeSignedTx(bytes, sig), hash: base58Encode(digest) };
}

/** "ed25519:<base58>" from a raw 32-byte public key. */
export function formatPublicKey(raw: Uint8Array): string {
  return `ed25519:${base58Encode(raw)}`;
}
