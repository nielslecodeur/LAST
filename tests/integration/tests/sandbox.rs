//! Full LAST scenario against a real NEAR sandbox node (docs/SPEC_V2.md §5, README §9).
//!
//! Build the contract first, then run from WSL/Linux:
//!   cd contracts/last && cargo near build non-reproducible-wasm
//!   LAST_WASM=<path>/last.wasm cargo test --manifest-path tests/integration/Cargo.toml -- --nocapture

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MIN_BUY: u128 = 3 * NEAR / 100;
/// Short round so the test can expire it with `fast_forward`.
const DURATION_NS: u64 = 30_000_000_000;
/// Gas recommended in docs/CONTRACT_API.md for payouts (transfer + callback).
const PAYOUT_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(50);

fn yocto(v: u128) -> NearToken {
    NearToken::from_yoctonear(v)
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().expect("U128 is a JSON string").parse().unwrap()
}

fn assert_fails_with(outcome: &ExecutionFinalResult, code: &str) {
    assert!(outcome.is_failure(), "expected {code}, call succeeded");
    let dbg = format!("{outcome:?}");
    assert!(dbg.contains(code), "expected {code}, got: {dbg}");
}

async fn view(c: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(c.view(method).args_json(args).await?.json()?)
}

async fn game(c: &Contract) -> anyhow::Result<Value> {
    view(c, "get_game_state", json!({})).await
}

async fn buy(user: &Account, c: &Contract, gross: u128) -> anyhow::Result<ExecutionFinalResult> {
    Ok(user
        .call(c.id(), "buy")
        .args_json(json!({ "min_tokens_out": "0" }))
        .deposit(yocto(gross))
        .max_gas()
        .transact()
        .await?)
}

fn load_wasm() -> anyhow::Result<Vec<u8>> {
    let path = std::env::var("LAST_WASM")
        .map_err(|_| anyhow::anyhow!("set LAST_WASM to the output of `cargo near build`"))?;
    Ok(std::fs::read(path)?)
}

/// Account balance once pending gas-refund receipts have landed (a few blocks later).
async fn settled_balance(worker: &Worker<Sandbox>, a: &Account) -> anyhow::Result<u128> {
    worker.fast_forward(5).await?;
    Ok(a.view_account().await?.balance.as_yoctonear())
}

/// Real contract balance must cover storage staking + every named obligation.
async fn assert_solvent(worker: &Worker<Sandbox>, c: &Contract) -> anyhow::Result<()> {
    let i = view(c, "get_integrity", json!({})).await?;
    let details = worker.view_account(c.id()).await?;
    let balance = details.balance.as_yoctonear();
    assert_eq!(u128_of(&i["account_balance"]), balance);
    let storage = u128::from(details.storage_usage) * 10u128.pow(19);
    let owed = u128_of(&i["total_obligations"]);
    assert!(balance + u128_of(&i["in_flight"]) >= owed + storage, "insolvent: {i}");
    Ok(())
}

