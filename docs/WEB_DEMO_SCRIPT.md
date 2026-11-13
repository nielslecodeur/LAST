# LAST — Web demo script (NEAR Testnet)

**Purpose:** a reproducible end-to-end demo of LAST — Steal the Crown for the NEAR Hackathon 2026 video.
**Network:** NEAR Testnet only. Testnet NEAR has no value.
**Status (2026-11-12):** Gates 1–3 done. The contract is deployed as **`last-armand.testnet`** (`docs/DEPLOYMENT.md`), and Gate 2 is exported and detected by the UI. Read-only checks against it passed. **No step of this script has been run with real wallets yet.**

> Rule: a SIMULATED run (`pnpm dev:mock`) is a rehearsal only. It is never shown or described as a testnet run. Every frame of the final video must show the **NEAR TESTNET** and **LIVE** badges.

---

## 0. Prerequisites

| Item | Who | Detail |
|---|---|---|
| Contract deployed on testnet | Builder A (after human approval) | Demo config: `round_duration_ns = 120000000000` (2 min), `min_eligible_buy = 0.03 NEAR`, `seed_near = 3 NEAR`, plus a storage/gas buffer in the contract account |
| Contract id in the web app | Builder B | `apps/web/.env.local` → `VITE_LAST_CONTRACT_ID=last-armand.testnet` (write it **without BOM**: on Windows PowerShell 5.1 `Set-Content -Encoding utf8` adds one and Vite ignores the variable), then `pnpm --dir apps/web dev` |
| Read-only check | Builder B | `LAST_LIVE_CONTRACT_ID=last-armand.testnet pnpm --dir apps/web test src/test/live.integration.test.ts` must pass before recording (passed on 2026-11-12) |
| Wallet A, Wallet B | presenter | Two distinct testnet accounts in a testnet-capable wallet (HOT Connect lists only wallets that support testnet). Use **two browser profiles** side by side (A left, B right) |
| Explorer | — | https://testnet.nearblocks.io (links are in the app's toasts and activity panel) |

### Testnet NEAR needed

| Wallet | Uses | Fund with |
|---|---|---|
| A | storage registration (read live from `storage_balance_bounds().min`, shown in the trade panel) + 0.05 NEAR eligible buy + 0.01 NEAR dust buy + settle + round-2 buy 0.05 NEAR + gas | **≥ 1 NEAR** |
| B | storage registration + 0.10 NEAR eligible buy + a sell + claim + double-claim attempt + withdraw + gas | **≥ 1 NEAR** |

Gas is a NEAR network fee, separate from LAST's 4% / 2% market fees. The app shows its upper bound per transaction. Unused gas is refunded.

### Timing (2-minute rounds)

Steps 3 → 6 must happen in one live round. Rehearse the timing in SIMULATED mode first. Testnet is public: anyone could buy during the demo. If an unexpected eligible buy lands, the timer resets and the leader changes. Show it as is and never edit it out.

---

## 1. Scenario

Open both browser profiles on the app: `http://localhost:5173/?demo=1`. The `?demo=1` flag only adds the "claim again" button of step 9. It never fakes data.

| # | Who | Action in the UI | What to show | Verify (explorer / views) | Expected result | Needs |
|---|---|---|---|---|---|---|
| 1 | A | Connect wallet → **Steal the crown** (prefills the minimum) → set **0.05** → **Buy LAST & steal the crown**. First buy: one transaction with `storage_deposit` + `buy` | Trade panel: LAST received, 4% LAST market fee, price impact, min received, one-time storage registration, gas bound, "Steals the crown" | Toast/activity → explorer: one tx, two actions `storage_deposit` + `buy`, deposit 0.05 NEAR | Toast "Confirmed on-chain — Eligible buy, you took the crown" (shown only after the views confirm it) | Gate 3 |
| 2 | A | — | Hero: **Crown holder = A** ("That's you"), round #1 LIVE, timer ≈ 02:00, jackpot = 70% of A's fee (+ any seed) | `get_game_state`: `status ACTIVE`, `leader = A`, `qualifying_buy_count = 1` | A leads round #1 | Gate 3 |
| 3 | B | Connect → buy **0.10** NEAR | B's screen: "Steals the crown"; A's screen: red **"Crown stolen!"** ribbon, crown → B | Explorer: B's `buy` tx; `get_game_state.leader = B` | B leads | Gate 3 |
| 4 | — | — | Timer jumps back to ≈ 02:00 on both screens (chain-synced) | `deadline_ns` increased by ~120 s | Timer restarted | Gate 3 |
| 5 | A | Buy **0.01** NEAR (below 0.03) | Trade panel before signing: "Below the minimum — tokens only, no crown"; after: toast "Token buy below the minimum — crown and timer unchanged" | Explorer: `buy` with `eligible: false` in the `EVENT_JSON` log; `leader` still B, `deadline_ns` unchanged, `buy_count` +1, `qualifying_buy_count` unchanged | Crown stays with B | Gate 3 |
| 5b | B (optional) | Sell some LAST | Sell panel: "proceeds become a withdrawable NEAR credit"; Withdraw NEAR card shows the credit | `get_account_state(B).credit_available` > 0; leader unchanged | Credit, not a payout | Gate 3 (withdraw itself: Gate 2) |
| 6 | — | Wait without buying | Last 30 s: timer turns red. At local 00:00 → **CLOSING · confirming on-chain**, then **EXPIRED · settlement pending** once the contract says so. Buy/Sell show "Round over — settle first" | `get_game_state.status = EXPIRED` | Round over; nobody is told they "won" before the contract says EXPIRED | Gate 3 |
| 7 | A (anyone) | **Settle round #1** | Victory banner **"Round #1 settled on-chain"**, winner B, prize | Explorer: `settle_round` tx; `get_round(1)`: `winner = B`, `claim_status = AVAILABLE`; game `IDLE`, `round_id = 2` | Prize reserved for B | **Gate 2** |
| 8 | B | **Claim reward** in "Your prizes" | Toast goes "Executed — verifying contract state…" → "Confirmed on-chain — Prize paid to your wallet" **only once `claim_status = PAID`** | Explorer: `claim_reward` tx + transfer receipt + callback; `get_round(1).claim_status = PAID`; B's NEAR balance up | B paid once | **Gate 2** |
| 9 | B | **Claim round #1 again — the contract must reject it** (`?demo=1`) | Toast "Transaction failed — This prize was already paid (ERR_ALREADY_PAID)" | Explorer: failed `claim_reward` with `ERR_ALREADY_PAID`; B's balance unchanged except gas | Double claim refused by the contract | **Gate 2** |
| 10 | A | Buy 0.05 NEAR | Round #2 LIVE, crown A, jackpot starts from the next-round seed | `round_id = 2`, `status ACTIVE` | New round | Gate 3 |
| (opt.) | B | **Withdraw NEAR** | Credit → IN_FLIGHT → paid; never "paid" before the callback | `credit_available = 0`, `credit_in_flight = 0`, B's NEAR balance up | Sale proceeds withdrawn | **Gate 2** |

