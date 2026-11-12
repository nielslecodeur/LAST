/**
 * Read layer: every view method of CONTRACT_API v0.2 behind one interface, with a live (RPC)
 * implementation here and a SIMULATED one in `mock.ts`. Views never sign and never cost gas.
 */

import { FeatureUnavailableError } from "./errors";
import { RpcError, type RpcClient, viewAccountBalance, viewCode, viewFunction } from "./rpc";
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
  getNearBalance(accountId: string): Promise<bigint>;
  /** Gate 2. Throws FeatureUnavailableError when the contract does not export it. */
  getRound(roundId: bigint): Promise<RoundView | null>;
  /** Which Gate 2 methods exist in the deployed code. */
  getCapabilities(): Promise<Capabilities>;
}

/** Result of probing the configured contract account before reading anything else. */
export type DeploymentStatus =
  | { state: "deployed"; capabilities: Capabilities }
  | { state: "no_account" }
  | { state: "no_code" };

export function capabilitiesFromExports(exports: Set<string>): Capabilities {
  return {
    settleRound: exports.has("settle_round"),
    claimReward: exports.has("claim_reward"),
    withdrawNearCredit: exports.has("withdraw_near_credit"),
    getRound: exports.has("get_round"),
    source: "wasm-exports",
  };
}

export class LiveLastReader implements LastReader {
  readonly kind = "live" as const;
  private caps: Capabilities | null = null;

  constructor(private readonly rpc: RpcClient, readonly contractId: string) {}

  private view<T>(method: string, args: Record<string, unknown> = {}) {
    return viewFunction<T>(this.rpc, this.contractId, method, args);
  }

  /** Distinguishes "account missing" / "no code" from a real deployment, and caches capabilities. */
  async probeDeployment(): Promise<DeploymentStatus> {
    try {
      const code = await viewCode(this.rpc, this.contractId);
      this.caps = capabilitiesFromExports(wasmFunctionExports(code));
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
  async getRound(roundId: bigint) {
    const caps = await this.getCapabilities();
    if (!caps.getRound) throw new FeatureUnavailableError("get_round");
    return parseRound(await this.view("get_round", { round_id: roundId.toString() }));
  }
}
