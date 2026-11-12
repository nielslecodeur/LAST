/**
 * Error classification for the UI. Contract errors are panics whose message starts with an
 * `ERR_*` code (CONTRACT_API §6); wallet rejections and RPC failures are told apart so the user
 * gets an actionable message and nothing is ever retried or "mocked" silently.
 */

export const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  ERR_ZERO_DEPOSIT: "Enter an amount to buy.",
  ERR_NOT_REGISTERED: "Your account is not registered for LAST storage yet.",
  ERR_ROUND_EXPIRED: "The round is over. It must be settled before trading resumes.",
  ERR_ZERO_OUTPUT: "Amount too small to produce any output.",
  ERR_SLIPPAGE: "Price moved beyond your slippage tolerance. Re-quote and retry.",
  ERR_INSUFFICIENT_LIQUIDITY: "Not enough liquidity in the market for this trade.",
  ERR_INSUFFICIENT_BALANCE: "You don't hold that much LAST.",
  ERR_ONE_YOCTO: "This call requires exactly 1 yoctoNEAR attached.",
  ERR_ZERO_AMOUNT: "Enter an amount to sell.",
  ERR_USE_SELL: "Don't transfer LAST to the contract — use Sell instead.",
  ERR_POSITIVE_BALANCE: "Sell or transfer your LAST before unregistering.",
  ERR_FORBIDDEN: "This account cannot perform that action.",
  ERR_INSOLVENT: "Contract solvency check failed. Please report this.",
  ERR_OVERFLOW: "Arithmetic guard triggered in the contract. Please report this.",
  ERR_UNDERFLOW: "Arithmetic guard triggered in the contract. Please report this.",
  ERR_DIV_ZERO: "Arithmetic guard triggered in the contract. Please report this.",
  ERR_NO_CREDIT: "You have no NEAR credit to withdraw.",
  ERR_WITHDRAW_IN_FLIGHT: "A withdrawal is already in flight. Wait for it to resolve.",
  ERR_NO_ACTIVE_ROUND: "There is no active round to settle (it may already be settled).",
  ERR_NOT_EXPIRED: "The round has not expired on-chain yet.",
  ERR_UNKNOWN_ROUND: "Unknown round.",
  ERR_NOT_WINNER: "Only the recorded winner can claim this prize.",
  ERR_ALREADY_PAID: "This prize was already paid.",
  ERR_CLAIM_IN_FLIGHT: "A claim for this round is already in flight.",
  ERR_EMPTY_PRIZE: "This round's prize is empty.",
};

export type ErrorKind = "rejected" | "contract" | "rpc" | "unavailable" | "unknown";

export interface UiError {
  kind: ErrorKind;
  code: string | null;
  message: string;
}

const ERR_CODE_RE = /\bERR_[A-Z0-9_]+\b/;

export function extractErrorCode(input: unknown): string | null {
  const text = stringify(input);
  const m = ERR_CODE_RE.exec(text);
  return m ? m[0] : null;
}

const REJECT_RE = /user (rejected|cancel|closed|denied)|rejected by user|cancelled|canceled|user denied|popup closed|window closed/i;

export class FeatureUnavailableError extends Error {
  constructor(public readonly method: string) {
    super(`${method} is not available on the deployed contract yet (pending Gate 2).`);
    this.name = "FeatureUnavailableError";
  }
}

export function classifyError(err: unknown): UiError {
  if (err instanceof FeatureUnavailableError) {
    return { kind: "unavailable", code: null, message: err.message };
  }
  const code = extractErrorCode(err);
  if (code) {
    return { kind: "contract", code, message: CONTRACT_ERROR_MESSAGES[code] ?? `Contract error ${code}.` };
  }
  const text = stringify(err);
  if (REJECT_RE.test(text)) {
    return { kind: "rejected", code: null, message: "Transaction rejected in the wallet." };
  }
  if (err instanceof Error && err.name === "RpcError") {
    if ((err as Error & { kind?: string }).kind === "method_not_found") {
      return {
        kind: "rpc",
        code: null,
        message: "The configured contract does not expose this LAST method (wrong VITE_LAST_CONTRACT_ID, or an older contract version).",
      };
    }
    return { kind: "rpc", code: null, message: `NEAR RPC error: ${err.message}` };
  }
  return { kind: "unknown", code: null, message: err instanceof Error ? err.message : text || "Unknown error" };
}

function stringify(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Error) return `${input.name}: ${input.message}`;
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}
