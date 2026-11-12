# LAST — NEAR Testnet deployment

**Network:** NEAR Testnet only. No mainnet deployment exists or is planned for the hackathon.

## Current deployment

| Item | Value |
|---|---|
| Contract account | `last-armand.testnet` |
| Deployed + initialized | 2026-11-12, one transaction (`deploy` + `new`) |
| Transaction | [`67jy6P9cPeJ9wNYmP4CzESok3TxWkt7coubbMMZg2Pri`](https://explorer.testnet.near.org/transactions/67jy6P9cPeJ9wNYmP4CzESok3TxWkt7coubbMMZg2Pri) |
| Source commit | `ca30bf8` (`main`, merge of PR #1) |
| Build | `cargo near build non-reproducible-wasm` (cargo-near 0.23.0, Rust 1.99.1, WSL Ubuntu 24.04) |
| WASM sha256 | `7f0f829e9fe9db7a96c554b495cd9a7d671f3ac65eeec75a2e73aec206da17d9` (matches the on-chain code checksum) |
| WASM size | 239,182 bytes (~2.40 NEAR storage staking) |

### Init config (demo)

```json
{
  "owner_id": "last-armand.testnet",
  "treasury_id": "last-armand.testnet",
  "platform_id": "last-armand.testnet",
  "round_duration_ns": "120000000000",
  "min_eligible_buy": "30000000000000000000000",
  "seed_near": "3000000000000000000000000"
}
```

120-second rounds, 0.03 NEAR minimum eligible buy, 3 NEAR market seed attached to `new`.

### State right after init (read from views)

- `get_game_state`: `IDLE`, `round_id` 1, no leader, pots 0.
- `get_market_state`: reserve 3 NEAR / 1,000,000 LAST, fees 400/200 bps.
- `ft_total_supply`: `10^24` (1,000,000 LAST); `ft_metadata`: LAST, 18 decimals.
- `storage_balance_bounds`: 0.00125 NEAR per account registration.
- `quote_buy(0.03 NEAR)`: ~9,508.7 LAST, fee 0.0012 NEAR, eligible.
- `get_integrity`: balance 9.998 NEAR, storage 2.398 NEAR, obligations 3 NEAR, surplus 4.600 NEAR.

## Disclosure: not immutable

`last-armand.testnet` still holds its full-access key, so the owner can redeploy new code. The contract has no admin method that changes leader, deadline, fees, supply or reserves, but a redeploy could. This is kept on purpose to fix bugs during the hackathon; do not describe the deployment as immutable.

## Reproduce

From WSL/Linux with `near-cli-rs` and the account key in the legacy keychain (never commit or paste it):

```bash
cd contracts/last && CARGO_TARGET_DIR=~/last-target cargo near build non-reproducible-wasm
near contract deploy <account>.testnet use-file ~/last-target/near/last.wasm with-init-call new json-args '<config above>' prepaid-gas '100.0 Tgas' attached-deposit '3 NEAR' network-config testnet sign-with-legacy-keychain send
scripts/testnet_views.sh <account>.testnet
```

## Demo transactions

Gate 4 run, 2026-11-12, signer `nifelst.testnet` (one account; distinct-wallet crown change still to record). Full analysis in [`GATE4_REPORT.md`](GATE4_REPORT.md).

| Step | Transaction | Result |
|---|---|---|
| First buy (`storage_deposit` + `buy` 0.05 NEAR), round #1 starts | [`9bw4YNor…`](https://testnet.nearblocks.io/txns/9bw4YNorTnoeby9uQexysaugxVdw6nHa4CTinxS7WJQb) | eligible, leader set |
| Eligible buy 0.10 NEAR, timer reset | [`8e5zh8vZ…`](https://testnet.nearblocks.io/txns/8e5zh8vZXeUyv8MfGpZihJHYeupxHV15yjrSxMg6uf4M) | deadline moved |
| Dust buy 0.01 NEAR | [`4hfVcj8t…`](https://testnet.nearblocks.io/txns/4hfVcj8tfYHqKx2eNjqJydpZpNA91V4pv3i5uEMmGLEE) | not eligible, deadline unchanged |
| Sell 24,000 LAST | [`78KfJ2LT…`](https://testnet.nearblocks.io/txns/78KfJ2LTEhFYxbzDstpmJhWywq4jnr7aoPvXJ2QmME7h) | 0.076052 NEAR credit |
| `settle_round` | [`GD7hwLJg…`](https://testnet.nearblocks.io/txns/GD7hwLJgajWnhraTWcvhYb6ufwXZ2dzk2NExegprSL2R) | round #1 → prize 0.005566 NEAR |
| `claim_reward(1)` | [`2woWEqDT…`](https://testnet.nearblocks.io/txns/2woWEqDTSXQP4172whtkX7uoH1xg4pEZD9PpEYFDBKHK) | IN_FLIGHT → PAID |
| `claim_reward(1)` again | [`4ebNxXCP…`](https://testnet.nearblocks.io/txns/4ebNxXCPkoEzNGAUbxTt7oD2HtDq7Xzj8hrqrH8HT5nz) | rejected `ERR_ALREADY_PAID` |
| `withdraw_near_credit` | [`AFH6hLnf…`](https://testnet.nearblocks.io/txns/AFH6hLnfRyqaisSo5YghtBKu7X2CVA9FPnG7VdyzoDH8) | IN_FLIGHT → PAID |
| Buy 0.05 NEAR, round #2 starts from the seed | [`G6vKPsus…`](https://testnet.nearblocks.io/txns/G6vKPsusZQPX3Ynq6t2PyuoStTkExEqNyEfuv8gjFav3) | seed 0.000795 NEAR |

Reconciliation after the run (`node scripts/gate4.mjs snapshot`): 12/12 invariants PASS; balance 10.127664 NEAR ≥ storage 2.4004 + obligations 3.128381; `in_flight` 0.
