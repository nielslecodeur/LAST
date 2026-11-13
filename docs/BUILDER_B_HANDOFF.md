# Builder B — frontend handoff (checkpoint 2)

> **Update — Gate 3 integrated (2026-11-12, 15:2x):** Builder A deployed LAST to **`last-armand.testnet`** (`docs/DEPLOYMENT.md`, source `ca30bf8`). Merged into `feat/web` (`5ce40a0`, no conflict, no API change). Verified **against the real testnet contract, read-only**:
> - `LAST_LIVE_CONTRACT_ID=last-armand.testnet pnpm exec vitest run src/test/live.integration.test.ts` → **4 passed**: deployed on testnet, views parse, v0.3 solvency covered, Gate 2 exported, `quote_buy(0.03 NEAR)` eligible.
> - The app in live mode (`apps/web/.env.local`, git-ignored) shows **LIVE · Gate 2 LIVE**, round #1 IDLE. Its values match `DEPLOYMENT.md` exactly: spot 0.000003, reserves 3 NEAR / 1,000,000 LAST, integrity 9.998 ≥ 2.3981 + 3, surplus 4.5999.
> - Reload to live data: **714 ms** (capabilities cached by code hash).
> - Fixed: during the deployment probe the UI said "Contract not deployed"; it now says "Connecting to contract…" (test added).
> - Tests: 119 passed, 4 skipped (the live suite; it passes when `LAST_LIVE_CONTRACT_ID` is set, with a 30 s timeout for real RPC). Build OK.
>
> **Still not done:** no transaction signed from the UI and no real wallet connected yet. The next step is the human-run demo in `docs/WEB_DEMO_SCRIPT.md`.


**Date:** 2026-11-12 · **Branch:** `feat/web` (local, not pushed: 4 commits ahead of `origin/feat/web`) · **Interface:** `docs/CONTRACT_API.md` **v0.3**
**Scope:** `apps/web/`, `docs/BUILDER_B_HANDOFF.md`, `docs/WEB_DEMO_SCRIPT.md`, `docs/demo/`. No file of Builder A (`contracts/`, `tests/integration/`, `CONTRACT_API.md`, `CLAUDE.md`) was modified. Nothing was deployed or signed.

## 1. Git

| Commit | What |
|---|---|
| `7d971b1` | Checkpoint 1: frontend on v0.2 (pushed) |
| `e68ef99` | Phase 2: verified confirmations, timer sync, Steal the Crown UI, demo script |
| `98c5380` | Merge `origin/feat/contracts` (`7394a0d`, `bb4bf59` — Gate 2, API v0.3) into `feat/web`. No conflict: the two branches touch disjoint files |
| (next) | Align with v0.3 (`get_integrity.in_flight`), capability cache by code hash, handoff |

The merge (instead of a rebase) keeps the already pushed `feat/web` history intact. `feat/web` now contains Builder A's Gate 2 as is.

## 2. Gate 2: integration status

Checked against the **Rust code** (not only the doc) and against the **compiled WASM**: `cargo build --locked --target wasm32-unknown-unknown --release` (read-only, target dir outside the repo). The frontend's own WASM export parser was then run on that build.

| Method (v0.3) | Contract | Frontend | Status |
|---|---|---|---|
| `withdraw_near_credit()` | `#[payable]`, exactly 1 yocto, → `{amount, success}` | 1 yocto, 50 Tgas, `success:false` = failed payout, confirmed only when `credit_in_flight = 0` and the credit dropped | ✅ integrated (exported by the compiled WASM) |
| `settle_round()` | not payable, `ERR_NO_ACTIVE_ROUND` / `ERR_NOT_EXPIRED`, → `RoundView` | deposit 0, 30 Tgas, offered only when the contract reports `EXPIRED`, confirmed when `last_settled_round_id` reaches the round | ✅ integrated |
| `claim_reward(round_id)` | not payable, `ERR_ALREADY_PAID` / `ERR_CLAIM_IN_FLIGHT` / …, → `{round_id, amount, success}` | deposit 0, 50 Tgas, `round_id` as a U64 string, **confirmed only when `get_round().claim_status = PAID`**. `IN_FLIGHT` → "unresolved", never a success | ✅ integrated |
| `get_round(round_id)` | `Option<RoundView>` | strict parser (`AVAILABLE | IN_FLIGHT | PAID`), last 8 rounds, PAID rounds cached | ✅ integrated |
| `get_account_state().claimable_rounds` | unpaid rounds of the winner (incl. IN_FLIGHT) | "Your prizes". An empty list shows a plain empty state. Ids are still listed if `get_round` were missing | ✅ integrated |
| `get_integrity().in_flight` (new in v0.3) | `balance + in_flight ≥ storage + obligations` | `isSolvent()` uses the v0.3 rule. A v0.2-shaped response (no `in_flight`) is rejected, not read as 0 | ✅ integrated |