### Read-only checks from a terminal (optional, for the README proof)

With near-cli-rs (`near`). Check the syntax against your installed version:

```bash
near contract call-function as-read-only <id>.testnet get_game_state json-args '{}' network-config testnet now
near contract call-function as-read-only <id>.testnet get_round json-args '{"round_id":"1"}' network-config testnet now
near contract call-function as-read-only <id>.testnet get_integrity json-args '{}' network-config testnet now
```

Record every transaction hash (from the activity panel) in the README's testnet checklist.

---

## 2. Video plan (≈ 2–3 min)

| Scene | Length | Screen | Voice-over idea |
|---|---|---|---|
| 1. Hook | 10 s | Hero full screen: timer, jackpot, crown | "Buy LAST. Steal the crown. Last buyer when the clock hits zero wins the jackpot — on NEAR." |
| 2. Rules | 15 s | "Buy ≥ 0.03 NEAR to steal the crown" strip + How it works | Eligibility, timer reset, fees 4% / 2% → 70% jackpot |
| 3. First buy | 25 s | Steps 1–2, wallet popup, toast, explorer tab | "One transaction registers storage and buys. Confirmed from contract state, not optimistically." |
| 4. Steal | 20 s | Steps 3–4 side by side | "Crown stolen — timer reset, all on-chain." |
| 5. Dust | 15 s | Step 5 | "Small buys get tokens, not the crown." |
| 6. Expiry | 20 s | Step 6 (speed up the wait in editing, keep the CLOSING → EXPIRED transition) | "Your browser's zero doesn't decide. The contract does." |
| 7. Settle & claim | 30 s | Steps 7–9 + explorer | "Anyone settles; only the winner claims, once." |
| 8. Proof | 15 s | Market panel "Proof of reserves" + explorer | "Every yoctoNEAR is accounted for." |
| 9. Outro | 10 s | Footer disclaimer + repo | "NEAR Testnet demo, unaudited, no real money." |

Recording tips:
- 1440×900 or larger, browser zoom 90%. Hide bookmarks.
- **Never show seed phrases, private keys or `.env` files.** Wallet popups only.
- Keep the **NEAR TESTNET** and **LIVE** badges in frame.
- Keep motion enabled for the video (the crown and countdown animations respect `prefers-reduced-motion` for users who need it).
- If something fails on testnet, show the real error toast. Do not re-record over a failure to hide it unless you also explain it.

### Captures to take during the real run

Save as `docs/demo/testnet-NN-<step>.png`: `01-first-buy`, `02-a-leads`, `03-crown-stolen`, `05-dust-no-crown`, `06-expired-pending`, `07-settled`, `08-claim-paid`, `09-double-claim-rejected`, `10-round-2`, `11-proof-of-reserves`, plus the explorer page of each transaction.

Existing files `docs/demo/ui-preview-SIMULATED-*.jpg` are **local SIMULATED previews** of the UI, made without any chain. They may be used for design review only, never as testnet evidence.

---

## 3. Rehearsal without a contract (SIMULATED)

```bash
cd apps/web
pnpm dev:mock
# open http://localhost:5173/?gate2=1&bots=0&demo=1
```

`gate2=1` enables the simulated Gate 2 methods. `bots=0` stops the simulated rivals. Every screen shows **SIMULATED**. Use it to rehearse timing and camera moves only.
