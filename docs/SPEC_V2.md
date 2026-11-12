# LAST V2 — Implementation specification and engineering contract

**Version:** V2 — 12 November 2026  
**Status:** design specification, not an assertion that features are deployed  
**Duration:** 48-hour NEAR Hackathon MVP, two developers  
**Network:** NEAR Testnet ONLY, 120-second timer specifically for the demonstration

This document is the technical companion to [../README.md](../README.md). Read both before implementation. If an engineering decision here conflicts with the README's high-level public promise, fix and document the discrepancy explicitly.

## 0. Product decision and researched alternatives

The LAST product is a **last-eligible-purchase timed jackpot game**. A player buys a regular NEP-141 LAST token **through a market owned by LAST**, not through an external DEX. The purchase's NEAR trading fee finances a prize pool and other explicitly segregated balances. After 60 minutes without a qualifying purchase (120 seconds on demo testnet), the last such buyer is eligible to claim the accumulated NEAR prize.

LAST is deliberately distinct from token fees that apply to all external transfers. NEP-141 does not classify general external swaps as purchases, so an external Rhea swap cannot change our `last_buyer` without a trusted onchain integration. No part of the MVP depends on that assumption.

**Considered:**

| Design | Benefit | Risk / decision |
|---|---|---|
| FT contract + Rhea pool + browser indexer | Ready-made swaps | Indexer cannot securely set an onchain winner → reject |
| Separate FT, game, AMM | Modular deployment | Cross-contract async calls on every purchase → avoid for 48 h |
| Bonding curve mint/burn | Simple custom trading | Variable token supply and extra tokenomics to explain → defer |
| **One Rust contract, embedded fungible token + x*y=k market + round state** | Atomic trade+game decision; prize backed in native NEAR | Must safely implement and test pooled reserves → **select** |

Economics research:
- Pump.fun bonding-curve total fee documented as 1.25% (plus interface fee in applicable contexts); not an equivalent game.
- Meme.Cooking has a 0.5% deposit fee, 2% launch fee and 2% early withdrawal penalty, again on different bases.
- ClawFomo splits its pot 50% winner / 20% burn / 25% key holders / 5% next-round seed; it uses a different token/key economy and should not be copied wholesale.
- A current Fomo3D variant uses different jackpot/holder distributions and a 5% **claim fee**, not a directly comparable buy/sell trading tax.
- Historical FOMO3D demonstrates last-buyer game dynamics and ordering/MEV risk; no credible claim of original last-buyer mechanics.

**Chosen:** buys 400 bps (4%), sells 200 bps (2%), fee distribution current jackpot 7000 bps, next-round seed 1000 bps, treasury 1500 bps, ops 500 bps. Fixed on initialization and not changeable during the hackathon MVP. Both trade fees and allocation are applied using atomic yoctoNEAR integers. Remainders from integer division must be allocated deterministically to one named bucket (e.g. treasury) so that all fee units are conserved. Never silently discard dust.

## 1. Economics and token allocation

### 1.1 Token

- Name: LAST — Last Buyer Wins
- Ticker: `LAST`
- Total supply: 1,000,000 tokens with 18 decimals = `10^24` atomic token units.
- Mint: exactly once during `new`, directly to the contract's registered inventory account.
- Team share, influencer share, community airdrop and presale: zero in MVP.
- Transfers: NEP-141 standard, no tax; external markets can exist but are explicitly non-qualifying.
- No burn, rebase, buybacks, LP migration, token emission or staking.
- Ensure token metadata and FT storage-management requirements are implemented using pinned, compatible versions of the NEAR standard library.

### 1.2 Seed / quote / eligibility

- Demo market seed: **3 NEAR** (`3 × 10^24` yoctoNEAR), *separate from storage staking and gas buffer*.
- Initial LAST inventory: `10^24` atomic units.
- Initial spot ratio: about `3 / 1,000,000 = 0.000003 NEAR / LAST` before fees. This is a **marginal price**; a 0.03 NEAR buy receives fewer LAST than `0.03 / marginal price` because of the trading fee and price impact.
- Eligible buy floor: **0.03 NEAR gross** (`3 × 10^22` yoctoNEAR).
- A pending valid purchase never qualifies before receipt success; no optimistic UI winner update.
- Validate real funds through `env::attached_deposit()` on buy; do not accept price/paid amount from user-supplied text.
- A minimum gross buy alone does not prevent bots, large-wallet splitting or MEV. Do not market it as Sybil resistant.

### 1.3 Bps and cash flow

`BPS = 10000`, `BUY_FEE_BPS = 400`, `SELL_FEE_BPS = 200`.

