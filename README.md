# $LAST — the last buyer takes the pot

**$LAST is a memecoin live on NEAR mainnet with a jackpot game built into its trading.**
Every buy of at least **0.5 NEAR** takes the crown and resets a **60-minute** countdown. When the countdown reaches zero, **90% of the jackpot is paid automatically** to the last crown holder and 10% seeds the next round. The jackpot is funded by the token's trading: **all of the creator's share of the pool fees and of the 1% buy/sell tax** goes to the jackpot contract.

- **Play / buy:** https://nearly.trade/last-2.nearlytrade.near
- **Live jackpot:** https://last-jackpot.vercel.app
- **Jackpot contract:** [`pot.heavycat9990.near`](https://nearblocks.io/address/pot.heavycat9990.near)
- **Token:** [`last-2.nearlytrade.near`](https://nearblocks.io/token/last-2.nearlytrade.near)
- **Hackathon track:** NEAR Hackathon 2026, *Memecoins With Mechanics*

## Key facts

| Item | Value |
|---|---|
| Network | **NEAR mainnet** |
| Token | `$LAST` (name "Last"), NEP-141, contract `last-2.nearlytrade.near`, 18 decimals, fixed supply 1,000,000,000 |
| Launchpad | [Nearly](https://nearly.trade/last-2.nearlytrade.near), launched 2026-11-13 by `heavycat9990.near`. We chose Nearly because it is the most popular launchpad on NEAR, which gives $LAST more visibility with traders, and because it can route the token's fees to any account (here the jackpot contract) |
| Liquidity pool | Rhea DCL `last-2.nearlytrade.near\|wrap.near\|10000` (LP locked by Nearly) |
| Fees to the jackpot | Creator share of the pool fees + 1% buy tax + 1% sell tax (100% of the creator side, 0% burn, 0% holders), routed to `pot.heavycat9990.near` by Nearly (`fee_to`, locked at launch), delivered every ~5 minutes. Nearly keeps its own platform share. |
| Jackpot contract | `pot.heavycat9990.near`, source `contracts/last-pot`, Rust (`near-sdk` 5.30.1) |
| Round rules | crown buy ≥ **0.5 NEAR**, timer **60 min** from the crown buy, winner gets **90%** of the available pot, 10% stays as the next round's seed |
| Grace period | 2 min after the deadline before settlement, so a buy made in time but reported late still counts |
| Payout | automatic transfer to the winner inside `settle_round`; if a transfer fails the prize stays claimable with `claim_reward` |
| Admin powers | owner can only replace the reporter account and set the token id once; **nobody can withdraw the jackpot** |
| Website | https://last-jackpot.vercel.app (source `apps/web`) |
| License | MIT |

## How it works

```text
players ──buy / sell $LAST──▶  Nearly token + Rhea DCL pool
                                    │ creator fees + 1% buy/sell tax (every ~5 min)
                                    ▼
reporter bot ──record_buy──▶  pot.heavycat9990.near  ──90% of pot──▶ winner
(scripts/reporter.py)         jackpot · timer · crown      settle_round (automatic)
reads the token's txs         10% stays for the next round
```

1. **Buy $LAST** on Nearly with at least 0.5 NEAR. You take the crown.
2. **Every crown buy resets the clock** to 60 minutes. Smaller buys and sells never touch the crown.
3. **If nobody buys before zero,** the last crown holder wins the round. Selling your $LAST does not cancel your win: the rule is purchase-based.
4. **The contract pays the winner by itself:** `settle_round` sends 90% of the pot in the same call. The next crown buy starts a new round with the remaining 10% as its seed.

### Why a reporter bot

The token and its pool are Nearly's contracts: they send fees to the jackpot account but never call it, and a NEAR contract cannot read transaction history. So a reporter account watches the token's transactions and calls `record_buy(buyer, near_in, tx_hash, buy_timestamp_ns)` for every eligible buy, then `settle_round` when a round expires.

- **Buy detection:** a receipt on the token logs a NEP-141 `ft_transfer` **to the transaction signer**, and the NEAR spent is the sum of `wrap.near` "Transfer … from <signer>" logs in the same transaction. This covers Rhea DCL, Rhea v2 and aggregator routes and NEAR wrapped on the fly. Buys paid with another token are not eligible.
- **What the reporter can do:** choose which buys are recorded. Every record carries the transaction hash, so anyone can check it on an explorer.
- **What it cannot do:** move funds, change the rules, or create a winner without a matching buy record. Reports must be chronological and in the past; a buy after the deadline cannot extend a round; a stale buy cannot start a new one.
- **Data sources:** FastNEAR transactions API (`tx.main.fastnear.com`) to list the token's transactions; public RPCs for contract views; near-cli to sign.
- **Where it runs:** on GitHub Actions, in [armand418/last-reporter](https://github.com/armand418/last-reporter): runs of ~5 h 45 min started every 6 hours, each resuming from a cursor committed to that repo. It signs with a **function-call access key** of `heavycat9990.near` limited to `record_buy` and `settle_round` on `pot.heavycat9990.near` (it cannot transfer NEAR).

## Verify it on-chain

Read-only, no wallet needed ([near-cli-rs](https://github.com/near/near-cli-rs)):

```bash
near contract call-function as-read-only pot.heavycat9990.near get_state json-args '{}' network-config mainnet now
near contract call-function as-read-only pot.heavycat9990.near get_config json-args '{}' network-config mainnet now
near contract call-function as-read-only pot.heavycat9990.near get_round json-args '{"round_id":"1"}' network-config mainnet now
```

`get_state` returns the status (`IDLE` / `ACTIVE` / `EXPIRED`), the crown holder, the deadline (ns), the pot, the current prize, the hash of the last crown buy, and totals. Contract events are logged as `EVENT_JSON` with standard `last-pot` (`round_started`, `buy_recorded`, `round_settled`, `payout`, `token_set`, `reporter_changed`).

| Deployment record | Value |
|---|---|
| Deploy + init tx | [`EvahQHgSZbYfbmQricYQRgG9hWASvmY1s8wEWxsSx6Lg`](https://nearblocks.io/txns/EvahQHgSZbYfbmQricYQRgG9hWASvmY1s8wEWxsSx6Lg) |
| On-chain code hash | `7R8M7jsAcY3AyPEr9FkWNRJLgtDpAEwuZmfkkawzUN8m` = sha256 `5f545e39…f8fe` of the WASM built from `contracts/last-pot` |
| Token launch tx | [`DXhHMngBAQd4xssXjW3zHacZruM4PniGjPuig3qSsCqp`](https://nearblocks.io/txns/DXhHMngBAQd4xssXjW3zHacZruM4PniGjPuig3qSsCqp) (`fee_to` = `pot.heavycat9990.near`) |
| Token id recorded | [`9VDknpyursvPvVSTW2qMas7jRzeEUyV4DZbwYWah3gCU`](https://nearblocks.io/txns/9VDknpyursvPvVSTW2qMas7jRzeEUyV4DZbwYWah3gCU) |
| First crown buy recorded | [`6AvsPPGyn2SUH2gwmzkECrf2bctEJtZtW2i7GrYhGbcq`](https://nearblocks.io/txns/6AvsPPGyn2SUH2gwmzkECrf2bctEJtZtW2i7GrYhGbcq) (10 NEAR buy by `wrapz-z.near`, tx `5H7PAmLC…`) |
| Round 1 settled and paid | [`7PN8F3LGzPgGaP5QyF3xNiH1FQmsvptxGQpydwVRy9xk`](https://nearblocks.io/txns/7PN8F3LGzPgGaP5QyF3xNiH1FQmsvptxGQpydwVRy9xk): `wrapz-z.near` won 0.1763 NEAR, sent automatically (`get_round` 1 → `PAID`) |

More detail: [`docs/MAINNET_POT.md`](docs/MAINNET_POT.md).

## Repository

```text
contracts/last-pot/     Jackpot contract (Rust, near-sdk 5.30.1): rounds, record_buy, settle_round + payout, views
  src/lib.rs            contract
  src/tests.rs          23 unit tests
scripts/reporter.py     Reporter bot (Python 3, stdlib only + near-cli for signing); deployed copy: armand418/last-reporter
apps/web/               Jackpot website (React 19 + Vite + Tailwind 4), reads the contract over public RPC
  src/pot/              page, contract reader, polling hook
brand/                  Token logo (PNG) and generator
docs/MAINNET_POT.md     Architecture, trust model, parameters, deployment runbook
```

## Build and test

Contract (Linux/WSL; on Windows the `near-sdk` test feature needs NASM + CMake, so use WSL):

```bash
cargo test --manifest-path contracts/last-pot/Cargo.toml
cd contracts/last-pot && cargo near build non-reproducible-wasm --no-abi
```

Website:

```bash
pnpm --dir apps/web install
pnpm --dir apps/web test
pnpm --dir apps/web dev
```

Reporter (needs the reporter account key in the near-cli legacy keychain; `--dry-run` signs nothing, `--max-runtime N` exits cleanly after N seconds):

```bash
python3 scripts/reporter.py --pot pot.heavycat9990.near --token last-2.nearlytrade.near --reporter heavycat9990.near --dry-run
```

## Limitations and risks

- **The reporter is a trusted, single operator.** It records buys and triggers settlement. If it stops, rounds are not updated until it restarts (it resumes from its saved cursor); a buy reported after its round was settled no longer counts. GitHub may start a scheduled run a few minutes late. `settle_round` itself is permissionless: anyone can call it after the deadline.
- **Fees arrive in batches (~5 min),** so fees from the last minutes of a round can land in the next round's pot.
- **Only buys paid in NEAR/wNEAR count** toward the crown.
- **Bots and multiple wallets can play.** There is no fairness or anti-sniping guarantee; transaction ordering and last-second buys are part of the game.
- **The contract is unaudited,** and its account keeps a full-access key, so the code could still be redeployed by its owner. It is not immutable yet.
- **This is a high-risk experimental memecoin.** Price moves, fees and competition can cause losses. Only risk what you can afford to lose. Not financial advice.

## Team and credits

- **armand418** — jackpot contract, reporter bot, mainnet deployment, website.
- **nielslecodeur** — frontend and on-chain integration work.

**AI-assisted development:** code, tests and docs were written with Claude Code (Anthropic) under human review; commits made with it carry a `Co-Authored-By: Claude` trailer. Product, economic and deployment decisions were made by the team.

**Libraries:** [`near-sdk`](https://github.com/near/near-sdk-rs) (MIT or Apache-2.0), React, Vite, Tailwind CSS, Vitest (MIT), [near-cli-rs](https://github.com/near/near-cli-rs) and [cargo-near](https://github.com/near/cargo-near) (MIT or Apache-2.0). Fonts: IBM Plex Mono, Anton (SIL OFL). Infrastructure: [Nearly](https://nearly.trade) launchpad, Rhea Finance DCL pool, FastNEAR APIs. Palette inspired by the NEAR Hackathon site.

**Prior art:** the last-buyer-wins timer comes from FOMO3D (2018) and its variants; $LAST adapts it to a NEAR memecoin whose trading fees fund the jackpot.

## License

[MIT](LICENSE), © 2026 armand418 and nielslecodeur.
