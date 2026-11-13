# $LAST on mainnet — Nearly launch + jackpot contract

**Status:** contract **deployed on NEAR mainnet** as `pot.heavycat9990.near` (2026-11-13). Token not launched yet, reporter bot not started. Every signature below needs explicit human approval.

## Current deployment

| Item | Value |
|---|---|
| Contract account | `pot.heavycat9990.near` (created by `heavycat9990.near`, tx `2fGY11Bf5BNz7X1YViZ5f9toze5D72Rntyd2cYFygjzi`, funded 1.6 + 0.1 NEAR) |
| Deploy + init tx | `EvahQHgSZbYfbmQricYQRgG9hWASvmY1s8wEWxsSx6Lg` (a first attempt `DivJYgkt…` failed with `LackBalanceForState`, nothing deployed) |
| Source commit | `dde02e3` (`feat/mainnet-pot`) |
| WASM | 152,901 bytes, sha256 `5f545e3972507e7d40a3e0836b8bf6bbe12d665d7d4fca2318a7d43b7ff6f8fe`, on-chain code hash `7R8M7jsAcY3AyPEr9FkWNRJLgtDpAEwuZmfkkawzUN8m` (matches) |
| Owner / reporter | `heavycat9990.near` |
| State after init | `IDLE`, round 1, pot 0.1442 NEAR (the extra funding above storage), `token_id` null |
| Storage | 153,321 bytes = 1.5332 NEAR locked |

## Architecture

```text
players ──buy/sell $LAST──▶ Nearly token + Rhea pool (Nearly's contracts)
                                │  pool fees + buy/sell tax, every 5 min, in NEAR
                                ▼
                          last-pot contract  ◀── record_buy(buyer, near_in, tx_hash, ts)
                          (jackpot, timer,        settle_round()        ▲
                           leader, payouts)                             │
                                │ prize = 90% of pot, sent automatically │
                                ▼                                       │
                             winner                     reporter bot (scripts/reporter.py)
                                                        reads finalized blocks (neardata)
```

- The token, its pool and its fee/tax are Nearly's. The $LAST V1 contract (`contracts/last`, testnet) is **not** used on mainnet.
- `contracts/last-pot` holds the fee stream and runs the game: an eligible buy (≥ `min_eligible_buy` NEAR) takes the crown and sets the deadline to `buy time + round_duration`. After `deadline + grace`, anyone (normally the bot) calls `settle_round`, which sends `winner_share_bps` of the available pot to the winner. The remainder stays as the next round's starting pot.
- If the transfer fails, the prize stays `AVAILABLE` and the winner can call `claim_reward(round_id)`.
- Fees arrive in batches (every 5 minutes): fees from the last minutes of a round may land in the next round's pot.

## Trust model (disclose it)

| Role | Can | Cannot |
|---|---|---|
| Reporter (bot key) | choose which buys are recorded (every record carries the tx hash, verifiable on an explorer) | move funds, change config, pick a winner without a matching buy record |
| Owner | replace the reporter (`set_reporter`, 1 yocto) | withdraw the pot, change fees, duration, share, rounds |
| Anyone | `settle_round` after deadline + grace, `unwrap_wnear` | — |
| Account full-access key | **redeploy code** while it exists | — after the key is deleted |

The pot can only leave the contract as a prize. Recommend deleting the pot account's full-access key once the launch is verified, so the code cannot be replaced.

Buy detection: a receipt on the $LAST token logging a NEP-141 `ft_transfer` **to the transaction signer**; NEAR spent = `wrap.near` "Transfer N from <signer>" logs of that transaction (covers Rhea v2, DCL and `aggregatedex.near` routes, NEAR wrapped on the fly). Buys paid with another token are not eligible. Verified on a real Nearly buy: `3iXevKc2…` → `deepeater1.tg`, 3.0 NEAR.

## Parameters (decided 2026-11-13)

| Parameter | Value |
|---|---|
| `round_duration_ns` | `3600000000000` (60 min) |
| `min_eligible_buy` | `500000000000000000000000` (0.5 NEAR) |
| `winner_share_bps` | `9000` (90% to the winner, 10% carried over) |
| `settle_grace_ns` | `120000000000` (2 min for late reports) |
| `reserve_floor` | `20000000000000000000000` (0.02 NEAR: room for the next round records; storage itself is already excluded from the pot) |
| `wrap_id` | `wrap.near` |

## Runbook

Accounts (created and funded **by the team**, keys only in the near-cli legacy keychain, never in the repo):

1. `heavycat9990.near` — main wallet: launches the token on Nearly, creates and funds the pot, is `owner_id` and, for the hackathon, also `reporter_id` (the bot signs with it, on the team's PC).
2. `pot.heavycat9990.near` — the contract. ≈ 1.53 NEAR storage (153 KB) + 0.02 NEAR reserve floor + state → fund **1.6 NEAR**. Its key signs the deploy.

If the bot moves to a server later, create a dedicated reporter account and call `set_reporter` from the owner.

Build (smallest code = smallest storage deposit):

```bash
cd contracts/last-pot && CARGO_TARGET_DIR=~/last-pot-target cargo near build non-reproducible-wasm --no-abi
```

Deploy + init (one transaction, after approval):

```bash
near contract deploy pot.heavycat9990.near use-file ~/last-pot-target/near/last_pot.wasm with-init-call new json-args '{"config":{"owner_id":"heavycat9990.near","reporter_id":"heavycat9990.near","token_id":null,"wrap_id":"wrap.near","round_duration_ns":"3600000000000","min_eligible_buy":"500000000000000000000000","winner_share_bps":9000,"settle_grace_ns":"120000000000","reserve_floor":"20000000000000000000000"}}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send
```

`token_id` starts null: after the Nearly launch the owner records it once with `set_token_id` (1 yocto).

Optional, if fees ever arrive as wNEAR: register the pot on `wrap.near` once (`storage_deposit`, 0.00125 NEAR), then anyone can call `unwrap_wnear`.

Nearly launch settings: **Pool fees go to → Other wallet → `pot.heavycat9990.near`**, **Tax goes to → All to wallet** (100% to the fee wallet).

Start the bot (WSL/Linux):

```bash
python3 scripts/reporter.py --pot pot.heavycat9990.near --token <token id> --reporter heavycat9990.near
```

Use `--dry-run` first to see the detected buys without sending transactions.

Check the pot:

```bash
near contract call-function as-read-only pot.heavycat9990.near get_state json-args '{}' network-config mainnet now
```
