# LAST — web frontend (`apps/web`)

React 19 + TypeScript + Vite 8 + Tailwind 4. **NEAR Testnet only.** Interface: `docs/CONTRACT_API.md` **v0.2**.

## Run

```bash
cd apps/web
pnpm install
cp .env.example .env.local     # set VITE_LAST_CONTRACT_ID once the contract is deployed (Gate 3)

pnpm dev        # live mode: real RPC views + wallet. No contract id → "CONTRACT NOT DEPLOYED"
pnpm dev:mock   # SIMULATED mode, dev server only (add ?gate2=1 to preview Gate 2 UI, ?bots=0 to stop simulated rivals)
# any mode: ?demo=1 adds presenter helpers (a "claim again" button to show the contract rejecting a double claim)
pnpm test       # unit + mocked UI tests
pnpm typecheck
pnpm build      # production build (the SIMULATED adapter is not even included)
```

Read-only live integration test, after a real deploy:
`LAST_LIVE_CONTRACT_ID=<id>.testnet pnpm test src/test/live.integration.test.ts` (never signs).

## Data sources — what the user sees is always labelled

| Mode | When | Shows |
|---|---|---|
| `live` | `VITE_LAST_CONTRACT_ID` = a `*.testnet` account with code | Real contract views; badge **LIVE** |
| not deployed | no id, unknown account, or no code | **CONTRACT NOT DEPLOYED**, dashes, every action disabled |
| config error | a `.near` (mainnet) or malformed id | Refused, nothing is read |
| `simulated` | `pnpm dev:mock` only | **SIMULATED** banner + badges; in-memory replay of the contract rules |

On an RPC failure the last real values stay on screen, flagged **stale**, with the error. There is never a fallback to simulated data.

## Architecture

```
src/
  config.ts            env → data source; testnet-only guard; explorer links
  lib/
    amounts.ts         bigint parse/format (24 / 18 decimals), U128/U64 decoding, spot price
    slippage.ts        min-out from quote + bps
    countdown.ts       chain-synced timer (now_ns / deadline_ns), clock sample merging, display phases
    types.ts           wire types (CONTRACT_API v0.2) + strict parsers → bigint
    rpc.ts             minimal JSON-RPC client (call_function / view_account / view_code), endpoint fallback
    wasm.ts            reads WASM exports → which Gate 2 methods the deployed code really has
    reader.ts          LastReader interface + LiveLastReader (all views)
    transactions.ts    exact actions for buy / sell / storage / withdraw / settle / claim + outcome interpretation
    txMachine.ts       idle → signing → pending → confirmed | unresolved | failed | rejected
    txVerify.ts        on-chain post-conditions: "confirmed" only when fresh views show the effect
    pendingTx.ts       notice for a transaction interrupted by a page reload
    economics.ts       economic parameters + where each comes from (contract vs documented V1)
    pricing.ts         price impact from real quotes/reserves, NEAR gas upper bound
    validation.ts      pre-signature checks (storage, min eligible, balances, expired)
    errors.ts          ERR_* → user messages; wallet rejection / RPC / unavailable classification
    game.ts            leader-change detection, settle/claim eligibility, round lists
    wallet.ts          LastWriter interface + HOT Connect (@hot-labs/near-connect) implementation
    marketMath.ts      bigint port of market.rs (SIMULATED adapter + parity tests only)
    mock.ts            SIMULATED adapter (dev only)
  hooks/               useLast (provider: polling, clock, wallet, tx lifecycle), useCountdown, useQuote
  components/          Hero, TradePanel, RewardsPanel, CreditPanel, MarketPanel, ActivityPanel, …
```

### Integration rules implemented

- **Amounts**: `bigint` end to end; JSON U128/U64 strings parsed strictly (a malformed field is an error, never a 0).
- **Timer**: offset between `get_game_state().now_ns` and the local clock, ticked locally. Local 00:00 while the contract still says ACTIVE shows **CLOSING**, never "ended". Settle appears only when the contract says **EXPIRED**. Duration comes from `get_market_state().round_duration_ns` (120 s demo / 60 min concept).
- **Buy**: `quote_buy` before signing; `min_tokens_out` from slippage; unregistered users get **one transaction** `storage_deposit(registration_only) + buy`, deposit = `storage_balance_bounds().min` (read, never hard-coded). Below `min_eligible_buy` → allowed, with a "no crown" warning.
- **Sell**: `quote_sell`, `min_near_out` from slippage, exactly **1 yocto**. Shown as a withdrawable credit, never as "paid".
- **Gate 2** (`settle_round`, `claim_reward`, `withdraw_near_credit`, `get_round`): the UI reads the deployed WASM's export section via `view_code`. Buttons are disabled with "pending Gate 2" until those exports exist, then they turn on automatically with the agreed signatures. `IN_FLIGHT` is never displayed as a success; a callback result `{ success: false }` is a failed payout.
- **Confirmation**: a transaction is "confirmed" only after a success outcome **and** fresh `final` views showing its effect (buy/sell counters moved, round settled, claim `PAID`, credit withdrawn). Views lag the wallet by ~1–2 blocks, so the check retries 6× every 1.5 s, then ends as **unresolved** ("executed, not yet visible" / "IN_FLIGHT"), never as a success.
- **Timer robustness**: clock samples are merged (a slower poll never makes the countdown jump back up), latency is half-compensated, a local clock change triggers a resync, and the views are re-read on tab focus / visibility / network recovery (sleep, resume).
- **Network guards**: the RPC endpoint must report `chain_id = testnet`; a connected wallet account that is not a testnet account (e.g. `*.near`) cannot transact.
- **Fees**: LAST market fees (4% / 2%, read from `get_market_state`) are shown apart from the NEAR network gas (upper bound = attached gas × `gas_price`). The 70/10/15/5 split is not readable on-chain in v0.2 and is labelled as documented V1. "Crown Economy V2" is not implemented and never shown as active.
- **RPC load**: storage bounds read once, integrity/gas every 5th poll, PAID rounds cached; polling pauses when the tab is hidden.

### Wallet

HOT Connect (`@hot-labs/near-connect` 0.12.0), always `network: "testnet"`, listing only wallets whose manifest declares testnet support. Chosen over Wallet Selector (no release since Dec 2025; its repo now points to HOT Connect). The app never sees keys.

## Tests

`pnpm test`: all **unit / mocked** (no network, no wallet). `src/test/flows.test.tsx` drives the real React tree through full user flows on the SIMULATED adapter (dust buy, register+buy, expiry → settle → claim → double claim rejected, wallet rejection, pending wallet, RPC failure, mainnet wallet refused, empty wallet). Plus: amounts, conversions, AMM parity with Builder A's Rust vectors, slippage, countdown + phases, leader changes, RPC errors and endpoint fallback (stubbed `fetch`), WASM export parsing, tx builders, outcome parsing, tx lifecycle, storage / buy limits, Gate-2-unavailable behaviour, UI states (not deployed / simulated / expired).
`src/test/live.integration.test.ts`: **real** testnet reads, skipped unless `LAST_LIVE_CONTRACT_ID` is set.
