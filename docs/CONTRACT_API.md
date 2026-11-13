# LAST — Contract API

**Status:** DRAFT v0.4 (branch `feat/crown-economy`, NOT deployed — the deployed `last-armand.testnet` runs v0.3). Interface agreed between Developer A (contract) and Developer B (web) before implementation. **Nothing here is deployed yet.** Changes go through both developers and bump the version below.

Every method below is implemented on `feat/contracts` (Gates 1–2), covered by unit tests and a `near-workspaces` sandbox scenario. Not deployed to testnet yet.

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-11-12 | First draft from `docs/SPEC_V2.md` |
| 0.2 | 2026-11-12 | Gate 1: added `buy_count`/`sell_count` to market state, `get_roles`, `get_integrity`; new error codes `ERR_ZERO_AMOUNT`, `ERR_USE_SELL`, `ERR_POSITIVE_BALANCE`, `ERR_FORBIDDEN`, `ERR_INSOLVENT`, `ERR_OVERFLOW` |
| 0.3 | 2026-11-12 | Gate 2: settle/claim/withdraw implemented; `get_integrity` gains `in_flight` |
| 0.4 | 2026-11-13 | Crown Economy V2 (branch `feat/crown-economy`): fee split 85/10/0/5; `withdraw_platform_fees` (platform only) + private callback; `get_economics` view; event `platform_withdraw`; error `ERR_INSUFFICIENT_PLATFORM_FEES`. No state-layout change |

## 0. Conventions

- **Network:** NEAR Testnet only. Contract account: **`last-armand.testnet`** (deployed 2026-11-12, see `docs/DEPLOYMENT.md`).
- **Amounts** (`U128`) are JSON **decimal strings**: yoctoNEAR (`1 NEAR = 10^24`) or atomic LAST (`1 LAST = 10^18`). Frontend parses with `BigInt`, never `Number`.
- **Timestamps** (`U64`) are JSON decimal strings in **nanoseconds** (`env::block_timestamp()`).
- **Round ids** (`U64`) start at `1`. `round_id` in game state is the current round when ACTIVE/EXPIRED, or the id the next round will take when IDLE.
- **Errors:** the contract panics with a message starting with an error code (`ERR_...`, see §6). A panicking call reverts all state; any attached deposit is refunded by the protocol (gas is not).
- **Security deposit:** methods marked `1 yocto` require exactly `1` yoctoNEAR attached (NEP-141 convention: forces a full-access-key signature).
- Constants fixed in code and not changeable: `BUY_FEE_BPS = 400`, `SELL_FEE_BPS = 200`, fee split `8500/1000/0/500` (jackpot / next seed / treasury / platform), remainder → treasury (so the treasury only receives rounding dust, ≤ 2 yoctoNEAR per fee). v0.3 (deployed) uses `7000/1000/1500/500`. Read the live split with `get_economics()`.

## 1. Initialization

### `new(config: InitConfig)` — payable, one-time

```json
{
  "config": {
    "owner_id": "owner.testnet",
    "treasury_id": "treasury.testnet",
    "platform_id": "ops.testnet",
    "round_duration_ns": "120000000000",
    "min_eligible_buy": "30000000000000000000000",
    "seed_near": "3000000000000000000000000"
  }
}
```

- Attached deposit **must equal** `seed_near`; it becomes `market_near_reserve`. Storage staking and gas buffer must already be in the contract account's own balance (fund the account before calling `new`).
- Mints `10^24` atomic LAST (1,000,000 LAST, 18 decimals) once, to the contract's own FT account = `market_last_inventory`.
- Demo config: 120 s, 0.03 NEAR, 3 NEAR. Production concept: 60 min (`3600000000000`).
- Errors: `ERR_ALREADY_INITIALIZED`, `ERR_BAD_SEED_DEPOSIT`, `ERR_BAD_CONFIG`.

## 2. Trading and game (change methods)

Recommended gas: 30 Tgas for `buy`/`sell`/`settle_round`, 50 Tgas for `withdraw_near_credit`/`claim_reward`.

### `buy(min_tokens_out: U128)` — payable

