# LAST — Last Buyer Wins

> **NEAR Hackathon 2026 | Memecoins With Mechanics + Games With Real Economies**  
> **Status: V2 design proposal, ready for implementation — NO onchain deployment or functioning application is claimed yet.**  
> **Network: NEAR Testnet exclusively. Never use real-value tokens for this prototype.**

## One-sentence pitch

**Buy LAST. Take the crown. Every qualifying purchase restarts a countdown; if nobody buys before it expires, the last buyer wins the NEAR jackpot — all enforced onchain.**

LAST is an experimental memecoin game with its own onchain NEAR/LAST market. A portion of the market's fees funds the current round's prize and a seed for the next round. Anyone can settle an expired round; the winner claims their reward. The game does not rely on a server to decide who won.

This is **not a novel invention of last-buyer-wins mechanics**: FOMO3D (2018), Fomo3D variants and ClawFomo demonstrate precedents. The V2 aim is a simpler, independently auditable NEAR implementation, not a claim of originality for the timer game itself.

## 1. Scope and truthfulness

The **planned** MVP contains one Rust smart contract, a NEP-141-compatible token, a constant-product native-NEAR/LAST internal market, round tracking, segregated fee accounting, claimable payouts, and a React frontend. No external DEX, token bridge, indexer, AI agent, DAO, or automatic trading bot is required.

**Only purchases executed through LAST's own `buy()` method count.** Transfers of LAST and trades on independent DEXs never reset the timer or pay LAST's game fee. NEP-141 does not provide a general-purpose hook that could reliably classify every external DEX trade.

**Status at document creation:** specification only. Any examples of methods, commands, transaction hashes or addresses in this document describe what developers must implement or fill in, not already-running deployments.

## 2. V2 economic policy

### Market fees (NOT NEAR network gas)

| Transaction | LAST internal-market fee | Rationale |
|---|---:|---|
| Buy LAST for native NEAR | **4.00%** of gross NEAR input | Main source of current prize |
| Sell LAST for native NEAR | **2.00%** of gross NEAR sale output | Lower friction to exit |
| Wallet-to-wallet FT transfer | **0% LAST game fee** | Standard FT transfer, may cost network gas/storage |
| Claim jackpot | **0% additional game fee** | Prize is net; only the normal NEAR network gas applies |

These percentages are **design decisions**, not market averages or mathematically optimal rates. The V1 5%/5% model was reduced to mitigate round-trip costs. Relative benchmarks: Pump.fun reports a 1.25% fee on its bonding curve (before applicable interface fees), while Meme.Cooking lists a 0.5% deposit fee, 2% launch fee and 2% early-withdrawal penalty. Different businesses and fee bases are **not directly comparable**.

### Allocation of each LAST trading fee

| Destination | Share **of the fee** | 1 NEAR buy: fee 0.04 NEAR |
|---|---:|---:|
| Current round jackpot | **70%** | 0.028 NEAR |
| Seed for the next round | **10%** | 0.004 NEAR |
| Project treasury reserve | **15%** | 0.006 NEAR |
| Platform/operations | **5%** | 0.002 NEAR |
| **Total fee** | **100%** | **0.040 NEAR** |
| Credited to trading reserve | — | **0.960 NEAR** |

The 15% treasury reserve is **NOT automatically deployed as real Rhea LP** in the MVP. It is tracked separately in the contract's accounting. Operational shares, withdrawal rights, and safe accounting are described in [docs/SPEC_V2.md](docs/SPEC_V2.md).

For a sell that produces 1 NEAR **gross** before LAST's fee, the trader receives 0.98 NEAR; the remaining 0.02 NEAR is split 0.014/0.002/0.003/0.001 NEAR across jackpot/next seed/treasury/ops. The trading reserve decreases by the 1 NEAR gross output, not the 0.98 NEAR paid to the seller.

**Idle-round policy:** fees from trades while no round is active send their combined 80% prize-related share into a pending next-round pot. For an active round, the 70% component belongs to the live jackpot and the 10% component remains assigned to the next-round seed. Upon settlement, the live prize is *reserved for the winner* and may never be reused to fund trades or later rounds.

### Example sensitivity, excluding price impact and gas

| Gross buy volume | Gross sell output volume | Buy fees (4%) | Sell fees (2%) | 70% current-jackpot allocation |
|---:|---:|---:|---:|---:|
| 10 NEAR | 0 NEAR | 0.40 | 0 | 0.28 NEAR |
| 100 NEAR | 40 NEAR | 4.00 | 0.80 | 3.36 NEAR |
| 500 NEAR | 200 NEAR | 20.00 | 4.00 | 16.80 NEAR |

