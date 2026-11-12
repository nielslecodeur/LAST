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

## 4. Results — run of 2026-11-12, 15:19–15:24 UTC

**Important:** every test transaction was signed by **one account, `nifelst.testnet`**. Both browser windows were connected to the same wallet account. The prepared accounts `lowarena9362.testnet` and `testb1.testnet` were not used: they are unregistered and still hold 5 NEAR each. The whole cycle works on-chain. A crown change between **two distinct wallets** still has to be shown on testnet (it is covered by Builder A's sandbox test).

Checked with `scripts/gate4.mjs tx` (receipts, gas, callbacks, events) and `snapshot` (state + invariants).

| # | Status | Transaction | Gas burnt / attached | Verified on-chain |
|---|---|---|---|---|
| S1 | **PASS** | [`9bw4YNor…`](https://testnet.nearblocks.io/txns/9bw4YNorTnoeby9uQexysaugxVdw6nHa4CTinxS7WJQb) `storage_deposit`+`buy` 0.05 | 4.58 / 60 Tgas | `round_started` #1 (seed 0), `eligible:true`, leader `nifelst`, 15,748.03 LAST, fee 0.002 |
| S2 | **PARTIAL** | [`8e5zh8vZ…`](https://testnet.nearblocks.io/txns/8e5zh8vZXeUyv8MfGpZihJHYeupxHV15yjrSxMg6uf4M) `buy` 0.10 | 2.82 / 30 Tgas | Eligible, `deadline_ns` reset (…912.84 s → …947.36 s), `qualifying_buy_count` 2. **Same account**: a crown *change* between players is not shown on testnet yet |
| S3 | **PASS** | [`4hfVcj8t…`](https://testnet.nearblocks.io/txns/4hfVcj8tfYHqKx2eNjqJydpZpNA91V4pv3i5uEMmGLEE) `buy` 0.01 | 5.13 / 60 Tgas | `eligible:false`, `deadline_ns` **unchanged** (…947.36 s), 2,904.71 LAST received. Also showed frontend bug F2 (needless `storage_deposit`, refunded by the contract) |
| S4 | **PASS** | [`78KfJ2LT…`](https://testnet.nearblocks.io/txns/78KfJ2LTEhFYxbzDstpmJhWywq4jnr7aoPvXJ2QmME7h) `sell` 24,000 LAST | 3.06 / 30 Tgas | gross 0.077604, fee 0.001552 (2%), payout 0.076052 → `credit_available`. No NEAR sent by `sell` |
| S5 | **PASS** | [`GD7hwLJg…`](https://testnet.nearblocks.io/txns/GD7hwLJgajWnhraTWcvhYb6ufwXZ2dzk2NExegprSL2R) `settle_round` | 2.48 / 30 Tgas | After the deadline. `round_settled` #1, winner `nifelst`, prize **0.005566451737914502596883** = exactly 70% of the 4 round fees (0.0014 + 0.0028 + 0.00028 + 0.001086451737914502596883) |
| S6 | **PASS** | [`2woWEqDT…`](https://testnet.nearblocks.io/txns/2woWEqDTSXQP4172whtkX7uoH1xg4pEZD9PpEYFDBKHK) `claim_reward(1)` | 5.57 / 50 Tgas | `prize_claim` IN_FLIGHT → transfer → callback `on_prize_payment_complete` `success:true` → `prize_claim` PAID. `get_round(1).claim_status = PAID` |
| S7 | **PASS** | [`4ebNxXCP…`](https://testnet.nearblocks.io/txns/4ebNxXCPkoEzNGAUbxTt7oD2HtDq7Xzj8hrqrH8HT5nz) `claim_reward(1)` again | 1.89 / 50 Tgas | FAILURE **`ERR_ALREADY_PAID`**, no transfer |
| S8 | **PASS** | [`AFH6hLnf…`](https://testnet.nearblocks.io/txns/AFH6hLnfRyqaisSo5YghtBKu7X2CVA9FPnG7VdyzoDH8) `withdraw_near_credit` | 5.33 / 50 Tgas | `credit_withdraw` IN_FLIGHT 0.076052 → callback `on_withdraw_complete` `success:true` → PAID. Credit 0, in flight 0 |
| S9 | **PASS** | [`G6vKPsus…`](https://testnet.nearblocks.io/txns/G6vKPsusZQPX3Ynq6t2PyuoStTkExEqNyEfuv8gjFav3) `buy` 0.05 | 5.24 / 60 Tgas | `round_started` #2 with seed **0.000795207391130643228126** = exactly the 10% shares of round 1's fees. Leader `nifelst`, round 2 ACTIVE |
| S10 | **PASS** | snapshot @ block 277381024+ | — | **12/12 invariants**. Balance 10.127664 ≥ storage 2.4004 + obligations 3.128381. LAST: inventory 960,308.43 + `nifelst` 39,691.56 = 1,000,000 (no LAST created). `in_flight` = credits = prizes = 0 |

Not covered on testnet (the UI blocks it, and the sandbox test covers it): a buy after expiry rejected with `ERR_ROUND_EXPIRED`.

**Buy → Settle → Claim cycle functional on testnet: YES** (S1, S5, S6, S7, S9). All payouts went `AVAILABLE/credit → IN_FLIGHT → PAID` through the private callbacks. **Gas** is 2–6 Tgas per transaction, far below the 30 / 50 Tgas attached (unused gas is refunded), so the proposed values are confirmed as safe.

### Bugs found by the run

| Id | Where | Severity | Status |
|---|---|---|---|
| F1 | Web app, default RPC | **High** | **Fixed** (`apps/web`): `rpc.testnet.near.org` is deprecated and answered `-429 THIS ENDPOINT IS DEPRECATED` (141 times in 7 min to our read-only watcher). The error came in an HTTP 200 body, so the app did not fall back and its data went stale. Now FastNEAR is first and `-429` triggers the fallback (tests added). Live suite: 21 s → 2.5 s |
| F2 | Web app, buy | Medium (no funds lost) | **Fixed**: with stale data the app thought the account was unregistered and prepended `storage_deposit` to every buy. The contract refunded it (`The account is already registered, refunding the deposit`), costing only gas. Registration is now re-read right before signing (test added) |
| — | Contract | — | No contract bug found |

### Still to do for a full Gate 4 PASS

1. Replay S1–S2 with **two distinct accounts** (e.g. `lowarena9362.testnet` then `testb1.testnet`), so that the crown moves from A to B on testnet. Connect each browser window to a different account in the wallet (check the account name in the app's top bar).
2. Optional: try a buy after expiry with the CLI to record an on-chain `ERR_ROUND_EXPIRED`.

## 5. Known risks (going in)

- The contract is **not immutable**: `last-armand.testnet` keeps its full-access key (disclosed in `DEPLOYMENT.md`).
- Public testnet: a third party can buy during the test and take the crown or reset the timer. Record it as is.
- Gas values (30 / 50 Tgas) are untested on testnet until S1–S8 run.
- The wallet path (HOT Connect) has not been used with a real wallet yet. S1 is the first real test.
- `owner = treasury = platform = last-armand.testnet`. Treasury and ops withdrawals do not exist in V1 (the funds stay reserved).