#[tokio::test]
async fn full_round_on_sandbox() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = load_wasm()?;
    // dev_deploy funds the contract account (~100 NEAR) for storage before `new`.
    let c = worker.dev_deploy(&wasm).await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;

    // ---- init: 3 NEAR seed attached, storage already covered ----
    let init = c
        .call("new")
        .args_json(json!({ "config": {
            "owner_id": carol.id(),
            "treasury_id": carol.id(),
            "platform_id": carol.id(),
            "round_duration_ns": DURATION_NS.to_string(),
            "min_eligible_buy": MIN_BUY.to_string(),
            "seed_near": (3 * NEAR).to_string(),
        }}))
        .deposit(yocto(3 * NEAR))
        .max_gas()
        .transact()
        .await?;
    assert!(init.is_success(), "{init:?}");
    assert_eq!(view(&c, "ft_total_supply", json!({})).await?, json!("1000000000000000000000000"));
    let again = c
        .call("new")
        .args_json(json!({ "config": {
            "owner_id": carol.id(), "treasury_id": carol.id(), "platform_id": carol.id(),
            "round_duration_ns": "1", "min_eligible_buy": "1", "seed_near": "1" }}))
        .deposit(yocto(1))
        .transact()
        .await?;
    assert!(again.is_failure(), "second init must fail");

    // ---- NEP-145 registration ----
    let bounds = view(&c, "storage_balance_bounds", json!({})).await?;
    let min_storage = u128_of(&bounds["min"]);
    for u in [&alice, &bob, &carol] {
        let r = u
            .call(c.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(yocto(min_storage))
            .transact()
            .await?;
        assert!(r.is_success(), "{r:?}");
    }

    // ---- A buys (eligible), B buys (eligible): B leads, timer reset ----
    let ra = buy(&alice, &c, NEAR).await?;
    assert!(ra.is_success(), "{ra:?}");
    let g1 = game(&c).await?;
    assert_eq!(g1["status"], "ACTIVE");
    assert_eq!(g1["leader"], json!(alice.id()));

    let rb = buy(&bob, &c, MIN_BUY).await?;
    assert!(rb.is_success(), "{rb:?}");
    let g2 = game(&c).await?;
    assert_eq!(g2["leader"], json!(bob.id()));
    assert!(u128_of(&g2["deadline_ns"]) > u128_of(&g1["deadline_ns"]));
    assert_eq!(g2["qualifying_buy_count"], 2);

    // ---- A dust-buys: price moves, crown stays with B ----
    let reserve_before = u128_of(&view(&c, "get_market_state", json!({})).await?["near_reserve"]);
    let dust = buy(&alice, &c, MIN_BUY - 1).await?;
    assert!(dust.is_success(), "{dust:?}");
    let dust_out: Value = dust.json()?;
    assert_eq!(dust_out["eligible"], false);
    let g3 = game(&c).await?;
    assert_eq!(g3["leader"], json!(bob.id()));
    assert_eq!(g3["deadline_ns"], g2["deadline_ns"]);
    assert!(u128_of(&view(&c, "get_market_state", json!({})).await?["near_reserve"]) > reserve_before);

    // ---- transfers: no game effect, market cannot receive LAST directly ----
    let to_market = alice
        .call(c.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": c.id(), "amount": "1" }))
        .deposit(yocto(1))
        .transact()
        .await?;
    assert_fails_with(&to_market, "ERR_USE_SELL");

    // ---- A sells half: NEAR credit, leader unchanged; then withdraws ----
    let a_last = u128_of(&view(&c, "ft_balance_of", json!({ "account_id": alice.id() })).await?);
    let sell = alice
        .call(c.id(), "sell")
        .args_json(json!({ "tokens_in": (a_last / 2).to_string(), "min_near_out": "0" }))
        .deposit(yocto(1))
        .max_gas()
        .transact()
        .await?;
    assert!(sell.is_success(), "{sell:?}");
    let payout = u128_of(&sell.json::<Value>()?["payout"]);
    assert_eq!(game(&c).await?["leader"], json!(bob.id()));
    let acc = view(&c, "get_account_state", json!({ "account_id": alice.id() })).await?;
    assert_eq!(u128_of(&acc["credit_available"]), payout);

    let a_near_before = settled_balance(&worker, &alice).await?;
    let wd = alice
        .call(c.id(), "withdraw_near_credit")
        .deposit(yocto(1))
        .gas(PAYOUT_GAS)
        .transact()
        .await?;
    assert!(wd.is_success(), "{wd:?}");
    let wd_out: Value = wd.json()?;
    assert_eq!(wd_out["success"], true);
    assert_eq!(u128_of(&wd_out["amount"]), payout);
    let a_near_after = settled_balance(&worker, &alice).await?;
    println!("payout {payout}, alice balance delta {}", a_near_after as i128 - a_near_before as i128);
    // Received the payout minus gas (50 Tgas prepaid is at most ~0.005 NEAR).
    assert!(a_near_after + NEAR / 100 > a_near_before + payout);
    let acc = view(&c, "get_account_state", json!({ "account_id": alice.id() })).await?;
    assert_eq!((u128_of(&acc["credit_available"]), u128_of(&acc["credit_in_flight"])), (0, 0));
    assert_solvent(&worker, &c).await?;

    // ---- callbacks are private ----
    let fake = alice
        .call(c.id(), "on_withdraw_complete")
        .args_json(json!({ "account_id": alice.id(), "amount": "1" }))
        .transact()
        .await?;
    assert_fails_with(&fake, "private");

    // ---- settle before expiry fails ----
    let early = carol.call(c.id(), "settle_round").max_gas().transact().await?;
    assert_fails_with(&early, "ERR_NOT_EXPIRED");

    // ---- expire (sandbox only) ----
    let mut expired = false;
    for _ in 0..30 {
        worker.fast_forward(20).await?;
        if game(&c).await?["status"] == "EXPIRED" {
            expired = true;
            break;
        }
    }
    assert!(expired, "round did not expire after fast_forward");
    let late = buy(&alice, &c, MIN_BUY).await?;
    assert_fails_with(&late, "ERR_ROUND_EXPIRED");

    // ---- third party settles; second settle rejected ----
    let pot = u128_of(&game(&c).await?["active_pot"]);
    let settle = carol.call(c.id(), "settle_round").max_gas().transact().await?;
    assert!(settle.is_success(), "{settle:?}");
    let round: Value = settle.json()?;
    assert_eq!(round["winner"], json!(bob.id()));
    assert_eq!(u128_of(&round["prize"]), pot);
    let g4 = game(&c).await?;
    assert_eq!(g4["status"], "IDLE");
    assert_eq!(g4["round_id"], "2");
    let twice = carol.call(c.id(), "settle_round").max_gas().transact().await?;
    assert_fails_with(&twice, "ERR_NO_ACTIVE_ROUND");

    // ---- only B can claim, once ----
    let steal = alice
        .call(c.id(), "claim_reward")
        .args_json(json!({ "round_id": "1" }))
        .max_gas()
        .transact()
        .await?;
    assert_fails_with(&steal, "ERR_NOT_WINNER");

    let b_before = settled_balance(&worker, &bob).await?;
    let claim = bob
        .call(c.id(), "claim_reward")
        .args_json(json!({ "round_id": "1" }))
        .gas(PAYOUT_GAS)
        .transact()
        .await?;
    assert!(claim.is_success(), "{claim:?}");
    let claim_out: Value = claim.json()?;
    assert_eq!(claim_out["success"], true);
    assert_eq!(u128_of(&claim_out["amount"]), pot);
    let b_after = settled_balance(&worker, &bob).await?;
    println!("prize {pot}, bob balance delta {}", b_after as i128 - b_before as i128);
    // Received the prize minus gas (50 Tgas prepaid is at most ~0.005 NEAR).
    assert!(b_after > b_before && b_after + NEAR / 100 > b_before + pot);
    let r1 = view(&c, "get_round", json!({ "round_id": "1" })).await?;
    assert_eq!(r1["claim_status"], "PAID");

    let claim2 = bob
        .call(c.id(), "claim_reward")
        .args_json(json!({ "round_id": "1" }))
        .max_gas()
        .transact()
        .await?;
    assert_fails_with(&claim2, "ERR_ALREADY_PAID");

    let fake_claim = bob
        .call(c.id(), "on_prize_payment_complete")
        .args_json(json!({ "round_id": "1" }))
        .transact()
        .await?;
    assert_fails_with(&fake_claim, "private");

    // ---- next round starts from the segregated seed ----
    let seed = u128_of(&g4["next_seed_pot"]);
    let r2 = buy(&alice, &c, MIN_BUY).await?;
    assert!(r2.is_success(), "{r2:?}");
    let g5 = game(&c).await?;
    assert_eq!(g5["round_id"], "2");
    assert_eq!(g5["leader"], json!(alice.id()));
    assert!(u128_of(&g5["active_pot"]) > seed);

    assert_solvent(&worker, &c).await?;
    println!("integrity: {}", view(&c, "get_integrity", json!({})).await?);
    Ok(())
}