- Gross amount = attached deposit. Caller must be registered for FT storage (§4). A new user can send **one transaction with two actions**: `storage_deposit` then `buy`.
- Rejected when the round is EXPIRED and not yet settled (`ERR_ROUND_EXPIRED`).
- If `gross >= min_eligible_buy`: caller becomes leader, `deadline_ns = now + round_duration_ns`; if IDLE, a new round starts (next seed pot moves into the active pot first).
- Returns:

```json
{
  "tokens_out": "9746...",
  "fee": "1200000000000000000000",
  "eligible": true,
  "round_id": "1",
  "leader": "alice.testnet",
  "deadline_ns": "1762950000000000000"
}
```

`leader`/`deadline_ns` are the state **after** the call (unchanged on a non-eligible buy).
- Errors: `ERR_ZERO_DEPOSIT`, `ERR_NOT_REGISTERED`, `ERR_ROUND_EXPIRED`, `ERR_ZERO_OUTPUT`, `ERR_SLIPPAGE`, `ERR_INSUFFICIENT_LIQUIDITY`.

### `sell(tokens_in: U128, min_near_out: U128)` — 1 yocto

- Sells LAST from the **caller's own** balance. Never changes leader or deadline.
- `payout` is credited to the caller's **withdrawable NEAR credit**; no NEAR is sent in this call.
- Returns `{ "gross_near_out": "...", "fee": "...", "payout": "...", "credit_available": "..." }`.
- Errors: `ERR_ONE_YOCTO`, `ERR_ZERO_AMOUNT`, `ERR_NOT_REGISTERED`, `ERR_INSUFFICIENT_BALANCE`, `ERR_ROUND_EXPIRED`, `ERR_ZERO_OUTPUT`, `ERR_SLIPPAGE`, `ERR_INSUFFICIENT_LIQUIDITY`.

### `withdraw_near_credit()` — 1 yocto

- Moves the caller's whole available credit to IN_FLIGHT and sends it by transfer promise. Callback `on_withdraw_complete` (private) marks it paid, or restores it to available on failure.
- Returns a promise resolving to `{ "amount": "...", "success": true }`.
- Only one withdrawal in flight per account. Credit from new sells while in flight is added to `available`.
- Errors: `ERR_ONE_YOCTO`, `ERR_NO_CREDIT`, `ERR_WITHDRAW_IN_FLIGHT`.

### `settle_round()` — anyone, no deposit

- Only when ACTIVE and `now >= deadline_ns`. Moves `active_pot` into a prize claim for the leader, archives the round, game becomes IDLE. `next_seed_pot` is untouched.
- Returns the settled round (`RoundView`, §3).
- Errors: `ERR_NO_ACTIVE_ROUND` (includes double settle), `ERR_NOT_EXPIRED`.

### `claim_reward(round_id: U64)` — winner only, no deposit

- `AVAILABLE → IN_FLIGHT` before the transfer promise; callback `on_prize_payment_complete` (private) sets `PAID`, or back to `AVAILABLE` on failure.
- Returns a promise resolving to `{ "round_id": "1", "amount": "...", "success": true }`.
- Errors: `ERR_UNKNOWN_ROUND`, `ERR_NOT_WINNER`, `ERR_ALREADY_PAID`, `ERR_CLAIM_IN_FLIGHT`, `ERR_EMPTY_PRIZE`.

### `withdraw_platform_fees(amount: Option<U128>)` — `platform_id` only, 1 yocto (v0.4)

- Withdraws `amount` (default: all) from the platform fee share (`ops_reserve`). Touches no other bucket: market reserve, pots, credits and prizes are out of reach.
- The amount leaves `ops_reserve` before the transfer promise (no double withdrawal; balance and obligations drop together, solvency stays exact). Private callback `on_platform_withdraw_complete` restores it on a failed transfer and never panics.
- Returns a promise resolving to `{ "amount": "...", "success": true }`.
- Errors: `ERR_ONE_YOCTO`, `ERR_FORBIDDEN` (caller is not `platform_id`), `ERR_ZERO_AMOUNT`, `ERR_INSUFFICIENT_PLATFORM_FEES`.

## 3. Views (free, no signature)

### `get_game_state()`