These figures illustrate **fee allocation only**, not trading profits, expected payouts or a forecast of user activity. A player can lose money even if they win a prize; price impact, entry and exit fees, competition and gas matter.

## 3. LAST tokenomics — deliberately simple

| Parameter | V2 decision |
|---|---|
| Token name / symbol | Last Buyer Wins / LAST |
| Standard | NEP-141, NEP-145 storage, NEP-148 metadata |
| Max/initial supply | **1,000,000 LAST** |
| Decimals | **18** |
| Initial distribution | **100% of supply in the contract's trading inventory** |
| Team allocation | **0%** |
| Private sale / presale | **None** |
| Additional mint | **Disabled** after one-time initialization |
| Token burn / staking / holder dividends | **None in V2 MVP** |
| Transfer tax | **0%**; only internal-market trades pay game fees |
| Market | Native NEAR paired with LAST, inside the same Rust contract |

**Bootstrap:** seed the market with a *real, separately accounted-for* testnet NEAR reserve: **3 NEAR proposed for the demo**, plus a separate storage/gas buffer. The seed NEAR is **market liquidity, not free-to-withdraw treasury funds**. Initial marginal spot price: about **0.000003 NEAR per LAST** before trades, fees or slippage; this is a thin test market and does not represent market valuation, guaranteed resale or a production price.

For 48 hours, do **not** add team vesting, creator allocations, unlock schedules, airdrops, referral trees, dividends or automated liquidity migrations. This is an onchain game, not a promise of investment returns.

## 4. Game rules — exact semantics

- **Production concept:** 60 minutes rolling timer after each eligible buy.
- **Testnet demo deployment:** 120 seconds, clearly labeled as a different immutable configuration.
- **Eligible buy minimum:** **0.03 NEAR gross** for the 3 NEAR seed configuration. An amount below this may buy tokens but **never** changes the current leader/deadline. This is *not* reliable anti-bot protection.
- **Buying** through `buy()` updates the AMM and pays the fee. An eligible purchase atomically becomes the latest buyer and moves the deadline to `block_timestamp + duration`.
- **Selling**, transfers and self-transfers never change leader or deadline. A winning buyer **does not need to continue holding LAST** unless a future version explicitly changes the rules.
- The **first eligible buy** activates a round and its pot includes the previous round's seeded reserve (plus fees accumulated while idle).
- Once the deadline is reached, **all market trading pauses until `settle_round()`**. A purchase confirmed at or after expiry cannot rescue the previous round, even if its transaction was submitted earlier.
- `settle_round()` is a permissionless, one-time state transition. It identifies the winner and moves the exact pot into their **claimable** balance. It **does not automatically transfer NEAR**.
- After settlement, the next round awaits its first qualifying buy. Its seed is already segregated and accounted for; the old reward remains reserved for the previous winner.
- `claim_reward(round_id)` pays the stored winner using an asynchronous transfer and a private callback: `AVAILABLE → IN_FLIGHT → PAID`, or `IN_FLIGHT → AVAILABLE` after a confirmed failure. Double claims are rejected.
- No admin can edit a round's winner, timer, fee allocations or reserve balance retroactively.
- **Bots are allowed by the protocol**; the game cannot honestly guarantee human-only participation, unbiased last-second inclusion or protection from all MEV strategies.

The smart contract relies on NEAR's confirmed block timestamp, never on the browser countdown. A countdown on the web is an estimate until a transaction is confirmed.

## 5. Architecture

**One contract, internally modularized**. This avoids asynchronous coordination between separate token, market, and game contracts and ensures `buy() + accounting + leader update` happen together.

```text
Wallet / NEAR Testnet
  |
  v
React + TypeScript frontend  ---->  NEAR read-only RPC
  |
  +---- signed buy(amount, min_tokens_out)
  +---- signed sell(amount, min_near_out)
  +---- signed settle_round()
  +---- signed claim_reward(round_id)
  |
  v
Rust contract LAST
  |-- NEP-141 / storage management (LAST balances)
  |-- Internal x*y=k AMM (NEAR / LAST reserves)
  |-- Fee ledgers (jackpot / next seed / treasury / ops)
  |-- Round state (leader / deadline / settled)
  |-- Async payout state and private callback
  `-- Read-only methods, events
