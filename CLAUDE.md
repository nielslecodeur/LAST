# CLAUDE.md — shared rules for coding agents on LAST

Read `README.md` (public promise) and `docs/SPEC_V2.md` (engineering contract) before changing code. The contract interface lives in `docs/CONTRACT_API.md`; contracts and frontend must both follow it, and any change to it is agreed by both developers first.

## Team and branches

- Developer A — `contracts/last`, `tests/integration`, branch `feat/contracts`.
- Developer B — `apps/web`, branch `feat/web`.
- `main` only receives merges at agreed checkpoints. No agent merges into `main`, pushes, deploys or signs a transaction without explicit human approval.
- Do not edit the other developer's area or shared lockfiles without coordinating.

## Hard rules

- **NEAR Testnet only.** Never touch mainnet, never automate real payments.
- **Never** print, paste or commit private keys, seed phrases, `.env` secrets or `~/.near-credentials`.
- Money is integers: yoctoNEAR / atomic LAST as `u128` in Rust (wide `U256` intermediates for products), decimal strings in JSON, `bigint` in TypeScript. No floats, no JS `Number` for amounts.
- Contract state is the only source of truth for winner, pots and balances. The UI never decides a winner and never shows simulated data on a public testnet dashboard (mocks must be labelled SIMULATED and stay local).
- Every fee unit is conserved; integer-division remainders go to the treasury bucket.
- No admin method may change leader, deadline, fees, supply or reserves.
- Do not report tests as passing, or a deployment as live, unless the command actually ran and succeeded in this session. Checkpoint reports include `git status`, commit hash, command and result.

## Commands (contracts)

```bash
cargo test --manifest-path contracts/last/Cargo.toml
cd contracts/last && cargo near build non-reproducible-wasm
```

Sandbox tests (`near-workspaces`) may need Linux/WSL.

## Out of scope for V2

Token burns, staking, dividends, referrals, buybacks, AI agents, NFTs, bridges, external DEX integration.