```json
{
  "status": "ACTIVE",
  "round_id": "3",
  "leader": "bob.testnet",
  "started_at_ns": "...",
  "deadline_ns": "...",
  "active_pot": "...",
  "next_seed_pot": "...",
  "qualifying_buy_count": 7,
  "last_settled_round_id": "2",
  "now_ns": "..."
}
```

- `status`: `"IDLE" | "ACTIVE" | "EXPIRED"` (EXPIRED = derived, `now_ns >= deadline_ns`, waiting for `settle_round`).
- `leader`, `started_at_ns`, `deadline_ns` are `null` when IDLE. `last_settled_round_id` is `null` before the first settlement.
- `now_ns` is the block timestamp the view ran at: use it to sync the UI countdown with chain time.

### `get_round(round_id: U64)` → `RoundView | null`

```json
{
  "round_id": "2",
  "winner": "bob.testnet",
  "prize": "...",
  "started_at_ns": "...",
  "ended_at_ns": "...",
  "qualifying_buy_count": 12,
  "claim_status": "AVAILABLE"
}
```

`claim_status`: `"AVAILABLE" | "IN_FLIGHT" | "PAID"`. Returns `null` for the current unsettled round or an unknown id.

### `get_market_state()`

```json
{
  "near_reserve": "...",
  "last_inventory": "...",
  "total_buy_volume": "...",
  "total_sell_volume": "...",
  "buy_count": "42",
  "sell_count": "9",
  "treasury_reserve": "...",
  "ops_reserve": "...",
  "buy_fee_bps": 400,
  "sell_fee_bps": 200,
  "min_eligible_buy": "...",
  "round_duration_ns": "..."
}
```

Spot price (NEAR per LAST) for display = `near_reserve / last_inventory` scaled by decimals — marginal, indicative only. Volumes are gross NEAR in / gross NEAR out.

### `quote_buy(gross_near: U128)`

`{ "tokens_out": "...", "fee": "...", "net_near": "...", "eligible": true }` — same integer math as `buy` against current reserves. Does not panic on `0`; returns zeros.

### `quote_sell(tokens_in: U128)`

`{ "gross_near_out": "...", "fee": "...", "payout": "..." }`.

UI computes `min_tokens_out` / `min_near_out` from the quote and the user's slippage tolerance with `bigint`.

### `get_account_state(account_id: AccountId)`

```json
{
  "registered": true,
  "last_balance": "...",
  "credit_available": "...",
  "credit_in_flight": "...",
  "claimable_rounds": ["2"]
}
```

`claimable_rounds` lists settled rounds won by the account whose prize is not yet `PAID`.

### `get_economics()` (v0.4)

```json
{
  "model": "crown-economy-v2",
  "buy_fee_bps": 400,
  "sell_fee_bps": 200,
  "jackpot_bps": 8500,
  "next_seed_bps": 1000,
  "treasury_bps": 0,
  "platform_bps": 500,
  "remainder_to": "treasury",
  "platform_withdrawable": true
}
```

The fee model, so the frontend never hard-codes the split. Absent on v0.3 (the frontend detects it from the WASM exports).

### `get_roles()`

`{ "owner_id": "...", "treasury_id": "...", "platform_id": "..." }` — disclosed roles. None of them can change game outcome, fees, supply or reserves.

### `get_integrity()`

Real contract balance vs every named obligation (SPEC §1.6), for the demo reconciliation:

```json
{
  "account_balance": "...",
  "storage_cost": "...",
  "total_obligations": "...",
  "market_near_reserve": "...",
  "active_pot": "...",
  "next_seed_pot": "...",
  "treasury_reserve": "...",
  "ops_reserve": "...",
  "credits_outstanding": "...",
  "prizes_outstanding": "...",
  "in_flight": "...",
  "surplus": "..."
}
```

`in_flight` is NEAR already sent by a transfer promise whose callback has not run yet (it left the balance but is still owed, or comes back on failure). `surplus = account_balance + in_flight - storage_cost - total_obligations`. Every change method checks `account_balance + in_flight >= storage_cost + total_obligations` and panics with `ERR_INSOLVENT` otherwise.

## 4. NEP-141 / NEP-145 / NEP-148 (standard)

