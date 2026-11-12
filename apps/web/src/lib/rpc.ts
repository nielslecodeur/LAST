/**
 * Minimal NEAR JSON-RPC client (read-only). Only `query` requests: call_function, view_account,
 * view_code. Falls back to the next endpoint on *transport* failures only — a semantic error
 * (unknown account, contract panic, method not found) is reported, never retried or masked.
 */

export type RpcErrorKind =
  | "network" // fetch failed / timeout / non-2xx on every endpoint
  | "unknown_account"
  | "no_contract_code"
  | "method_not_found"
  | "contract_panic"
  | "rpc"; // any other JSON-RPC error

export class RpcError extends Error {
  constructor(public readonly kind: RpcErrorKind, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export type Finality = "final" | "optimistic";

export interface RpcClient {
  query<T = unknown>(params: Record<string, unknown>): Promise<T>;
  /** Any other JSON-RPC method (`status`, `gas_price`, …). */
  call<T = unknown>(method: string, params: unknown): Promise<T>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createRpcClient(urls: string[], opts: { fetch?: FetchLike; timeoutMs?: number } = {}): RpcClient {
  if (urls.length === 0) throw new Error("No RPC endpoint configured");
  const doFetch: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let preferred = 0;
  let nextId = 1;

  async function post(url: string, body: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new RpcError("network", `HTTP ${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError("network", `Cannot reach ${new URL(url).host}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(method: string, params: unknown): Promise<T> {
      const body = JSON.stringify({ jsonrpc: "2.0", id: String(nextId++), method, params });
      let lastErr: RpcError | null = null;
      for (let i = 0; i < urls.length; i++) {
        const idx = (preferred + i) % urls.length;
        let json: unknown;
        try {
          json = await post(urls[idx]!, body);
        } catch (e) {
          lastErr = e as RpcError;
          continue; // transport failure → next endpoint
        }
        preferred = idx;
        return unwrap<T>(json);
      }
      throw lastErr ?? new RpcError("network", "RPC unreachable");
  }

  return {
    call,
    query: <T>(params: Record<string, unknown>) => call<T>("query", params),
  };
}

function unwrap<T>(json: unknown): T {
  const j = json as { error?: RpcErrorBody; result?: { error?: string } & Record<string, unknown> };
  if (j.error) throw toRpcError(j.error);
  if (!j.result) throw new RpcError("rpc", "Empty RPC response");
  // call_function failures come back as `result.error` (string), not as a JSON-RPC error.
  if (typeof j.result.error === "string") throw classifyExecutionError(j.result.error);
  return j.result as T;
}

interface RpcErrorBody {
  name?: string;
  message?: string;
  data?: unknown;
  cause?: { name?: string; info?: unknown };
}

function toRpcError(e: RpcErrorBody): RpcError {
  const cause = e.cause?.name ?? "";
  const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "");
  if (cause === "UNKNOWN_ACCOUNT") return new RpcError("unknown_account", data || "Account does not exist");
  if (cause === "NO_CONTRACT_CODE") return new RpcError("no_contract_code", data || "No contract deployed");
  if (/does not exist while viewing/i.test(data)) return new RpcError("unknown_account", data);
  if (/CodeDoesNotExist|no contract code|contract code .* not/i.test(data)) {
    return new RpcError("no_contract_code", data);
  }
  if (cause === "CONTRACT_EXECUTION_ERROR" || /wasm execution failed/i.test(data)) {
    return classifyExecutionError(data);
  }
  return new RpcError("rpc", `${e.name ?? "RPC_ERROR"}: ${data || e.message || cause}`);
}

function classifyExecutionError(msg: string): RpcError {
  if (/MethodNotFound/i.test(msg)) return new RpcError("method_not_found", msg);
  if (/CodeDoesNotExist/i.test(msg)) return new RpcError("no_contract_code", msg);
  return new RpcError("contract_panic", msg);
}

// ---------- typed helpers ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function viewFunction<T = unknown>(
  rpc: RpcClient,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  finality: Finality = "final",
): Promise<T> {
  const res = await rpc.query<{ result: number[] }>({
    request_type: "call_function",
    finality,
    account_id: contractId,
    method_name: methodName,
    args_base64: toBase64(enc.encode(JSON.stringify(args))),
  });
  const text = dec.decode(Uint8Array.from(res.result));
  return (text === "" ? null : JSON.parse(text)) as T;
}

/** NEAR protocol storage staking price: 10^19 yoctoNEAR per byte (0.00001 NEAR / byte). */
export const STORAGE_BYTE_COST = 10n ** 19n;

/**
 * Spendable NEAR of an account: `amount` minus what its own storage locks
 * (`storage_usage × byte cost`). Showing the raw `amount` would overstate what a buy can use.
 */
export function spendableBalance(amount: bigint, storageUsageBytes: bigint): bigint {
  const locked = storageUsageBytes * STORAGE_BYTE_COST;
  return amount > locked ? amount - locked : 0n;
}

export async function viewAccountBalance(rpc: RpcClient, accountId: string): Promise<bigint> {
  const res = await rpc.query<{ amount: string; storage_usage: number }>({
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  if (typeof res.amount !== "string" || !/^\d+$/.test(res.amount)) {
    throw new RpcError("rpc", "view_account: bad amount");
  }
  const usage = Number.isSafeInteger(res.storage_usage) && res.storage_usage >= 0 ? BigInt(res.storage_usage) : 0n;
  return spendableBalance(BigInt(res.amount), usage);
}

/** Code hash of an account with no contract deployed. */
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

/** `code_hash` of an account (cheap: no code download). Null if the endpoint omits it. */
export async function viewCodeHash(rpc: RpcClient, accountId: string): Promise<string | null> {
  const res = await rpc.query<{ code_hash?: unknown }>({
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  return typeof res.code_hash === "string" ? res.code_hash : null;
}

/** Current network gas price in yoctoNEAR per gas unit (NEAR network fee, not a LAST fee). */
export async function gasPrice(rpc: RpcClient): Promise<bigint> {
  const res = await rpc.call<{ gas_price: string }>("gas_price", [null]);
  if (typeof res.gas_price !== "string" || !/^\d+$/.test(res.gas_price)) {
    throw new RpcError("rpc", "gas_price: bad value");
  }
  return BigInt(res.gas_price);
}

/** `chain_id` reported by the endpoint ("testnet" / "mainnet"). */
export async function chainId(rpc: RpcClient): Promise<string> {
  const res = await rpc.call<{ chain_id: string }>("status", []);
  return String(res.chain_id);
}

export async function viewCode(rpc: RpcClient, accountId: string): Promise<Uint8Array> {
  const res = await rpc.query<{ code_base64: string }>({
    request_type: "view_code",
    finality: "final",
    account_id: accountId,
  });
  return fromBase64(res.code_base64);
}