`JACKPOT_SHARE = 7000`, `NEXT_SEED_SHARE = 1000`, `TREASURY_SHARE = 1500`, `OPS_SHARE = 500`.

For fee `f`:
- `jackpot_part = floor(f * 7000 / 10000)`
- `next_part = floor(f * 1000 / 10000)`
- `ops_part = floor(f * 500 / 10000)`
- `treasury_part = f - jackpot_part - next_part - ops_part`

This assigns rounding remainder to treasury and conserves funds exactly. Budget sums are fixed and checked at initialization if loaded from deployment config rather than code constants.

**When ACTIVE:** jackpot_part → `active_pot`, next_part → `next_seed_pot`.  
**When IDLE:** jackpot_part + next_part → `next_seed_pot`; no empty active round receives money.  
**At settlement:** move `active_pot` to `claimable_prizes[round_id]`, but **do not touch `next_seed_pot`**.  
**On start:** move existing next_seed_pot into active_pot, then apply the first trade's fee split as an ACTIVE trade.

To avoid ambiguity at state transition, compute eligibility and whether a new round begins **before** allocating that trade's fee, and use transactional state updates. A first eligible purchase creates the round and credits the relevant 70% fee to it. See edge-case tests.

Treasury and platform funds remain in separately reserved native-NEAR ledgers. Future withdrawals should be role-gated with precise maximum availability and asynchronous callbacks; defer those withdrawals if the design is not fully tested. They are not market reserve or guaranteed actual LP.

### 1.4 Buy formula

Let `X` = live market native NEAR reserve (yoctoNEAR), `Y` = LAST token inventory (atomic), `gross` = actual attached yoctoNEAR.

1. `fee = floor(gross * BUY_FEE_BPS / 10000)`; `net = gross - fee`.
2. `last_out = floor(Y * net / (X + net))` using **wide integer intermediates (U256 or equivalent)**.
3. Require `gross > 0`, `last_out > 0`, `last_out >= min_tokens_out`, `Y >= last_out` and buyer's FT registration/storage satisfied.
4. `X_new = X + net`; `Y_new = Y - last_out`.
5. Credit exactly the `fee` to segregated buckets.
6. If eligible by actual `gross`, before deadline, update last buyer and deadline inside the **same Rust state transition**, else do not touch them.

### 1.5 Sell formula and credit model

Let `tokens_in` = atomic LAST sold by the caller (not approved or authorized by an arbitrary third party).

1. `gross_near_out = floor(X * tokens_in / (Y + tokens_in))` using wide arithmetic.
2. `fee = floor(gross_near_out * SELL_FEE_BPS / 10000)`.
3. `payout = gross_near_out - fee`. Require `payout > 0`, `payout >= min_near_out`, and sufficient X reserve.
4. `X_new = X - gross_near_out`, `Y_new = Y + tokens_in`.
5. Deduct LAST from caller, credit LAST into market inventory, allocate fee buckets.
6. **Credit `payout` to `withdrawable_near[caller]`**, separately reserved. Do not send NEAR from `sell()` and risk an async callback changing AMM state.
7. The user calls `withdraw_near_credit()` to receive their sale proceeds, using a private promise callback and state `AVAILABLE → IN_FLIGHT → SETTLED` or `IN_FLIGHT → AVAILABLE` on confirmed failure.

The UI must clearly tell users that a sell creates a withdrawable NEAR credit and that withdrawal is a separate signed transaction. Never label the sale “paid out” until a withdrawal receipt confirms payment.

### 1.6 Integrity equation

Track the following native-NEAR obligations independently:

- `market_near_reserve`
- `active_round_pot`
- `next_seed_pot`
- `treasury_reserve`
- `ops_reserve`
- sum of `claimable_prizes` not yet paid (including in-flight prize reservations)
- sum of `withdrawable_near` sale credits not yet paid (including in-flight withdraw reservations)
- any owed FT storage refunds / other liabilities
- contract storage staking requirement and safety buffer (not spendable)

Invariant: **available contract balance must cover the total named obligations** with no cross-subsidization. When a promise is in flight, don't mark a liability as released and re-available until success has been reconciled. Internal accounting must reflect actual account balance when the payout succeeds, including gas taken from contract for outgoing promises.

Note: even a read-only view of account balance is not a substitute for per-bucket accounting. An admin withdrawal must never reach reserved market liquidity or player claims. Integer conservation properties must hold after every successful `buy`, `sell`, `settle`, `claim`, `withdraw` and callback.

## 2. NEAR contract and state model

### 2.1 Single deployment