Compiled-WASM check (`last.wasm`, 502 117 bytes, non-optimized build, 28 exports): `settle_round`, `claim_reward`, `withdraw_near_credit`, `get_round`, `on_withdraw_complete` and `on_prize_payment_complete` are all present. The UI will switch the Gate 2 actions on as soon as this code is deployed.

**Still unavailable:** nothing in the API. What is missing is the **testnet deployment** (Gate 3), so no Gate 2 action has run against a real chain from the UI yet. The proposed gas values (30 / 50 Tgas) are **not yet validated on testnet**.

**API conflicts found:** none. The v0.3 change (`in_flight`) is additive and is now handled.

## 3. What changed in phase 2 (fixed / added)

**Reliability (P0)**
1. *A success could be announced before it was confirmed on-chain*: claim and withdraw were "confirmed" on the receipt alone. Now every transaction is confirmed only when fresh `final` views show its effect. The check retries 6× at 1.5 s intervals, because views lag the wallet by about 1–2 blocks. If the effect is still not visible, the state ends as **unresolved** ("executed, not yet visible" / "IN_FLIGHT"), never as a success.
2. *Stale responses could overwrite newer state*: polls are now applied in request order.
3. *Refreshing the page mid-transaction left no trace*: an "Interrupted transaction" notice now appears after a reload (sessionStorage, honest about the unknown outcome).
4. *Network guards*: the RPC endpoint must report `chain_id = testnet`, and a mainnet wallet account (`*.near`) cannot transact.
5. *NEAR balance overstated*: the balance shown is now the spendable one (storage-locked part excluded).
6. *Mock wallet blocked by the new guard* (found by the tests): the guard now applies to live mode only.
7. *UI bug*: `scrollIntoView` shifted the hero sideways (the decorative glow overflowed an `overflow-hidden` box). Fixed with `overflow-clip`.

**Timer**
- Clock samples are merged instead of overwritten: a slower poll can no longer make the countdown jump back up. Latency is half-compensated, and a local clock change triggers a resync.
- The views are re-read on focus, tab visibility and network recovery (sleep/resume).
- The phases are unchanged and still enforced: a local 00:00 shows **CLOSING**, and only the contract's `EXPIRED` shows "settlement pending". After expiry the crown card says "Leader at expiry", and the "You won" text appears only once the contract says EXPIRED.

**Finance**
- LAST market fees (4% / 2%, read from `get_market_state`) are shown apart from the **NEAR network gas** (upper bound = attached gas × `gas_price`).
- **Price impact** is computed from real quotes and reserves, with a warning above 5%. On the 3 NEAR pool, 0.03 NEAR gives ≈ 0.95% and 1 NEAR gives > 20%.
- `economics.ts`: every parameter carries its source. Fees, minimum and duration come from the contract. The 70/10/15/5 split is labelled "documented V1" because v0.2/v0.3 do not expose it. **Crown Economy V2 is not implemented and never shown as active.**

**RPC load / speed**
- The deployed WASM (≈ 500 KB raw, ≈ 670 KB base64) used to be downloaded on every page load to detect Gate 2. Capabilities are now cached by `code_hash`, read through the light `view_account` call. A redeploy changes the hash and forces a re-read.
- Storage bounds are read once, integrity and gas price every 5th poll, and PAID rounds are cached.

**UX — "LAST — Steal the Crown"**
- The hero answers the five questions at a glance:
  - who holds the crown (highlighted when it is you);
  - time left (giant chain-synced timer, red in the last 30 s);
  - the jackpot;
  - which buy steals the crown ("Buy ≥ 0.03 NEAR" + **Steal the crown** button that prefills the trade panel);
  - how a win is confirmed (expiry on-chain → settle → claim).
