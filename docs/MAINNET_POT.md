# $LAST on NEAR mainnet — architecture, trust model and runbook

**Status (2026-11-14):** live. Token `last-2.nearlytrade.near` launched on Nearly with its fees routed to the jackpot contract `pot.heavycat9990.near`; the reporter bot runs on GitHub Actions ([armand418/last-reporter](https://github.com/armand418/last-reporter)), records crown buys and settles rounds; round 1 was settled and paid automatically; the website https://last-jackpot.vercel.app reads the contract. Every signature or deploy needs explicit human approval.

## Deployment record

| Item | Value |
|---|---|
| Token | `last-2.nearlytrade.near` ("Last", symbol LAST, 18 decimals, 1,000,000,000 supply), launched by `heavycat9990.near`, tx `DXhHMngBAQd4xssXjW3zHacZruM4PniGjPuig3qSsCqp` |
| Nearly launch config | id 3785, `fee_to` = `pot.heavycat9990.near`, buy tax 1%, sell tax 1%, creator share 100% (burn 0%, holders 0%), Nearly platform share as set by Nearly |
| Pool | Rhea DCL `last-2.nearlytrade.near\|wrap.near\|10000`, LP position held by Nearly's locker `lock_8.nearlytrade.near` |
| Jackpot contract | `pot.heavycat9990.near`, created by `heavycat9990.near` (tx `2fGY11Bf5BNz7X1YViZ5f9toze5D72Rntyd2cYFygjzi`, funded 1.6 + 0.1 NEAR) |
| Deploy + init | tx `EvahQHgSZbYfbmQricYQRgG9hWASvmY1s8wEWxsSx6Lg` |
| WASM | 152,901 bytes, sha256 `5f545e3972507e7d40a3e0836b8bf6bbe12d665d7d4fca2318a7d43b7ff6f8fe`, on-chain code hash `7R8M7jsAcY3AyPEr9FkWNRJLgtDpAEwuZmfkkawzUN8m` (matches) |
| Token id recorded | `set_token_id`, tx `9VDknpyursvPvVSTW2qMas7jRzeEUyV4DZbwYWah3gCU` |
| Owner / reporter | `heavycat9990.near` |
| Storage | 153,321 bytes = 1.5332 NEAR locked |
| First crown buy | `wrapz-z.near`, 10 NEAR, buy tx `5H7PAmLCiejUemSs7694JBE7FBGgdenNhsVSrQWUWzcx`, recorded by tx `6AvsPPGyn2SUH2gwmzkECrf2bctEJtZtW2i7GrYhGbcq` |
| Round 1 payout | `settle_round` tx `7PN8F3LGzPgGaP5QyF3xNiH1FQmsvptxGQpydwVRy9xk`: 0.176316811750498314636662 NEAR paid to `wrapz-z.near`, round status `PAID` |
| Reporter key (GitHub Actions) | function-call access key `ed25519:JXDdJfQXC1m93F3p8m5tTF7exTekuLDTxgVK9uvEraJ` on `heavycat9990.near`, receiver `pot.heavycat9990.near`, methods `record_buy` and `settle_round`, gas allowance 1 NEAR (added by tx `D3yy5FHeJRn1nzvxMqUZcnats48k2dhQynPzXQauCaYD`) |

## Architecture

```text
players ──buy/sell $LAST──▶ Nearly token + Rhea DCL pool (Nearly's contracts)
                                │  creator fees + 1% buy/sell tax, every ~5 min
                                ▼
                          pot.heavycat9990.near ◀── record_buy(buyer, near_in, tx_hash, ts)
                          (jackpot, timer,           settle_round()            ▲
                           crown, payouts)                                     │
                                │ prize = 90% of pot, sent automatically        │
                                ▼                                              │
                             winner                  reporter bot (scripts/reporter.py)
                                                     lists the token's txs (FastNEAR tx API)
```

- An eligible buy (≥ `min_eligible_buy` NEAR) takes the crown and sets the deadline to `buy time + round_duration`. After `deadline + grace`, anyone (normally the bot) calls `settle_round`, which sends `winner_share_bps` of the available pot to the winner. The rest stays as the next round's seed.
- If the transfer fails, the prize stays `AVAILABLE` and the winner can call `claim_reward(round_id)`.
- Available pot = account balance − storage staking − reserve floor − prizes still owed. NEAR sent by a pending transfer is tracked as `in_flight`.
- Fees arrive in batches: fees from the last minutes of a round may land in the next round's pot.

## Trust model

| Role | Can | Cannot |
|---|---|---|
| Reporter (bot key) | choose which buys are recorded (each record carries the tx hash, verifiable on an explorer) | move funds, change config, pick a winner without a matching buy record, extend an expired round, report future or out-of-order buys |
| Owner | replace the reporter (`set_reporter`), set the token id once (`set_token_id`) | withdraw the pot, change duration, minimum, share or rounds |
| Anyone | `settle_round` after deadline + grace, `unwrap_wnear` | — |
| Account full-access key | redeploy code while it exists | — after the key is deleted |

The pot can only leave the contract as a prize. Deleting the pot account's full-access key would make the code immutable.

## Reporter

- Lists the token's transactions with the FastNEAR transactions API (`POST tx.main.fastnear.com/v0/account`), one request every 10 s, pages back if needed, and fetches their receipts in batches (`/v0/transactions`).
- Buy = a receipt on the token logging a NEP-141 `ft_transfer` to the transaction signer. NEAR spent = `wrap.near` "Transfer N from <signer>" logs in the same transaction (Rhea DCL, Rhea v2, aggregators, NEAR wrapped on the fly). Buys paid with another token are not eligible.
- Processes transactions in chain order and saves a cursor after each one (`--state`, default `~/.last-reporter.json`), so it resumes after a restart. A buy made after the current deadline stops the scan without moving the cursor; the bot settles the expired round, then replays that buy, which starts the next round. Nothing is kept only in memory.
- Settles a round only after recording every earlier buy, so a buy made in time but reported late is never lost.
- Contract views go through public RPCs with fallback (`near.drpc.org`, `rpc.ankr.com/near`, FastNEAR archival, FastNEAR free); calls are signed with near-cli and the legacy keychain. Logs an "alive" line every 5 minutes.

Run (WSL/Linux):

```bash
python3 scripts/reporter.py --pot pot.heavycat9990.near --token last-2.nearlytrade.near --reporter heavycat9990.near
```

`--from-height H` starts from block H on the first run; `--dry-run` signs nothing; `--max-runtime N` exits cleanly after N seconds.

### Hosting (GitHub Actions)

The live bot runs in [armand418/last-reporter](https://github.com/armand418/last-reporter) (same `reporter.py`):

- `.github/workflows/reporter.yml` starts every 6 hours (`cron: 0 */6 * * *`) and on demand; each run lasts ~5 h 45 min (`--max-runtime 20700`), then commits `state/cursor.json`. A concurrency group keeps a single bot running; queued runs start when the previous one ends.
- The key comes from the repository secrets `REPORTER_PRIVATE_KEY` / `REPORTER_PUBLIC_KEY`, is written to the legacy keychain for the run and deleted at the end. Dry runs never commit the cursor.
- To stop: Actions → *$LAST reporter* → *Disable workflow*, then cancel the running run. Best done while the round is `IDLE`; otherwise anyone can still call `settle_round` after the deadline. After the event, delete the function-call key from `heavycat9990.near`.

## Parameters

| Parameter | Value |
|---|---|
| `round_duration_ns` | `3600000000000` (60 min) |
| `min_eligible_buy` | `500000000000000000000000` (0.5 NEAR) |
| `winner_share_bps` | `9000` (90% to the winner, 10% carried over) |
| `settle_grace_ns` | `120000000000` (2 min for late reports) |
| `reserve_floor` | `20000000000000000000000` (0.02 NEAR for the next round records) |
| `wrap_id` | `wrap.near` |

## Rebuild and redeploy

```bash
cd contracts/last-pot && cargo near build non-reproducible-wasm --no-abi
near contract deploy pot.heavycat9990.near use-file <path>/last_pot.wasm with-init-call new json-args '{"config":{"owner_id":"heavycat9990.near","reporter_id":"heavycat9990.near","token_id":null,"wrap_id":"wrap.near","round_duration_ns":"3600000000000","min_eligible_buy":"500000000000000000000000","winner_share_bps":9000,"settle_grace_ns":"120000000000","reserve_floor":"20000000000000000000000"}}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send
```

The account must hold the storage deposit plus the prepaid gas at deploy time (a first attempt with 100 Tgas failed by 0.044 NEAR).
