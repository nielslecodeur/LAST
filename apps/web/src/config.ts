/**
 * Runtime configuration. NEAR Testnet only (CLAUDE.md hard rule).
 *
 * Data source:
 *  - "live"          → VITE_LAST_CONTRACT_ID is a valid testnet account: real RPC views + wallet.
 *  - "not_deployed"  → no contract id: no financial data at all, every action disabled.
 *  - "simulated"     → `vite --mode mock` on the dev server only. Never reachable in a production
 *                      build, always labelled SIMULATED in the UI.
 *  - "config_error"  → a mainnet / malformed id was configured: refused, nothing is read.
 */

export const NETWORK_ID = "testnet" as const;

export type DataSource = "live" | "not_deployed" | "simulated" | "config_error";

export interface AppConfig {
  source: DataSource;
  contractId: string | null;
  rpcUrls: string[];
  explorerUrl: string;
  configError: string | null;
}

export const DEFAULT_RPC_URLS = ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"];
export const DEFAULT_EXPLORER_URL = "https://testnet.nearblocks.io";

/** NEAR account id rules (2–64 chars, lowercase, `-`/`_` separators, `.`-separated parts). */
const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID_RE.test(id);
}

/** Testnet accounts: named `*.testnet`, or 64-hex implicit accounts. Anything `.near` is mainnet. */
export function isTestnetAccountId(id: string): boolean {
  if (!isValidAccountId(id)) return false;
  return id.endsWith(".testnet") || /^[0-9a-f]{64}$/.test(id);
}

interface RawEnv {
  MODE?: string;
  DEV?: boolean;
  VITE_LAST_CONTRACT_ID?: string;
  VITE_NEAR_RPC_URLS?: string;
  VITE_EXPLORER_URL?: string;
}

export function resolveConfig(env: RawEnv): AppConfig {
  const rpcUrls = (env.VITE_NEAR_RPC_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.startsWith("https://"));
  const base = {
    rpcUrls: rpcUrls.length > 0 ? rpcUrls : DEFAULT_RPC_URLS,
    explorerUrl: (env.VITE_EXPLORER_URL ?? "").trim() || DEFAULT_EXPLORER_URL,
  };

  // Mock mode is a dev-server-only switch: `vite build --mode mock` still yields DEV=false.
  if (env.MODE === "mock" && env.DEV === true) {
    return { ...base, source: "simulated", contractId: "last.simulated", configError: null };
  }

  const id = (env.VITE_LAST_CONTRACT_ID ?? "").trim();
  if (id === "") {
    return { ...base, source: "not_deployed", contractId: null, configError: null };
  }
  if (!isTestnetAccountId(id)) {
    return {
      ...base,
      source: "config_error",
      contractId: null,
      configError: `"${id}" is not a NEAR Testnet account id. LAST runs on testnet only.`,
    };
  }
  return { ...base, source: "live", contractId: id, configError: null };
}

export const config: AppConfig = resolveConfig(import.meta.env as RawEnv);

export function explorerTxUrl(hash: string, base = config.explorerUrl): string {
  return `${base}/txns/${encodeURIComponent(hash)}`;
}

export function explorerAccountUrl(accountId: string, base = config.explorerUrl): string {
  return `${base}/address/${encodeURIComponent(accountId)}`;
}