A single crate `contracts/last` exposing NEP-141 core + metadata + storage and the game. The central contract account stores the native NEAR reserve. Its own registered FT account initially receives the total minted LAST supply.

**Versioning:** pin `near-sdk`, `near-contract-standards`, `near-workspaces` and any U256 crate to tested compatible versions in lockfiles. A newer crate release may change interfaces or minimum supported Rust version; do not blindly use `latest` without building.

**Example internal state layout** (conceptual; implement with appropriate NEAR collections and storage accounting):

```rust
struct LastContract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,          // only for explicitly limited admin functions
    treasury_id: AccountId,
    platform_id: AccountId,
    market_near_reserve: u128,
    market_last_inventory: u128,
    active_pot: u128,
    next_seed_pot: u128,
    treasury_reserve: u128,
    ops_reserve: u128,
    round_id: u64,
    current_round: Option<Round>,
    historical_rounds: LookupMap<u64, SettledRound>,
    prize_claims: LookupMap<u64, PrizeClaim>,
    sale_credits: LookupMap<AccountId, CreditState>,
    market_totals: MarketTotals,
    config: ImmutableConfig,
}
```

Do not store unbounded buy/sell history vectors in contract storage without an explicit bounded policy. Emit NEAR-standard-friendly JSON events and let the frontend parse recent receipts or use a clearly labeled optional indexer. **The canonical source for winner, pot and balances must be contract state.**

### 2.2 Game machine

- `IDLE`: no active round. `next_seed_pot` may be positive.
- `ACTIVE`: `leader` exists, `started_at_ns`, `deadline_ns`, `round_id`, `active_pot` and `qualifying_buy_count` exist.
- `EXPIRED`: read-only derived state when `env::block_timestamp() >= deadline_ns`. Do not mutate or extend the just-expired round.
- `SETTLED`: historical record exists, single claim record for winner is created, active cleared, and next round awaits a new eligible buy.

`env::block_timestamp()` is in nanoseconds; convert the chosen 60 minutes / 120 seconds into nanoseconds with checked multiplication and test boundary equality.

**Public methods:**

- `new(config)` payable: one-time init, fixed fees and duration, seed NEAR, valid storage buffer; authenticate initial creator only as relevant to init.
- `buy(min_tokens_out)` payable.
- `sell(tokens_in, min_near_out)`; apply only token amount from the predecessor's own balance.
- `withdraw_near_credit()`; withdraw only the caller's settled sale credits.
- `settle_round()`; permissionless once expired.
- `claim_reward(round_id)`; only recorded winner.
- Internal `on_withdraw_complete` and `on_prize_payment_complete` marked private with explicit promise results.
- `get_game_state`, `get_round`, `get_market_state`, `quote_buy`, `quote_sell`, `get_account_state`.
- Standard FT methods `ft_total_supply`, `ft_balance_of`, `ft_transfer`, `ft_transfer_call`, `ft_metadata`, `storage_*` as required.

### 2.3 Specific edge cases

1. **Two buys in same block:** protocol receipt execution order determines the last leader. Block timestamps may be equal; the last successfully executed eligible buy *before expiry* wins.
2. **Purchase exactly at deadline:** `now >= deadline` means expired; forbid market trades until settlement. No ambiguous equality.
3. **First eligible buy after old round expired:** must first settle the expired round. Cannot implicitly overwrite leader, even if a new round is logically desired.
4. **Subminimum purchase in ACTIVE:** execute trade, allocate current/next fees, but leave leader and deadline unchanged.
5. **Subminimum purchase in IDLE:** execute trade and allocate the 80% prize-related share to pending next pot, no round started.
6. **Sale when game ACTIVE:** allocate fees; do not update leader or deadline.
7. **Trade after deadline but before settlement:** reject market trade without reallocating jackpot.
8. **Leader sells all their LAST:** remains eligible to win; rule is purchase-based, not token-holding-based. UI explains this.
9. **No purchases:** pot remains seed, no free settlement or retroactive winner.
10. **Double settlement:** reject idempotently or return existing state without creating any second claim; never reserve twice.
11. **Concurrent claims:** mark claim state in flight *before* Promise; reject another request until outcome.
12. **Failed async payment:** preserve claimable funds exactly once, restore only after result reports a genuine failure.
13. **Admin abuse:** no method to set the leader, rewrite deadline, move market reserve or mint new LAST.
14. **Storage refunds:** paid by the correct user; do not mix it with prizes or market reserve.
15. **Overflow/dust:** every fee and AMM calculation uses checked integers and deterministic remainder rules.
16. **Unbounded storage / event data:** throttle onchain state growth through capped history and standard storage deposits.
17. **Upgradeability:** no unrestricted arbitrary code upgrade in deployed MVP; if retained for development, disclose a privileged owner and do not describe contract as immutable. Prefer an immutable deployed demo when feasible.
18. **Fractional native NEAR:** correct yoctoNEAR units in both contract and UI. No JS `Number` for monetary calculations.

