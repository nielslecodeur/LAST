/**
 * Auto mode: a limited "session key" that settles and claims without a wallet popup.
 *
 * - Enabling = ONE wallet signature: an AddKey on the user's own account, restricted to
 *   `settle_round` + `claim_reward` on the LAST contract, with a 0.25 NEAR lifetime gas budget.
 *   A NEAR function-call key cannot attach any deposit, so it can never buy, sell or withdraw.
 * - The private key is a NON-extractable WebCrypto key kept in this browser's IndexedDB: page
 *   scripts can use it while the page is open but cannot read it out. Nothing leaves the browser.
 * - Every send is checked locally too: receiver = the contract, method in SESSION_METHODS, deposit 0.
 */

import { NETWORK_ID } from "../config";
import { type RpcClient, RpcError, toBase64 } from "./rpc";
import { base58Decode, formatPublicKey, signTx } from "./nearTx";
import {
  type ExecutionOutcomeLike,
  SESSION_METHODS,
  type TxRequest,
  buildAddSessionKeyTx,
  buildDeleteSessionKeyTx,
} from "./transactions";

export type SessionStatus = { state: "unsupported" } | { state: "off" } | { state: "on"; allowance: bigint | null };

export interface SessionManager {
  readonly kind: "wallet" | "simulated";
  /** Is a working session key present for this account (locally AND on-chain)? */
  status(accountId: string): Promise<SessionStatus>;
  /** Creates + stores a key and returns the wallet transaction that registers it (null = nothing to sign). */
  prepareEnable(accountId: string): Promise<TxRequest | null>;
  /** Drops a key whose registration was not signed. */
  discard(accountId: string): Promise<void>;
  /** Forgets the key locally and returns the wallet transaction that deletes it (+ `extra` keys) on-chain. */
  prepareDisable(accountId: string, extra?: string[]): Promise<TxRequest | null>;
  /** Function-call keys of the account for this contract other than the one stored here. */
  strayKeys(accountId: string): Promise<string[]>;
  /** Signs with the session key and broadcasts. */
  send(accountId: string, tx: TxRequest): Promise<ExecutionOutcomeLike>;
}

// ---------------- key storage ----------------

export interface KeyStore {
  get(id: string): Promise<CryptoKeyPair | null>;
  set(id: string, kp: CryptoKeyPair): Promise<void>;
  delete(id: string): Promise<void>;
}

export function memoryKeyStore(): KeyStore {
  const m = new Map<string, CryptoKeyPair>();
  return {
    get: async (id) => m.get(id) ?? null,
    set: async (id, kp) => void m.set(id, kp),
    delete: async (id) => void m.delete(id),
  };
}

/** IndexedDB store (CryptoKey objects are structured-cloneable, so non-extractable keys persist). */
export function idbKeyStore(dbName = "last-session-keys"): KeyStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const r = fn(db.transaction("keys", mode).objectStore("keys"));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: async (id) => ((await tx("readonly", (s) => s.get(id))) as CryptoKeyPair | undefined) ?? null,
    set: async (id, kp) => void (await tx("readwrite", (s) => s.put(kp, id))),
    delete: async (id) => void (await tx("readwrite", (s) => s.delete(id))),
  };
}

export async function ed25519Supported(): Promise<boolean> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return false;
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

/** Rejects anything the session key must never sign (defence in depth over the on-chain permission). */
export function assertSessionTx(tx: TxRequest, contractId: string): void {
  if (tx.receiverId !== contractId) throw new Error("Session key: wrong receiver");
  if (tx.actions.length === 0) throw new Error("Session key: empty transaction");
  for (const a of tx.actions) {
    if (a.type !== "FunctionCall") throw new Error("Session key: only function calls");
    if (!(SESSION_METHODS as readonly string[]).includes(a.params.methodName)) {
      throw new Error(`Session key: ${a.params.methodName} is not allowed`);
    }
    if (a.params.deposit !== "0") throw new Error("Session key: no deposit allowed");
  }
}

/** The key is gone on-chain (deleted, or allowance spent) — auto mode must switch off. */
export function isSessionKeyGone(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNKNOWN_ACCESS_KEY|AccessKeyNotFound|access key .* does not exist|NotEnoughAllowance|InvalidAccessKeyError/i.test(msg);
}

// ---------------- live (testnet) ----------------

interface AccessKeyView {
  nonce: number | string;
  block_hash: string;
  permission: "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
}

export class LiveSessionManager implements SessionManager {
  readonly kind = "wallet" as const;
  private nonces = new Map<string, bigint>();

  constructor(
    private readonly rpc: RpcClient,
    /** Client used to broadcast (longer timeout). */
    private readonly sendRpc: RpcClient,
    private readonly contractId: string,
    private readonly store: KeyStore = idbKeyStore(),
  ) {}

  private id(accountId: string) {
    return `${NETWORK_ID}:${this.contractId}:${accountId}`;
  }

  private async publicKey(kp: CryptoKeyPair): Promise<{ raw: Uint8Array; text: string }> {
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    return { raw, text: formatPublicKey(raw) };
  }