```

For a simple price quoted in NEAR per LAST, display the *current marginal price* inferred from reserves (not an oracle or a promise that a large trade can clear at this price). Before execution, show `quote_buy()` / `quote_sell()`, the percentage fee and minimum received after slippage.

### Public contract API to implement (proposed, not already deployed)

```text
new(config)                         — one-time initialization and real bootstrap reserve
buy(min_tokens_out)                — payable; use actual attached NEAR
sell(tokens_in, min_near_out)       — sell LAST, credit withdrawable NEAR (pull payout)
withdraw_near_credit()               — withdraw sale proceeds with async callback
settle_round()                     — permissionless once the deadline passes
claim_reward(round_id)             — winner only; async NEAR payout
get_game_state()                   — leader, deadline, pots, round number
get_round(round_id)                — winner, payout status, historical details
get_market_state()                 — real X/Y market reserves and volume
quote_buy(gross_near)               — preview before signing
quote_sell(tokens_in)               — preview before signing
get_account_state(account_id)       — LAST holding and claims summary
ft_total_supply / ft_balance_of / ft_transfer / ft_transfer_call
ft_metadata / storage_deposit / storage_balance_of / storage_withdraw
```

The implementation must honor NEP-141's required interface and standard storage semantics; the listed names are targets, **not a claim that all FT methods have already been written**. Never calculate prices or rewards with JS `Number` or Rust floating point: use decimal strings / `u128` and verified wider multiplication for intermediate products.

### AMM accounting invariants

- A market buy increases native-NEAR **market reserve** by `gross - fee`; it decreases **market LAST inventory** by `tokens_out`.
- A market sell decreases native-NEAR **market reserve** by `gross_near_out`; it increases **market LAST inventory** by `tokens_in`. `gross_near_out - fee` becomes the seller's withdrawable NEAR credit; the fee remains in its own buckets. `sell()` does not send an asynchronous payment in the critical market transaction.
- All arithmetic must check overflow, underflow, zero outputs, slippage and liquidity remaining. Use `U256`/checked multi-precision intermediate multiplication.
- The token inventory held by the market must match the token ledger; no hidden minting or creation by frontend.
- All jackpot funds, next-round funds, unclaimed payouts, platform fees, treasury funds, storage refund liabilities and gas/storage buffers must be segregated from the tradable reserve. The contract's usable NEAR balance must **always cover the combined liabilities**.
- Async withdrawals of **sale credits** and jackpot payouts require reservation + idempotent callback handling. `sell()` itself changes internal balances and creates a withdrawable credit; it does not send NEAR asynchronously. A successful promise transfer may not be treated as paid until the result is confirmed.
- For any failed transaction, inspect its actual receipt and resulting state. Never assume a refund equals all attached gas.

More precise invariants, edge cases and threat modeling are in [docs/SPEC_V2.md](docs/SPEC_V2.md).

## 6. UI MVP

The home screen must show the token and the game state without any wallet connection: **LAST**, NEAR/LAST indicative spot price, current round, last buyer, countdown, jackpot in NEAR, next-round seed, volume, eligible purchases, recent activity, current user's holdings (if connected), previous winner and round history.

With a wallet connected, the player can quote and sign a buy, quote and sign a sell, **withdraw the resulting NEAR credit**, settle an expired round and claim a confirmed reward. Show network, storage registration prerequisites, exact fee, slippage, transaction pending/failed/successful states and a link to the explorer. Use real contract views; use **clearly labeled mock states only for isolated local UI development**, never on a public testnet dashboard.

**Accessibility:** responsive layout, legible countdown, `prefers-reduced-motion`, visible zero jackpot/zero buyer empty states. Visual inspiration: polished memecoin launchpad, not a fake trading terminal.

## 7. Repo structure and team of two

```text
last/
├── README.md                  # This file — project contract for the team
├── CLAUDE.md                  # Shared coding-agent rules
├── .gitignore
├── contracts/
│   └── last/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs         # entry points / initialization
│           ├── token.rs       # NEP-141 standard
│           ├── market.rs      # quotes + buy/sell + reserves
│           ├── game.rs        # round lifecycle
│           ├── accounting.rs  # liabilities and fees
│           ├── payouts.rs     # claim and callbacks
│           └── events.rs      # JSON events
├── apps/
│   └── web/
│       ├── src/
│       │   ├── components/
│       │   ├── hooks/
│       │   ├── lib/
│       │   └── pages/
│       └── package.json
├── tests/
│   └── integration/           # near-workspaces sandbox scenarios
├── scripts/                   # reproducible dev/testnet operations
└── docs/
    ├── SPEC_V2.md
    ├── ECONOMICS.md
    └── TEST_PLAN.md