### 2.4 Views vs event/log data

Canonical: latest winner, leaderboard round totals, jackpots, fees, token balances, price quotes → contract views.  
Derived client-side: countdown in seconds from `deadline_ns` and synchronised chain time; recent activity parsed from verified contract events; volume charts if data available.  
Prohibited: UI local storage that decides who won; pretend contract prices; hardcoded financial widgets shown as Testnet state.

## 3. Frontend specification

React + TypeScript + Vite, minimal dependencies. For wallet connect, compare HOT Connect (currently recommended in Wallet Selector repo) and Wallet Selector's support for testnet, then implement only one verified path.

**Core screen:**

- The crown: current `last_buyer` account, short-form address and explorer link.
- Large countdown: `ACTIVE` remaining time, `EXPIRED` awaiting settlement, or `IDLE` awaiting eligible trade.
- Current jackpot (NEAR), next seed (NEAR), last winner, total round count.
- Trading form: connect wallet, Buy / Sell toggle, gross deposit / token input, verified quoted output, 4%/2% fee, slippage tolerance and expected tokens/NEAR credit.
- My wallet: LAST balance, withdrawable NEAR sale credits, prizes eligible for claim.
- Live activity: receipt-backed buys/sells and settlement; mock data only in isolated Storybook/local playground with a visible SIMULATED label.
- Rejection UX: dust purchase (tokens bought, crown unchanged), timer expired, wallet rejected, storage deposit missing, insufficient liquidity, insufficient balance, slippage exceeded.
- Accessibility/responsiveness, timer screen reader updates limited, reduced-motion support.

**Important:** A client showing 00:00 is not authoritative settlement. The public `settle_round` transaction is required and may fail if chain state has changed. Display `Claim` only after confirmed settlement.

## 4. Two-developer workflow

### A — Backend/contracts

- `contracts/last` core Rust, NEP-141, market, game, payout model.
- Formula tests plus state transitions, callbacks, accounting.
- Publish `docs/CONTRACT_API.md` early with JSON arguments, return values, atomic units and payable deposits.
- Produce compiled WASM and reproducible sandbox tests.

### B — Frontend and integration

- `apps/web`, TypeScript unit conversions and wallet integration.
- Read-only views and quote/trade UI.
- Handle two-step sale withdrawal and payout statuses.
- Write docs for end-to-end testnet with hashes and links.

Branches: `feat/contracts`, `feat/web`, shared `main`. Merge only at agreed checkpoints; do not have both agents edit the same generated lockfiles without coordination.

### 48-hour milestones

- H0–4: constraints, API, minimal repo, unit conversion and pin tooling.
- H4–14: token and market implemented and tested, visual shell.
- H14–24: round + claims, wallet + quotes, sandbox end-to-end.
- H24–34: correct edge cases, contract integration, wallet flows.
- H34–42: authorization before deploy; true NEAR Testnet buys/sells/settlement/claim.
- H42–48: regression, demo video, README proof, public repo and submission.

**Fallback if not enough time:** preserve native NEAR buy/game/jackpot/settle/claim. If reliable sales are not done, disable sell clearly and document it; stop claiming a two-sided trading market. Never replace a failed sale/payout with a simulated number.

## 5. Testing strategy

### Unit tests (Rust)
- Token one-time supply, no mint second time, storage registration.
- Exact 4%/2% fees, 70/10/15/5 allocations, rounding remainder conservation.
- Buy and sell spot/impact math, no overdraw, wide overflow boundaries.
- Under-minimum purchase, eligible buy, expired boundary, two successive eligible buys.
- Sale after buy, held tokens transfer, self-transfer does not reset timer.
- Jackpot seed flows correctly from one round to the next.
- Fake account, non-winner claim, second claim, double settle.
- Failed callback restore credit exactly once; callback only from self.
- Invariants after random sequences of buys/sells/transfers/settle/claims; compare aggregate obligations.
- Storage inputs and outputs do not subsidize the market.

