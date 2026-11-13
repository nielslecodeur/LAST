# Crown Economy V2: implementation notes (branch `feat/crown-economy`)

**Status (2026-11-13):** implemented and unit-tested. **Not deployed.** The hackathon submission stays on V1 (`last-armand.testnet`, CONTRACT_API v0.3), as the council review recommended (`README.md`, "Current status, roadmap and disclosures").
**Scope chosen:** the 85/10/5 split plus a platform-only withdrawal of the 5% share. The capped carry-over release (proposal §4) and the dynamic minimum buy (§5) are **not** implemented. The council rejected or split on them, and V1's unconditional "starting pot" is kept.

## What changed

| | V1 (deployed, v0.3) | V2 (this branch, v0.4) |
|---|---|---|
| Current jackpot | 70% of each fee | **85%** |
| Next-round starting pot | 10% (80% while IDLE) | 10% (95% while IDLE) |
| Treasury | 15%, locked forever | **0%**: receives only the rounding remainder (≤ 2 yoctoNEAR per fee) |
| Platform | 5%, locked forever | 5%, **withdrawable by `platform_id` only** (`withdraw_platform_fees`) |
| Fee split readable on-chain | no | **`get_economics()`** |

Files: `contracts/last/src/accounting.rs` (constants, `ECONOMICS_MODEL`), `payouts.rs` (`withdraw_platform_fees`, `on_platform_withdraw_complete`), `events.rs` (`platform_withdraw`), `lib.rs` (`get_economics`, `EconomicsView`), `tests/crown.rs` (12 tests). API: `docs/CONTRACT_API.md` v0.4. Source proposal: `docs/LAST_Crown_Economy_Tokenomics_V2.md`.

### Platform withdrawal design

- Only `platform_id` can withdraw, with exactly 1 yocto attached (forces a full-access-key signature). It can reach `ops_reserve` and nothing else: market reserve, pots, credits and prizes are untouched (tested).
- The amount is subtracted from `ops_reserve` **before** the transfer promise:
  - a second request can only take what is left, so there is no double withdrawal (tested);
  - during the flight, balance and obligations drop by the same amount, so solvency stays exact, with no use of `in_flight`.
- The private callback restores the amount on a failed transfer and never panics (tested), so the share can be withdrawn again.
- `#[private]` is enforced by the WASM entry point. Only this contract's own promise can call the callback, so a failure cannot be restored twice by a third party.
- **No state-layout change:** `Ledger` and the contract struct are unchanged (constants and methods only).

## Verification run in this session

| Check | Result |
|---|---|
| `cargo test --manifest-path contracts/last/Cargo.toml` (WSL) | **75 passed**, 0 failed (63 existing, 4 updated for the new split, plus 12 new) |
| `cargo near build non-reproducible-wasm` (WSL, cargo-near 0.22.0) | OK: `last.wasm` 246,129 bytes, sha256 `cb5ca5dd0e43aa8089c92b5b4542cde4c80f57c632fbede150022d95bc5fa325` |
| WASM exports, checked with the frontend parser | `buy`, `sell`, `settle_round`, `claim_reward`, `withdraw_near_credit`, `get_round`, `get_economics`, `withdraw_platform_fees`, `on_platform_withdraw_complete` present |
| Sandbox tests (`tests/integration`, near-workspaces) | **NOT RUN.** The build needs `pkg-config` + `libssl-dev` in WSL (`sudo apt install -y pkg-config libssl-dev`) |
| Testnet | **Not deployed** |

## Before any deployment (team decision)

1. Run the sandbox tests, and add a sandbox scenario for `withdraw_platform_fees` that checks "callback only from self" and a real transfer to `platform_id`.
2. **Do not upgrade `last-armand.testnet` in place during the hackathon.** The state layout is compatible, so a code-only redeploy would technically work. But it changes the fee rules of any live round (SPEC invariant "no retroactive rule change"), and every Gate 4 proof refers to the V1 code hash (`7f0f829e…`).
3. Preferred path: deploy to a **fresh account** (e.g. `last-crown.testnet`) with its own seed. Then re-run Gate 4 (`docs/GATE4_REPORT.md`, `scripts/gate4.mjs`) on it.
4. Frontend: read `get_economics()` when the WASM exports it (the capability detection already exists), never hard-code 85/10/5. Add a "Withdraw platform fees" action visible only to `platform_id`.
5. Disclosure update: with V2, nothing is locked forever except rounding dust. While a full-access key exists, the contract is still **not immutable**.