`ft_total_supply`, `ft_balance_of`, `ft_transfer` (1 yocto), `ft_transfer_call` (1 yocto), `ft_resolve_transfer` (private), `ft_metadata`, `storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_of`, `storage_balance_bounds`.

- Metadata: `name = "LAST — Last Buyer Wins"`, `symbol = "LAST"`, `decimals = 18`.
- Read the registration price from `storage_balance_bounds().min`; do not hard-code it.
- FT transfers never touch the game (no fee, no leader change).

## 5. Events (NEP-297)

Logged as `EVENT_JSON:{"standard":"last","version":"1.0.0","event":"<name>","data":[{...}]}`. Token movements also emit the standard `nep141` `ft_transfer` / `ft_mint` events.

| Event | Data fields |
|---|---|
| `buy` | `account_id, gross, fee, tokens_out, eligible, round_id, deadline_ns` (`round_id`/`deadline_ns` null if not eligible and IDLE) |
| `sell` | `account_id, tokens_in, gross_near_out, fee, payout` |
| `round_started` | `round_id, seed, started_at_ns` |
| `round_settled` | `round_id, winner, prize, ended_at_ns, settled_by` |
| `prize_claim` | `round_id, winner, amount, status` (`IN_FLIGHT` / `PAID` / `FAILED`) |
| `credit_withdraw` | `account_id, amount, status` (`IN_FLIGHT` / `PAID` / `FAILED`) |
| `platform_withdraw` (v0.4) | `account_id, amount, status` (`IN_FLIGHT` / `PAID` / `FAILED`) |

Events feed the activity list only. Winner, pots and balances always come from the views.

## 6. Error codes

| Code | Meaning | UI message hint |
|---|---|---|
| `ERR_ALREADY_INITIALIZED` | `new` called twice | — |
| `ERR_BAD_SEED_DEPOSIT` / `ERR_BAD_CONFIG` | invalid init | — |
| `ERR_ZERO_DEPOSIT` | `buy` with nothing attached | Enter an amount |
| `ERR_NOT_REGISTERED` | FT storage missing | Register storage first |
| `ERR_ROUND_EXPIRED` | trade after deadline, before settlement | Round over — settle first |
| `ERR_ZERO_OUTPUT` | amount too small to produce output | Amount too small |
| `ERR_SLIPPAGE` | output below the minimum | Price moved, retry |
| `ERR_INSUFFICIENT_LIQUIDITY` | reserve cannot cover output | Not enough liquidity |
| `ERR_INSUFFICIENT_BALANCE` | selling more LAST than held | Not enough LAST |
| `ERR_ONE_YOCTO` | missing 1 yocto deposit | — |
| `ERR_ZERO_AMOUNT` | `sell` of 0 LAST | Enter an amount |
| `ERR_USE_SELL` | `ft_transfer(_call)` to the contract itself | Use Sell instead |
| `ERR_POSITIVE_BALANCE` | `storage_unregister` while holding LAST | Sell or transfer LAST first |
| `ERR_FORBIDDEN` | the contract account calling `buy`/`sell`/`storage_unregister` on itself | — |
| `ERR_INSOLVENT` | balance would not cover obligations + storage | Contract error, report it |
| `ERR_OVERFLOW` / `ERR_UNDERFLOW` / `ERR_DIV_ZERO` | arithmetic guard | Contract error, report it |
| `ERR_NO_CREDIT` / `ERR_WITHDRAW_IN_FLIGHT` | nothing to withdraw / already pending | — |
| `ERR_NO_ACTIVE_ROUND` / `ERR_NOT_EXPIRED` | settle not possible | — |
| `ERR_UNKNOWN_ROUND` / `ERR_NOT_WINNER` / `ERR_ALREADY_PAID` / `ERR_CLAIM_IN_FLIGHT` / `ERR_EMPTY_PRIZE` | claim not possible | — |
| `ERR_INSUFFICIENT_PLATFORM_FEES` (v0.4) | withdrawing more than the platform share | — |

## 7. Not in the API (by design)

No method sets the leader, edits the deadline, changes fees, mints LAST, or moves market reserve, prizes or credits. v0.4: `platform_id` can withdraw only the platform share (`withdraw_platform_fees`); the treasury has no withdrawal (it only holds rounding dust).
