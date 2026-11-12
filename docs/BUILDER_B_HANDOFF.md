# Builder B — frontend handoff (checkpoint 1)

**Date:** 2026-11-12 · **Branch:** `feat/web`, based on `origin/feat/contracts` @ `604684a` (Gate 1) · **Interface:** `docs/CONTRACT_API.md` v0.2
**Scope:** `apps/web` and this file only. No file in `contracts/`, `tests/integration/` or `docs/CONTRACT_API.md` was modified. Nothing was pushed, deployed or signed.

## 1. Status at a glance

| Area | Status |
|---|---|
| Frontend runs locally (`pnpm dev`, `pnpm dev:mock`) | ✅ operational |
| Production build (`pnpm build`) | ✅ passes; the SIMULATED adapter is excluded from the bundle |
| Typecheck (`pnpm typecheck`) | ✅ passes |
| Unit / mocked tests (`pnpm test`) | ✅ 78 passed, 3 skipped (the live integration suite, see §4) |
| Read layer for every v0.2 view | ✅ implemented. Checked against **real NEAR Testnet RPC** in the browser (see §4) but not yet against the LAST contract, which is not deployed |
| Transaction layer (buy / sell / storage) | ✅ built to the v0.2 signatures; **never signed** (no deployed contract, and signing is out of an agent's scope) |
| Gate 2 actions (settle / claim / withdraw / round history) | ⏳ UI and builders ready. Disabled until the deployed WASM exports the methods |
| Wallet (HOT Connect, testnet) | ⚠️ integrated and type-checked; **not exercised with a real wallet yet** (needs a deployed contract + a human signer) |
| Live dashboard | ⏳ waiting for the Gate 3 deploy (`VITE_LAST_CONTRACT_ID`) |

## 2. What is operational now

- Dashboard: hero (jackpot, chain-synced countdown, leader, round, status, min to lead, next seed), trade panel (buy / sell, quotes, 4% / 2% fees from the contract, slippage, storage notice, eligibility indicator), rounds & rewards, withdraw NEAR, market + proof-of-reserves (`get_integrity`), session activity with explorer links, how-it-works, risk footer. Dark, responsive, `prefers-reduced-motion`, screen-reader announcements on crown changes.
- **States honoured**: `CONTRACT NOT DEPLOYED` (no id / unknown account / no code), `CHECKING…`, `LIVE`, `RPC error — stale`, `SIMULATED`, testnet-only refusal of `.near` ids.
- **Gate 2 detection without guessing**: the app reads the export section of the deployed WASM (`view_code`). With today's Gate 1 code it shows "Gate 2 pending" and disables settle / claim / withdraw. Once Builder A deploys Gate 2, they switch on with no frontend change.

## 3. Waiting on Builder A (Gate 2) and on the deploy (Gate 3)

| Dependency | Frontend use | Ready on our side |
|---|---|---|
| `withdraw_near_credit()` 1 yocto, 50 Tgas → `{amount, success}` | Withdraw NEAR button | builder + outcome check (`success:false` = failure) |
| `settle_round()` no deposit, 30 Tgas → `RoundView` | Settle button, shown only when the contract says `EXPIRED` | builder; result not parsed, the views are re-read |
| `claim_reward(round_id)` no deposit, 50 Tgas → `{round_id, amount, success}` | Claim button per prize | builder + outcome check |
| `get_round(round_id)` → `RoundView \| null` | last winner, round history (last 8), claim status | parser (strict `AVAILABLE \| IN_FLIGHT \| PAID`) |
| `get_account_state().claimable_rounds` (currently always `[]`) | "Your prizes" list | used as-is |
| Testnet contract id | `VITE_LAST_CONTRACT_ID` in `apps/web/.env.local` | config + testnet guard |

## 4. Commands run in this session (results)

```
cd apps/web
pnpm install                 → OK (pnpm 10.34.9, Node 24.12.0)
pnpm typecheck               → OK, 0 errors
pnpm test                    → 6 files passed, 1 skipped · 78 tests passed, 3 skipped
pnpm build                   → OK (index 283 kB / 88.8 kB gzip, css 31 kB)
```

Manual checks in Chrome:
- `pnpm dev:mock` (SIMULATED): connect, then a first buy (one transaction with `storage_deposit` + `buy`), a crown change with "That's you", the jackpot / seed split, the toast, and the session activity. All rendered correctly.
- **Real NEAR Testnet RPC, read-only**, with `VITE_LAST_CONTRACT_ID=wrap.testnet`, a real contract that is *not* LAST:
  - the deployment probe downloaded and parsed the real WASM: badge LIVE, "Gate 2 pending";
  - the LAST views failed with `MethodNotFound`, shown as an explicit RPC error banner;
  - no data was invented and nothing fell back to mocks.

   This confirms the browser→RPC path, including CORS, `view_code` and WASM parsing. It does **not** prove LAST integration: that waits for the deploy, then run `LAST_LIVE_CONTRACT_ID=… pnpm test src/test/live.integration.test.ts`.

Which tests are mocked and which are real:
- All of `pnpm test` is unit or mocked (stubbed `fetch`, SIMULATED adapter, jsdom).
- `src/test/live.integration.test.ts` is the only real-network suite. It is read-only and skipped until a contract id is given.

## 5. API review — notes and proposals for Builder A (nothing changed unilaterally)

I checked v0.2 against the Rust code on `feat/contracts` and found **no mismatch for Gate 1**: field names, U64/U128 strings, the `u32` `qualifying_buy_count`, deposits and error codes all agree. Proposals:

1. **Payout callback shape (Gate 2):** please keep the final return values as documented: `{ "amount", "success" }` for withdraw and `{ "round_id", "amount", "success" }` for claim. The UI treats `success: false` as a failed payout (balance restored to AVAILABLE), and a receipt `Failure` as a failure too. If the callback panics instead, tell me and I will adapt.
2. **Type consistency (cosmetic):** `qualifying_buy_count` is a JSON number (`u32`) while `buy_count` / `sell_count` are U64 strings. It works and is parsed as documented. Consider U64 everywhere for v0.3, or leave it as is.
3. **`buy` return when IDLE and not eligible:** `round_id` is the *next* round id (not null), while the `buy` event has `round_id: null`. This is consistent with the docs, but please mention it explicitly in §2 to avoid confusion.
4. **Optional, v0.3:** `get_rounds(from_id, limit)` would replace the up to 8 `get_round` calls the UI makes per refresh. Not needed for the demo.
5. **Optional:** `ft_metadata.icon` is `None`. A small data-URL icon makes LAST show properly in wallets.
6. **Gas:** the first buy sends `storage_deposit` (30 Tgas) + `buy` (30 Tgas) in one transaction. Please confirm 30 Tgas stays enough for `buy` once Gate 2 adds code paths.
7. **Repo workflow:** there is no root `package.json` / pnpm workspace. The README's `pnpm install` at the root therefore does not install the web app; use `pnpm --dir apps/web install`. I did not touch the root README (shared file). Let's agree on whether to add a workspace file at the merge checkpoint.

## 6. Git synchronisation with `feat/contracts`

- `feat/web` was created from `origin/feat/contracts` and its upstream was **unset**, so a plain `git push` can never write to Builder A's branch. Push needs an explicit `git push -u origin feat/web`, after human approval.
- When Builder A pushes Gate 2: `git fetch origin`, then `git rebase origin/feat/contracts` (or `git merge origin/feat/contracts`). Our changes live only in `apps/web/` and `docs/BUILDER_B_HANDOFF.md`, so no conflict is expected. After syncing, diff `docs/CONTRACT_API.md` (v0.2 → v0.3) and re-run `pnpm test` + `pnpm build`.
- Local git identity was set **for this repo only** (the global one was a placeholder).

## 7. Dependencies (exact versions, `apps/web/pnpm-lock.yaml`)

Runtime: `react` / `react-dom` 19.3.1, `@hot-labs/near-connect` 0.12.0 (zero dependencies).
Dev: `vite` 8.2.6, `@vitejs/plugin-react` 6.2.1, `tailwindcss` + `@tailwindcss/vite` 4.3.5, `typescript` 6.0.3, `vitest` 5.0.5, `jsdom` 30.1.3, `@testing-library/react` 16.3.3.
Not used, on purpose: `near-api-js` (three RPC calls do not justify it; a minimal `fetch` client is easier to test) and charting libraries (no indexer data to chart).

## 8. Known limits

- The countdown is an estimate from the latest *final* block time, so it can lag by about 1–3 s. That is why the UI shows CLOSING and only the contract decides EXPIRED.
- There is no global activity feed. One needs an indexer, which is out of MVP scope, so the UI shows only this session's transactions and links to the explorer.
- The UI polls every 3 s and pauses while the tab is hidden. That load is fine for a demo on the public RPC; configure `VITE_NEAR_RPC_URLS` if it gets rate-limited.
