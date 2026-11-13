# CLAUDE.md — rules for coding agents on $LAST

Read `README.md` first, then `docs/MAINNET_POT.md`. $LAST runs on **NEAR mainnet**: the token `last-2.nearlytrade.near` (Nearly launchpad), the jackpot contract `pot.heavycat9990.near` (`contracts/last-pot`), the reporter bot (`scripts/reporter.py`) and the website (`apps/web`, deployed at https://last-jackpot.vercel.app).

## Hard rules

- **Real money is involved.** Every deploy, contract call, signature, bot start or site publish needs explicit human approval in the moment. Never move or spend team funds on your own.
- **Never** print, paste or commit private keys, seed phrases, `.env` files or `~/.near-credentials`.
- Money is integers: yoctoNEAR as `u128` in Rust, decimal strings in JSON, `bigint` in TypeScript. No floats, no JS `Number` for amounts.
- Contract state is the only source of truth for the crown holder, the jackpot and payouts. The website only displays contract views.
- Do not report tests as passing, or a deployment as live, unless the command actually ran and succeeded in this session.
- `main` only receives changes through reviewed pull requests.

## Commands

Contract (Linux/WSL; on Windows `near-sdk`'s `unit-testing` feature needs NASM + CMake, so run from WSL with the target dir outside OneDrive):

```bash
cargo test --manifest-path contracts/last-pot/Cargo.toml
cd contracts/last-pot && cargo near build non-reproducible-wasm --no-abi
```

Plain `cargo check` fails by design in near-sdk 5.x; use `cargo check --target wasm32-unknown-unknown`. `#[private]` is enforced only in the WASM entry point, not in unit tests.

Website:

```bash
pnpm --dir apps/web test
pnpm --dir apps/web build
```

Reporter (WSL; the reporter key lives in the near-cli legacy keychain):

```bash
python3 scripts/reporter.py --pot pot.heavycat9990.near --token last-2.nearlytrade.near --reporter heavycat9990.near --dry-run
```

Public RPCs rate-limit (429): the bot rotates endpoints in `RPCS`; check them with a `get_state` call before changing the list.
