/**
 * Read layer: every view method of CONTRACT_API v0.2 behind one interface, with a live (RPC)
 * implementation here and a SIMULATED one in `mock.ts`. Views never sign and never cost gas.
 */

import { FeatureUnavailableError } from "./errors";
import { EMPTY_CODE_HASH, RpcError, type RpcClient, chainId, gasPrice, viewAccountBalance, viewCode, viewCodeHash, viewFunction } from "./rpc";
import {
  type AccountState,
  type BuyQuote,
  type Capabilities,
  type GameState,
  type Integrity,
  type MarketState,
  NO_GATE2,
  type RoundView,
  type SellQuote,
  type StorageBounds,
  parseAccountState,
  parseBuyQuote,
  parseGameState,
  parseIntegrity,
  parseMarketState,
  parseRound,
  parseSellQuote,
  parseStorageBounds,
} from "./types";
import { wasmFunctionExports } from "./wasm";

export interface LastReader {
  readonly kind: "live" | "simulated";
  readonly contractId: string;
  getGameState(): Promise<GameState>;
  getMarketState(): Promise<MarketState>;
  getAccountState(accountId: string): Promise<AccountState>;
  getIntegrity(): Promise<Integrity>;
  quoteBuy(grossNear: bigint): Promise<BuyQuote>;
  quoteSell(tokensIn: bigint): Promise<SellQuote>;
  getStorageBounds(): Promise<StorageBounds>;
  /** Spendable NEAR (storage-locked part excluded). */
  getNearBalance(accountId: string): Promise<bigint>;
  /** NEAR network gas price, yoctoNEAR per gas unit. */
  getGasPrice(): Promise<bigint>;
  /** Gate 2. Throws FeatureUnavailableError when the contract does not export it. */
  getRound(roundId: bigint): Promise<RoundView | null>;
  /** Which Gate 2 methods exist in the deployed code. */
  getCapabilities(): Promise<Capabilities>;
}

/** Result of probing the configured contract account before reading anything else. */
export type DeploymentStatus =
  | { state: "deployed"; capabilities: Capabilities }
  | { state: "no_account" }
  | { state: "no_code" }
  /** The RPC endpoint is not NEAR Testnet (e.g. a mainnet URL was configured). Nothing is read. */
  | { state: "wrong_network"; chainId: string };

export function capabilitiesFromExports(exports: Set<string>): Capabilities {
  return {
    settleRound: exports.has("settle_round"),
    claimReward: exports.has("claim_reward"),
    withdrawNearCredit: exports.has("withdraw_near_credit"),
    getRound: exports.has("get_round"),
    source: "wasm-exports",
  };
}

export interface CapsCache {
  get(contractId: string, codeHash: string): Capabilities | null;
  set(contractId: string, codeHash: string, caps: Capabilities): void;
}

const capsKey = (id: string) => `last:caps:${id}`;

/** localStorage-backed; any storage failure just means "not cached". */
export const localCapsCache: CapsCache = {
  get(id, codeHash) {
    try {
      const raw = localStorage.getItem(capsKey(id));
      if (!raw) return null;
      const v = JSON.parse(raw) as { codeHash: string; caps: Capabilities };
      return v.codeHash === codeHash && v.caps?.source === "wasm-exports" ? v.caps : null;
    } catch {
      return null;
    }
  },
  set(id, codeHash, caps) {
    try {
      localStorage.setItem(capsKey(id), JSON.stringify({ codeHash, caps }));
    } catch {
      /* ignore */
    }
  },
};

export class LiveLastReader implements LastReader {
  readonly kind = "live" as const;
  private caps: Capabilities | null = null;

  constructor(
    private readonly rpc: RpcClient,
    readonly contractId: string,
    /** Capability cache keyed by contract code hash (default: localStorage, failures ignored). */
    private readonly cache: CapsCache = localCapsCache,
  ) {}

  private view<T>(method: string, args: Record<string, unknown> = {}) {
    return viewFunction<T>(this.rpc, this.contractId, method, args);
  }

  /**
   * Distinguishes "account missing" / "no code" from a real deployment and reads which Gate 2
   * methods the deployed WASM exports. The (large) code is downloaded only when its `code_hash`
   * is not in the cache: a redeploy changes the hash, so the cache can never hide new methods.
   */
  async probeDeployment(): Promise<DeploymentStatus> {
    const chain = await chainId(this.rpc);
    if (chain !== "testnet") return { state: "wrong_network", chainId: chain };
    try {
      const hash = await viewCodeHash(this.rpc, this.contractId);
      if (hash === EMPTY_CODE_HASH) return { state: "no_code" };
      const cached = hash ? this.cache.get(this.contractId, hash) : null;
      if (cached) {
        this.caps = cached;
        return { state: "deployed", capabilities: cached };
      }
      const code = await viewCode(this.rpc, this.contractId);
      this.caps = capabilitiesFromExports(wasmFunctionExports(code));
      if (hash) this.cache.set(this.contractId, hash, this.caps);
      return { state: "deployed", capabilities: this.caps };
    } catch (e) {
      if (e instanceof RpcError && e.kind === "unknown_account") return { state: "no_account" };
      if (e instanceof RpcError && e.kind === "no_contract_code") return { state: "no_code" };
      throw e;
    }
  }

  async getCapabilities(): Promise<Capabilities> {
    if (this.caps) return this.caps;
    try {
      const status = await this.probeDeployment();
      return status.state === "deployed" ? status.capabilities : NO_GATE2;
    } catch {
      return NO_GATE2; // unreadable code: keep every Gate 2 action off
    }
  }

  async getGameState() {
    return parseGameState(await this.view("get_game_state"));
  }
  async getMarketState() {
    return parseMarketState(await this.view("get_market_state"));
  }
  async getAccountState(accountId: string) {
    return parseAccountState(await this.view("get_account_state", { account_id: accountId }));
  }
  async getIntegrity() {
    return parseIntegrity(await this.view("get_integrity"));
  }
  async quoteBuy(grossNear: bigint) {
    return parseBuyQuote(await this.view("quote_buy", { gross_near: grossNear.toString() }));
  }
  async quoteSell(tokensIn: bigint) {
    return parseSellQuote(await this.view("quote_sell", { tokens_in: tokensIn.toString() }));
  }
  async getStorageBounds() {
    return parseStorageBounds(await this.view("storage_balance_bounds"));
  }
  async getNearBalance(accountId: string) {
    return viewAccountBalance(this.rpc, accountId);
  }
  async getGasPrice() {
    return gasPrice(this.rpc);
  }
  async getRound(roundId: bigint) {
    const caps = await this.getCapabilities();
    if (!caps.getRound) throw new FeatureUnavailableError("get_round");
    return parseRound(await this.view("get_round", { round_id: roundId.toString() }));
  }
}
