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

To be filled with real transaction links as they happen (README §11): two eligible buys from distinct wallets, dust buy, sell, withdraw, settle, claim, rejected second claim, reconciliation.
