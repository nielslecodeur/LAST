/**
 * Wallet layer. One verified path (SPEC §3): HOT Connect (`@hot-labs/near-connect`), the
 * connector the NEAR Wallet Selector repo now points to. It only lists wallets whose manifest
 * declares `testnet: true`, and we always pass `network: "testnet"`.
 *
 * The app never holds keys: every change call is approved in the user's wallet.
 */

import { NETWORK_ID } from "../config";
import type { ExecutionOutcomeLike, TxRequest } from "./transactions";

export interface LastWriter {
  readonly kind: "wallet" | "simulated";
  /** Signed-in account, or null. */
  getAccountId(): Promise<string | null>;
  connect(): Promise<string | null>;
  disconnect(): Promise<void>;
  onAccountChange(cb: (accountId: string | null) => void): () => void;
  /** Signs + sends. Resolves with the final execution outcome; throws on rejection/transport error. */
  send(tx: TxRequest): Promise<ExecutionOutcomeLike>;
  /** Several transactions in ONE wallet approval (in order). */
  sendMany(txs: TxRequest[]): Promise<ExecutionOutcomeLike[]>;
}

type Connector = import("@hot-labs/near-connect").NearConnector;

export class HotConnectWriter implements LastWriter {
  readonly kind = "wallet" as const;
  private connector: Promise<Connector> | null = null;
  private listeners = new Set<(id: string | null) => void>();

  constructor(private readonly rpcUrls: string[]) {}

  /** Lazy: the connector (and its wallet manifest fetch) loads only when the wallet is used. */
  private get(): Promise<Connector> {
    if (!this.connector) {
      this.connector = import("@hot-labs/near-connect").then(({ NearConnector }) => {
        const c = new NearConnector({
          network: NETWORK_ID,
          providers: { testnet: this.rpcUrls },
          features: { signAndSendTransaction: true, testnet: true },
          autoConnect: true,
          footerBranding: null,
        });
        c.on("wallet:signIn", (e) => this.emit(e.accounts[0]?.accountId ?? null));
        c.on("wallet:signOut", () => this.emit(null));
        return c;
      });
    }
    return this.connector;
  }

  private emit(id: string | null) {
    for (const l of this.listeners) l(id);
  }

  onAccountChange(cb: (id: string | null) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async getAccountId(): Promise<string | null> {
    try {
      const c = await this.get();
      const { accounts } = await c.getConnectedWallet();
      return accounts[0]?.accountId ?? null;
    } catch {
      return null; // not connected
    }
  }

  async connect(): Promise<string | null> {
    const c = await this.get();
    const wallet = await c.connect();
    const accounts = await wallet.getAccounts({ network: NETWORK_ID });
    const id = accounts[0]?.accountId ?? null;
    this.emit(id);
    return id;
  }

  async disconnect(): Promise<void> {
    const c = await this.get();
    await c.disconnect();
    this.emit(null);
  }

  async sendMany(txs: TxRequest[]): Promise<ExecutionOutcomeLike[]> {
    const c = await this.get();
    const wallet = await c.wallet();
    const outcomes = await wallet.signAndSendTransactions({
      network: NETWORK_ID,
      transactions: txs.map((tx) => ({ receiverId: tx.receiverId, actions: tx.actions })),
    });
    return outcomes as unknown as ExecutionOutcomeLike[];
  }

  async send(tx: TxRequest): Promise<ExecutionOutcomeLike> {
    const c = await this.get();
    const wallet = await c.wallet();
    const outcome = await wallet.signAndSendTransaction({
      network: NETWORK_ID,
      receiverId: tx.receiverId,
      actions: tx.actions,
    });
    return outcome as unknown as ExecutionOutcomeLike;
  }
}
