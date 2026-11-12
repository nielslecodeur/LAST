# Gate 4 — end-to-end validation on NEAR Testnet

**Contract:** `last-armand.testnet` · **Network:** NEAR Testnet only · **Tokenomics:** current V1 (4% / 2%, 70/10/15/5). Crown Economy V2 and other ideas are out of scope until Gate 4 passes.
**Rule:** no redeploy without coordination, no mainnet. Transactions are signed by humans in their own wallets. The agent only reads.

## 1. Pre-checks (done 2026-11-12, read-only)

| Check | Result | Evidence |
|---|---|---|
| Deployed code = latest Gate 2 code | **PASS** | sha256 of on-chain code `7f0f829e…a17d9` = `DEPLOYMENT.md`. base58 = `code_hash` `9YzVhzaCPqgzaFRGi76BiFZmFXMVxhTTwfYm7xtXCryE`. Deployed commit `ca30bf8` contains Gate 2 (`bb4bf59`), and no file under `contracts/` changed after it. Build is `non-reproducible-wasm`, so the source↔binary link relies on `DEPLOYMENT.md` plus the exported methods |
| Deploy + init transaction | **PASS** | [`67jy6P9c…`](https://testnet.nearblocks.io/txns/67jy6P9cPeJ9wNYmP4CzESok3TxWkt7coubbMMZg2Pri): `DeployContract` + `new`, SUCCESS, 19.90 Tgas burnt of 100, `ft_mint` 1,000,000 LAST |
| Gate 2 methods exported | **PASS** | `settle_round`, `claim_reward`, `withdraw_near_credit`, `get_round`, `on_withdraw_complete`, `on_prize_payment_complete` |
| Baseline invariants (12) | **PASS** | `node scripts/gate4.mjs snapshot last-armand.testnet` → IDLE round #1, X = 3 NEAR, Y = 1,000,000 LAST, balance 9.998 ≥ storage 2.398 + obligations 3 |
| Web app read-only integration | **PASS** | `apps/web` live suite 4/4 |

## 2. Tools (read-only)

```bash
# state + 12 financial invariants (exit 1 if one fails); save it to diff later
node scripts/gate4.mjs snapshot --out s1.json <walletA>.testnet <walletB>.testnet
# a transaction: actions, gas burnt per receipt vs attached, callbacks, EVENT_JSON, ERR codes
node scripts/gate4.mjs tx <tx_hash> <signer>.testnet
# what changed between two snapshots (pots, reserves, leader, deadline, balances, credits, claims)
node scripts/gate4.mjs diff s1.json s2.json
```

Invariants checked: I1 solvency (`balance + in_flight ≥ storage + obligations`), I2 obligations = sum of the 7 buckets, I3 surplus formula, I4/I5 integrity matches market and game, I6 supply = 10^24, I7 inventory = contract FT balance, I8 no LAST created, I9 game status consistent with time, I10 credits, I11 claimable rounds, I12 unpaid prizes.

## 3. Procedure (humans sign, ~10 min, one 2-minute round)

Prerequisites:
- Two testnet accounts **A** and **B** (created by you, never by the agent), each with ≥ 1 testnet NEAR, in a testnet wallet.
- Two browser profiles side by side.
- App running: `pnpm --dir apps/web dev` → `http://localhost:5173/?demo=1`.

Take `snapshot --out sN.json A B` before the first step and after each one. Copy each transaction hash from the app's activity panel (or the wallet).

| # | Scenario | Who / action in the app | PASS criteria (contract state, not UI) |
|---|---|---|---|
| S1 | A buys and becomes leader | A: Buy 0.05 NEAR. First buy = one tx with `storage_deposit` + `buy` | `status ACTIVE`, `leader = A`, `qualifying_buy_count = 1`, A registered, LAST > 0. `active_pot` = 70% of the fee (+ seed). Invariants PASS |
| S2 | B buys and takes the crown | B: Buy 0.10 NEAR | `leader = B`, `deadline_ns` moved forward, `qualifying_buy_count = 2` |
| S3 | Buy under the minimum does not reset the timer | A: Buy 0.01 NEAR | `leader = B` and `deadline_ns` **unchanged**, `buy_count` +1, `qualifying_buy_count` unchanged, A's LAST up. Event `buy` with `eligible:false` |
| S4 | A sale creates a NEAR credit | B: Sell part of its LAST | B `credit_available` > 0, `credits_outstanding` up by the same amount, leader/deadline unchanged, B's wallet NEAR **not** credited by the sell |
| S5 | Round expires, `settle_round()` works | Wait > 120 s with no eligible buy. Before settling, a buy is refused with `ERR_ROUND_EXPIRED` (the app blocks it, so optional). Then A: Settle | `last_settled_round_id = 1`, `get_round(1)`: `winner = B`, prize = old `active_pot`, `AVAILABLE`. Game `IDLE`, `round_id = 2`. `next_seed_pot` untouched. `prizes_outstanding` = prize |
| S6 | Winner claims | B: Claim reward | Callback `on_prize_payment_complete` OK with `success:true`, `get_round(1).claim_status = PAID`, `claimable_rounds` empty, `prizes_outstanding` down by the prize, B's wallet up by the prize (minus gas), `in_flight = 0` |
| S7 | Second claim refused | B: "Claim round #1 again" (`?demo=1`) | Transaction FAILURE `ERR_ALREADY_PAID`. No transfer, nothing changed except B's gas |
| S8 | `withdraw_near_credit()` works | B: Withdraw NEAR | Callback `on_withdraw_complete` `success:true`, B `credit_available = 0`, `credit_in_flight = 0`, `credits_outstanding` down, B's wallet up |
| S9 | New round can start | A: Buy 0.05 NEAR | `round_id = 2` ACTIVE, `leader = A`, active pot started from the previous `next_seed_pot` |
| S10 | Invariants after everything | `snapshot` | 12/12 PASS. Surplus ≥ 0. `in_flight = 0` |

Also record for each tx with `gate4.mjs tx`:
- gas burnt vs attached (buy 30, first buy 60, sell 30, settle 30, claim 50, withdraw 50 Tgas);
- that the callbacks ran;
- the `AVAILABLE → IN_FLIGHT → PAID` events (`prize_claim`, `credit_withdraw`).

## 4. Results

_To fill from real transactions. Nothing below has been run yet._

| # | Status | Transaction(s) | Gas burnt / attached | Notes |
|---|---|---|---|---|
| S1 | PENDING | | | |
| S2 | PENDING | | | |
| S3 | PENDING | | | |
| S4 | PENDING | | | |
| S5 | PENDING | | | |
| S6 | PENDING | | | |
| S7 | PENDING | | | |
| S8 | PENDING | | | |
| S9 | PENDING | | | |
| S10 | PENDING | | | |

**Buy → Settle → Claim cycle functional on testnet:** not yet confirmed (needs S1, S2, S5, S6).

## 5. Known risks (going in)

- The contract is **not immutable**: `last-armand.testnet` keeps its full-access key (disclosed in `DEPLOYMENT.md`).
- Public testnet: a third party can buy during the test and take the crown or reset the timer. Record it as is.
- Gas values (30 / 50 Tgas) are untested on testnet until S1–S8 run.
- The wallet path (HOT Connect) has not been used with a real wallet yet. S1 is the first real test.
- `owner = treasury = platform = last-armand.testnet`. Treasury and ops withdrawals do not exist in V1 (the funds stay reserved).