```

**Developer A — Rust/contracts, 55%:** token standard, market formulas and balances, fee accounting, round machine, secure claims and tests. **Developer B — frontend/integration, 45%:** wallet connection, full dashboard, quote/trade UX, explorer links, reproducible demo and README. Both coordinate on `docs/CONTRACT_API.md` before implementing UI and jointly test NEAR Testnet.

Git: `main`, `feat/contracts`, `feat/web`. No automatic `main` merge, deployment or wallet signature without approval.

## 8. 48-hour execution plan

| Hours | Contracts (A) | Frontend / QA (B) | Gate |
|---|---|---|---|
| 0–4 | Init contract and economic invariants | Setup web, wallet, design | API agreed, no implementation claims |
| 4–14 | FT storage + buy / sell + fee bookkeeping | Dashboard with explicit mocks | Unit AMM tests pass |
| 14–24 | Round state + settlement + payout callbacks | Wallet, quotes, signed buys | Sandbox buy→round→settle→claim |
| 24–34 | Hardening, integration & sandbox | Real contract data, error handling | All critical tests pass |
| 34–42 | Authorized NEAR Testnet deploy and receipts | End-to-end live testnet demo | Real tx hashes and visible balances |
| 42–48 | Audit, regression tests, release docs | Video, screenshot, X demo post | Complete reproducible submission |

If time runs short: **must keep** buy, qualify, reset, settle, claim, storage, accounting, UI confirmation, true testnet receipts. **Cut** sell only as an explicitly disclosed emergency fallback (then LAST becomes a one-way testnet game, not a complete market), analytics, leaderboard, bots, liquidity migration, treasury withdrawals, animated charts, custom NFTs and token mint mechanics. Do **not** fake sell support or a working DEX.

## 9. Acceptance tests (minimum)

1. Wallet A makes an eligible 0.03 NEAR buy: becomes leader; expires in configured duration.
2. Wallet B buys at least 0.03 NEAR: becomes leader, timer resets.
3. A purchase below 0.03 NEAR changes balances and fees but not leader/deadline.
4. A sale never changes leader/deadline; its NEAR proceeds become a separately withdrawable credit.
5. A purchase at or after expiry cannot overwrite the settled winner; it is rejected until settlement.
6. Any account can settle a round only after expiry.
7. A round cannot settle twice; old funds cannot be reused by the next round.
8. Only the recorded winner can claim; second claim cannot pay twice.
9. Failed claim transfer results in an accurately reconciled claim state.
10. `quote_buy`, `quote_sell`, buy/sell execution and available reserve obey integer rounding and slippage boundaries.
11. Storage deposits, registrations, NEP-141 transfers and their funding remain correct.
12. Physical NEAR balance covers market reserve plus each explicitly reserved liability after every successful operation.
13. Multi-wallet integration test produces real NEAR Testnet transaction receipts (separate from mocks and sandbox tests).

## 10. Local setup — planned commands, to be enabled by developers

**Prerequisites:** Ubuntu/WSL or Linux for Rust sandbox tests, Rust toolchain, WASM target, `cargo-near`, Node.js LTS, pnpm, and an authorized NEAR Testnet wallet. Pin versions in lockfiles after validation. Never paste or commit private keys or `.env` secrets.

```bash
# From the initialized project root, once the code and manifests have been written:
cargo test --manifest-path contracts/last/Cargo.toml
cd contracts/last && cargo near build && cd ../..
pnpm install
pnpm --dir apps/web dev
```

These commands represent the **target developer workflow** and cannot work until the source, Cargo manifest and frontend package exist. Do not mark tests passing or show deployment hashes until actual execution.

## 11. Testnet demo checklist

- [x] Rust unit tests and contract WASM build passed (63 unit tests, 239 KB WASM)
- [x] Sandbox integration tests passed, including payouts and state invariants (`tests/integration`)
- [x] One NEAR Testnet contract deployed, contract ID recorded: `last-armand.testnet` (see `docs/DEPLOYMENT.md`)
- [ ] Two distinct testnet wallets used, with contract storage funded
- [ ] Two signed eligible buys with transaction links
- [ ] Ineligible dust buy observed and rejected for timer purposes
- [ ] A sale observed without changing the leader
- [ ] `settle_round` after expiration with an explorer link
- [ ] Actual jackpot claim and rejected second claim, both documented
- [ ] Real NEAR balance and reserve reconciliation documented
- [ ] README updated with commands, outputs, architecture and deployed addresses
- [ ] GitHub public, LICENSE present, AI-generated/pre-existing code credited
- [ ] Demo video and public X post as required by NEAR Hackathon 2026

Official deadline: **14 November 2026, 23:59 UTC**. Check the official live rules before submitting: https://nearhackathon.com/HACKATHON.md

## 12. Risks and legal notice

This demo is a high-risk, prize-based trading game. Last-second bots, multiple wallets controlled by one player, transaction ordering, price volatility, thin liquidity, network failure, gas, and fee compounding can cause losses. **No fair-access, anti-bot, price stability or profitability guarantee.** FOMO3D-style games have previously experienced block-congestion attacks; LAST does not claim to eliminate all such strategies.

**Testnet only — no monetary value.** A real-money launch may fall under gambling regulation. The French ANJ describes four relevant criteria: a public offer, a financial sacrifice, a chance-based element and an expectation of gain. JONUM rules are not automatic authorization for a NEAR jackpot. Obtain professional legal advice before any public mainnet offer.

The contract is unaudited. Do not handle real funds without a full independent security review.

## 13. Research references (checked 12 Nov 2026)

- NEAR Hackathon: https://nearhackathon.com/HACKATHON.md
- NEAR Fungible Token standard: https://github.com/near/NEPs/blob/master/neps/nep-0141.md
- Official Rust FT example: https://github.com/near-examples/FT
- NEAR contract SDK: https://github.com/near/near-sdk-rs
- NEAR Workspaces: https://github.com/near/near-workspaces-rs
- NEAR Wallet Selector (check HOT Connect recommendation): https://github.com/near/wallet-selector
- Pump.fun fee schedule: https://pump.fun/docs/fees
- Meme.Cooking fees: https://docs.meme.cooking/other/fees/
- ClawFomo game example: https://github.com/clawdbotatg/clawd-fomo3d-v2
- Fomo3D modern variant (not original 2018 contract): https://fomo3d.app/en/rules
- FOMO3D 2018 historical overview: https://www.theblock.co/news/ecosystems/2019-08-14-blockchain-gaming-part-iii-protocol-led-second-generation-games-36054
- French ANJ gambling criteria: https://anj.fr/professionnels/porteur-de-projet
- French ANJ JONUM framework: https://anj.fr/jeux-objets-numeriques-monetisables-jonum

## 14. License and credits

**License:** [MIT](LICENSE), © 2026 armand418 and nielslecodeur. The software is provided "as is", without warranty; this does not replace the risk and legal notice in §12.

**Team:** armand418 (Developer A — contract, sandbox tests, testnet deployment) and nielslecodeur (Developer B — frontend, wallet integration, testnet demo run).

**AI-generated code:** both developers used Claude Code (Anthropic, model Claude Opus 5.5) to write a large part of the code, tests and documentation, under human review. Commits produced with it carry a `Co-Authored-By: Claude` trailer. The specification, economic choices and every deploy/signature decision were made by the developers.

**Pre-existing libraries (not written by us):**

| Library | Used for | License |
|---|---|---|
| [`near-sdk`](https://github.com/near/near-sdk-rs) 5.30.1 | Contract SDK | MIT or Apache-2.0 |
| [`near-contract-standards`](https://github.com/near/near-sdk-rs) 5.30.1 | NEP-141/145/148 fungible token implementation (`FungibleToken`) | MIT or Apache-2.0 |
| [`uint`](https://github.com/paritytech/parity-common) 0.10.2 | 256-bit integers for AMM math | MIT or Apache-2.0 |
| [`near-workspaces`](https://github.com/near/near-workspaces-rs) 0.24.0, `tokio`, `anyhow`, `serde_json` | Sandbox integration tests | MIT or Apache-2.0 (`tokio`: MIT) |
| `cargo-near`, `near-cli-rs` | WASM build and testnet deployment tooling | MIT or Apache-2.0 |

Frontend dependencies are listed in `apps/web/package.json`.

**Prior art:** the last-buyer-wins timer mechanic is not ours; see the FOMO3D, Fomo3D and ClawFomo references in §13.

**One-line design principle:** Never show an onchain game result that cannot be reconstructed from real contract state and transaction receipts.