  private viewKey(accountId: string, publicKey: string) {
    return this.rpc.query<AccessKeyView>({
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
  }

  async status(accountId: string): Promise<SessionStatus> {
    if (!(await ed25519Supported())) return { state: "unsupported" };
    const kp = await this.store.get(this.id(accountId));
    if (!kp) return { state: "off" };
    const { text } = await this.publicKey(kp);
    try {
      const view = await this.viewKey(accountId, text);
      const p = view.permission;
      if (p === "FullAccess" || p.FunctionCall.receiver_id !== this.contractId) return { state: "off" };
      return { state: "on", allowance: p.FunctionCall.allowance === null ? null : BigInt(p.FunctionCall.allowance) };
    } catch (e) {
      // Only "the key does not exist" means off; an RPC outage must not discard a valid key.
      if (e instanceof RpcError && e.kind !== "network" && (e.kind === "unknown_account" || isSessionKeyGone(e))) return { state: "off" };
      throw e;
    }
  }

  async prepareEnable(accountId: string): Promise<TxRequest> {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    await this.store.set(this.id(accountId), kp); // stored BEFORE signing, so a signed key is never lost
    const { text } = await this.publicKey(kp);
    return buildAddSessionKeyTx(accountId, this.contractId, text);
  }

  async discard(accountId: string): Promise<void> {
    await this.store.delete(this.id(accountId));
  }

  async prepareDisable(accountId: string, extra: string[] = []): Promise<TxRequest | null> {
    const kp = await this.store.get(this.id(accountId));
    await this.store.delete(this.id(accountId));
    const keys = [...(kp ? [(await this.publicKey(kp)).text] : []), ...extra];
    return keys.length === 0 ? null : buildDeleteSessionKeyTx(accountId, keys, "Turn off instant trading");
  }

  async strayKeys(accountId: string): Promise<string[]> {
    const kp = await this.store.get(this.id(accountId));
    const mine = kp ? (await this.publicKey(kp)).text : null;
    const res = await this.rpc.query<{ keys?: Array<{ public_key: string; access_key: { permission: AccessKeyView["permission"] } }> }>({
      request_type: "view_access_key_list",
      finality: "final",
      account_id: accountId,
    });
    // Only keys limited to THIS contract and to session methods: never a full-access key.
    return (res.keys ?? [])
      .filter((k) => {
        const p = k.access_key.permission;
        return (
          p !== "FullAccess" &&
          p.FunctionCall.receiver_id === this.contractId &&
          p.FunctionCall.method_names.length > 0 &&
          p.FunctionCall.method_names.every((m) => (SESSION_METHODS as readonly string[]).includes(m)) &&
          k.public_key !== mine
        );
      })
      .map((k) => k.public_key);
  }

  async send(accountId: string, tx: TxRequest): Promise<ExecutionOutcomeLike> {
    assertSessionTx(tx, this.contractId);
    const kp = await this.store.get(this.id(accountId));
    if (!kp) throw new Error("Auto mode is off in this browser (no session key).");
    const pub = await this.publicKey(kp);
    const view = await this.viewKey(accountId, pub.text);
    const chainNonce = BigInt(view.nonce);
    const nonce = [chainNonce + 1n, (this.nonces.get(accountId) ?? 0n) + 1n].reduce((a, b) => (a > b ? a : b));
    this.nonces.set(accountId, nonce);
    const { signed } = await signTx(
      {
        signerId: accountId,
        publicKey: pub.raw,
        nonce,
        receiverId: tx.receiverId,
        blockHash: base58Decode(view.block_hash),
        actions: tx.actions.map((a) => {
          if (a.type !== "FunctionCall") throw new Error("unreachable");
          return { methodName: a.params.methodName, args: a.params.args, gas: BigInt(a.params.gas), deposit: 0n };
        }),
      },
      kp.privateKey,
    );
    return this.sendRpc.call<ExecutionOutcomeLike>("send_tx", {
      signed_tx_base64: toBase64(signed),
      wait_until: "EXECUTED_OPTIMISTIC",
    });
  }
}

// ---------------- simulated (local rehearsal) ----------------

/** `pnpm dev:mock`: auto mode without keys; transactions go straight to the local simulation. */
export class SimulatedSessionManager implements SessionManager {
  readonly kind = "simulated" as const;
  private on = new Set<string>();
  constructor(
    private readonly contractId: string,
    private readonly sendTx: (tx: TxRequest) => Promise<ExecutionOutcomeLike>,
  ) {}
  async status(accountId: string): Promise<SessionStatus> {
    return this.on.has(accountId) ? { state: "on", allowance: SIM_ALLOWANCE } : { state: "off" };
  }
  async prepareEnable(accountId: string): Promise<null> {
    this.on.add(accountId);
    return null;
  }
  async discard(accountId: string) {
    this.on.delete(accountId);
  }
  async prepareDisable(accountId: string): Promise<null> {
    this.on.delete(accountId);
    return null;
  }
  async strayKeys(): Promise<string[]> {
    return [];
  }
  async send(accountId: string, tx: TxRequest) {
    if (!this.on.has(accountId)) throw new Error("Auto mode is off.");
    assertSessionTx(tx, this.contractId);
    return this.sendTx(tx);
  }
}
const SIM_ALLOWANCE = 250_000_000_000_000_000_000_000n;