### Sandbox integration (`near-workspaces`)
- Create two test wallet accounts and deploy WASM.
- Initialize contract with 3 NEAR reserve PLUS separate storage/gas budget.
- Register both wallets under NEP-145.
- Buy A and B, verify B becomes leader and timestamp resets.
- Dust-buy A, show price changes but leader stays B.
- Sell tokens, verify sale credit and manual withdrawal; leader unchanged.
- Fast-forward sandbox time (only in sandbox) past deadline and settle via third account.
- B claims, then attempts a second claim and is rejected.
- Verify receipts and balances, and counter failed async payouts where test harness supports them.

### NEAR Testnet end-to-end
- Two distinct user wallets, signed transactions, 120-second demo timer.
- No funds on mainnet, no plaintext private keys in repository or web app.
- Transaction URLs recorded for buys, dust trade, sell, withdrawal, settle and win claim.
- Compare contract views before/after, not only logs. Distinguish successful receipt execution from submitted transaction.

### Security threats

| Threat | Mitigation or honest limitation |
|---|---|
| Sniping bots and multiple wallets | Cannot guarantee prevention; disclose and show timeline based on confirmed receipts |
| MEV/transaction ordering | No guaranteed ordering fairness; no promise to defeat priority execution |
| Tiny buys resetting timer | Strict gross minimum (0.03 NEAR demo); still not Sybil-proof |
| Double payouts | Per-round and per-account claim state; private async callbacks |
| Treasury draining market | Separate reserve liabilities and role-constrained withdrawals |
| Pool manipulation | AMM price impact and slippage warnings; non-oracle spot |
| Token supply inflation | Only one mint, admin mint absent |
| External DEX bypass | Only own `buy()` triggers game; external markets non-qualifying |
| Unbounded round extension | Open game mechanic; no guarantee a heavily contested round will ever end |
| Huge data growth | Small onchain records, event-based activity history |
| Failure during receipt | Reconcile real state, never assume automatic refund is whole transaction |

## 6. Gates and reporting

**Gate 0 — specification:** README and economics aligned, exact API documented, source tree created.  
**Gate 1 — contract local:** unit tests, build, FT registration, buy/sell, conservation invariants.  
**Gate 2 — settlement sandbox:** full sequence through true sandbox calls, failure recovery.  
**Gate 3 — public testnet:** owner-approved deploy/signs, receipts and real contract balance checks.  
**Gate 4 — hackathon submission:** README runbook, license, actual demo URL/video/X post, disclosures, 2-dev credits.

Each checkpoint report must include exact `git status`, commit, build/test command and result, list of blocked features, and demonstration link only if it genuinely exists.

## 7. Security, administration and legal

- Deploy and sign only after explicit human permission. Never automate mainnet payments.
- Configure owner/treasury/platform addresses during one-time init. No owner function may change game outcome, participant rights, timer, fees or supply.
- Treasury funds and platform fees remain reserved even if fee withdrawal functionality is deferred. If withdrawals are implemented, perform separate restricted requests, with private callbacks and balance checks.
- Never print/copy local wallet secrets to AI chat or GitHub; use supported signing workflows.
- There is no reliable anti-bot guarantee; marketing must say so.
- Testnet-only competition. LAST can meet legal definitions of gambling in France. JONUM is a regulated, conditional regime, **not a blanket authorization** for a native NEAR jackpot. Seek jurisdiction-specific legal advice before any public real-money launch.
- Public repository, proper attribution of AI-generated and pre-existing libraries, LICENSE, and a demo X post are required per hackathon rules; verify live HACKATHON.md before submission.

## 8. Future versions, NOT MVP

- Better market liquidity strategy / externally integrated AMM with trusted onchain trade recording.
- Economic stress tests using agent-based simulated traders, bots, and churn.
- Mechanism variants involving fair ordering or commit-reveal with careful UX design (changes definition of winner).
- Timelocked changes and independent security review before mainnet consideration.
- Optional spectators/leaderboards/analytics (non-financial onchain indexer).
- Legal review and region restrictions for real-money deployment.

**Do not add token burns, staking yields, dividends, refer-a-friend, platform buybacks, AI agents or NFTs to V2.** They do not help prove the central mechanic in 48 h.

## 9. References

The sources below informed feasibility and comparison but do not justify claims of optimal fee rates:

- https://nearhackathon.com/HACKATHON.md
- https://github.com/near/NEPs/blob/master/neps/nep-0141.md
- https://github.com/near-examples/FT
- https://github.com/near/near-workspaces-rs
- https://github.com/near/wallet-selector
- https://pump.fun/docs/fees
- https://docs.meme.cooking/other/fees/
- https://github.com/clawdbotatg/clawd-fomo3d-v2
- https://fomo3d.app/en/rules
- https://anj.fr/professionnels/porteur-de-projet
- https://anj.fr/jeux-objets-numeriques-monetisables-jonum