- A **"Crown stolen!"** ribbon appears on a leader change, and a **"Round #N settled on-chain"** victory banner (winner, prize, claim status) after settlement. Both respect reduced motion.
- Toasts and activity describe what really happened: "Eligible buy — you took the crown" vs "Token buy below the minimum — crown and timer unchanged", "sale credit (not paid out yet)", "prize paid".
- `?demo=1` adds a "Claim again" button on a PAID prize, to film the **contract** rejecting a double claim. It never fakes data.

## 4. Test and build results (this session)

```
cd apps/web
pnpm typecheck   → OK, 0 errors
pnpm test        → Test Files 8 passed | 1 skipped (9) · Tests 118 passed | 4 skipped (122)
pnpm build       → OK (index 297 kB / 93 kB gzip, css 33 kB)
```

What is mocked and what is real:
- **Unit / mocked (no network, no wallet):**
  - `amounts`, `marketMath` (parity with the Rust vectors), `countdown`, `phase2`, `transactions`, `rpc` (stubbed `fetch`).
  - `app.test.tsx` and **`flows.test.tsx`**: full user flows on the real React tree, real tx lifecycle and real outcome parsing over the SIMULATED adapter:
    - dust buy keeps the crown;
    - unregistered wallet → `storage_deposit` + `buy` in one transaction, steals the crown;
    - expiry → settle → claim (confirmed only when PAID) → **double claim rejected (`ERR_ALREADY_PAID`)** → round #2;
    - wallet rejection;
    - pending wallet blocks a second transaction;
    - RPC failure → stale banner, no mock fallback;
    - mainnet wallet refused;
    - empty wallet → "Insufficient NEAR".
- **Real, read-only, skipped until deploy:** `src/test/live.integration.test.ts` (4 tests, now including "Gate 2 exported").
- **Real artifact check:** the frontend's WASM export parser run on Builder A's compiled `last.wasm` (see §2).

Manual browser check (`pnpm dev:mock`, SIMULATED, clearly labelled):
- Steal the crown → prefill 0.03 NEAR → quote 9,508.71 LAST, matching Builder A's Rust vector 9,508.x;
- buy → crown, then wait 2 min → CLOSING / EXPIRED, trading blocked;
- settle → victory banner, then claim → PAID, balance +0.0008 NEAR.

Previews of each step: `docs/demo/ui-preview-SIMULATED-*.jpg` (design review only, **not** testnet evidence).

## 5. Dependencies on Builder A

1. **Gate 3 deploy** (with human approval): send the contract id. B sets `VITE_LAST_CONTRACT_ID`, runs `LAST_LIVE_CONTRACT_ID=<id> pnpm --dir apps/web test src/test/live.integration.test.ts`, then the demo script.
2. **Build for deploy with `cargo near build`** (wasm-opt). The raw build is 502 KB. A smaller WASM is cheaper to deploy and faster for the first page load (later loads use the hash cache).
3. **Gas confirmation on testnet:** `buy` 30 Tgas (60 Tgas with `storage_deposit` on the first buy), `settle_round` 30, `claim_reward` / `withdraw_near_credit` 50 (callbacks reserve 10 Tgas). Tell B if real receipts need more.
4. **Optional v0.3+ proposals** (none blocking):
   - `get_economics()` view exposing the fee split, so a future tokenomics (e.g. Crown Economy V2, if validated) is displayed from the chain with no frontend change;
   - `get_rounds(from, limit)`;
   - `ft_metadata.icon`;
   - U64 for `qualifying_buy_count`.
5. **Workspace:** there is still no root `package.json`. Use `pnpm --dir apps/web install`. Decide at the merge checkpoint whether to add a workspace.

## 6. Known limits

- The countdown is still an estimate from `final` block time. It is now monotonic between polls, and the contract alone decides EXPIRED.
- There is no global activity feed (that needs an indexer): only this session's transactions, plus explorer links.
- The wallet path (HOT Connect, testnet) is type-checked and wired, but **not yet exercised with a real wallet**. That requires the deployed contract and a human signer.
- On a public testnet anyone can buy during the demo. The demo script says to show it as is.
