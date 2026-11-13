//! Crown Economy V2: 85/10/0/5 fee split and the platform-only withdrawal of the 5% share.

use super::*;
use near_sdk::{env, PromiseResult};

fn platform() -> AccountId {
    acc("ops.testnet") // `platform_id` in `config()`
}

fn ctx_callback(now: u64, result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(contract_id())
            .signer_account_id(contract_id())
            .account_balance(NearToken::from_yoctonear(BALANCE))
            .block_timestamp(now)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

/// A round with real fees, so the platform share is non-zero.
fn with_fees() -> LastContract {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    buy(&mut c, &bob(), MIN_BUY, T0 + 1);
    c
}

// ---- split -----------------------------------------------------------------------------------

#[test]
fn eligible_buy_funds_85_percent_jackpot() {
    let mut c = setup();
    let r = buy(&mut c, &alice(), NEAR, T0);
    let fee = r.fee.0; // 0.04 NEAR
    assert_eq!(c.ledger.active_pot, fee * 85 / 100);
    assert_eq!(c.ledger.next_seed_pot, fee * 10 / 100);
    assert_eq!(c.ledger.ops_reserve, fee * 5 / 100);
    assert_eq!(c.ledger.treasury_reserve, 0); // only rounding dust can ever land here
}

#[test]
fn economics_view_exposes_the_split() {
    let c = setup();
    let e = c.get_economics();
    assert_eq!(e.model, "crown-economy-v2");
    assert_eq!((e.buy_fee_bps, e.sell_fee_bps), (400, 200));
    assert_eq!((e.jackpot_bps, e.next_seed_bps, e.treasury_bps, e.platform_bps), (8500, 1000, 0, 500));
    let sum = u32::from(e.jackpot_bps) + u32::from(e.next_seed_bps) + u32::from(e.treasury_bps) + u32::from(e.platform_bps);
    assert_eq!(sum, 10_000);
    assert_eq!(e.remainder_to, "treasury");
    assert!(e.platform_withdrawable);
}

// ---- withdraw_platform_fees ------------------------------------------------------------------

#[test]
fn platform_withdraws_its_share_and_nothing_else() {
    let mut c = with_fees();
    let ops = c.ledger.ops_reserve;
    assert!(ops > 0);
    let before = c.ledger.clone();
    let obligations = c.ledger.total_obligations();

    ctx(&platform(), 1, T0 + 2);
    let _ = c.withdraw_platform_fees(None);
    // The share left `ops_reserve` and the balance together: solvency stays exact in flight.
    assert_eq!(c.ledger.ops_reserve, 0);
    assert_eq!(c.ledger.total_obligations(), obligations - ops);
    assert_eq!(env::account_balance().as_yoctonear(), BALANCE + 1 - ops);
    // Every other bucket is untouched.
    assert_eq!(c.ledger.market_near_reserve, before.market_near_reserve);
    assert_eq!(c.ledger.active_pot, before.active_pot);
    assert_eq!(c.ledger.next_seed_pot, before.next_seed_pot);
    assert_eq!(c.ledger.treasury_reserve, before.treasury_reserve);
    assert_eq!(c.ledger.credits_outstanding, before.credits_outstanding);
    assert_eq!(c.ledger.prizes_outstanding, before.prizes_outstanding);
    assert_eq!(c.ledger.in_flight, 0);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"platform_withdraw\"") && l.contains("IN_FLIGHT")));

    ctx_callback(T0 + 3, ok());
    let r = c.on_platform_withdraw_complete(U128(ops));
    assert!(r.success);
    assert_eq!(r.amount.0, ops);
    assert_eq!(c.ledger.ops_reserve, 0);
    // The game is unaffected.
    assert_eq!(c.get_game_state().leader, Some(bob()));
}

#[test]
fn partial_withdrawal_then_the_rest() {
    let mut c = with_fees();
    let ops = c.ledger.ops_reserve;
    ctx(&platform(), 1, T0 + 2);
    let _ = c.withdraw_platform_fees(Some(U128(ops / 3)));
    assert_eq!(c.ledger.ops_reserve, ops - ops / 3);
    ctx(&platform(), 1, T0 + 3);
    let _ = c.withdraw_platform_fees(None);
    assert_eq!(c.ledger.ops_reserve, 0);
}

#[test]
fn failed_platform_transfer_restores_the_share() {
    let mut c = with_fees();
    let ops = c.ledger.ops_reserve;
    ctx(&platform(), 1, T0 + 2);
    let _ = c.withdraw_platform_fees(None);
    ctx_callback(T0 + 3, PromiseResult::Failed);
    let r = c.on_platform_withdraw_complete(U128(ops));
    assert!(!r.success);
    assert_eq!(c.ledger.ops_reserve, ops);
    assert!(get_logs().iter().any(|l| l.contains("\"status\":\"FAILED\"")));
    // It can be retried.
    ctx(&platform(), 1, T0 + 4);
    let _ = c.withdraw_platform_fees(None);
    assert_eq!(c.ledger.ops_reserve, 0);
}

#[test]
#[should_panic(expected = "ERR_FORBIDDEN")]
fn owner_cannot_withdraw_platform_fees() {
    let mut c = with_fees();
    ctx(&acc("owner.testnet"), 1, T0 + 2);
    let _ = c.withdraw_platform_fees(None);
}

#[test]
#[should_panic(expected = "ERR_FORBIDDEN")]
fn a_player_cannot_withdraw_platform_fees() {
    let mut c = with_fees();
    ctx(&alice(), 1, T0 + 2);
    let _ = c.withdraw_platform_fees(None);
}

#[test]
#[should_panic(expected = "ERR_ONE_YOCTO")]
fn platform_withdraw_requires_one_yocto() {
    let mut c = with_fees();
    ctx(&platform(), 0, T0 + 2);
    let _ = c.withdraw_platform_fees(None);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_PLATFORM_FEES")]
fn cannot_withdraw_more_than_the_share() {
    let mut c = with_fees();
    let ops = c.ledger.ops_reserve;
    ctx(&platform(), 1, T0 + 2);
    let _ = c.withdraw_platform_fees(Some(U128(ops + 1)));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_PLATFORM_FEES")]
fn no_double_withdrawal_while_in_flight() {
    let mut c = with_fees();
    ctx(&platform(), 1, T0 + 2);
    let _ = c.withdraw_platform_fees(None);
    ctx(&platform(), 1, T0 + 3);
    let _ = c.withdraw_platform_fees(Some(U128(1)));
}

#[test]
#[should_panic(expected = "ERR_ZERO_AMOUNT")]
fn nothing_to_withdraw_before_any_fee() {
    let mut c = setup();
    ctx(&platform(), 1, T0);
    let _ = c.withdraw_platform_fees(None);
}

#[test]
fn full_cycle_conservation_with_platform_withdrawal() {
    // buys, sell, settle, claim, credit withdraw, platform withdraw: every yocto in is in a bucket
    // or paid out, and the winner gets floor(85%) of each of the round's fees.
    let mut c = setup();
    let mut gross_in = 0u128;
    let mut round_fees = Vec::new();
    for (who, g, t) in [(alice(), NEAR, T0), (bob(), MIN_BUY, T0 + 1)] {
        round_fees.push(buy(&mut c, &who, g, t).fee.0);
        gross_in += g;
    }
    let t = bal(&c, &alice()) / 3;
    let s = sell(&mut c, &alice(), t, T0 + 2);
    round_fees.push(s.fee.0);

    ctx(&carol(), 0, T0 + 1 + DURATION);
    let prize = c.settle_round().prize.0;
    let expected: u128 = round_fees.iter().map(|f| split_fee(*f).jackpot).sum();
    assert_eq!(prize, expected);

    let mut paid_out = 0u128;
    ctx(&bob(), 0, T0 + 2 * DURATION);
    let _ = c.claim_reward(U64(1));
    ctx_callback(T0 + 2 * DURATION, ok());
    c.on_prize_payment_complete(U64(1));
    paid_out += prize;

    ctx(&alice(), 1, T0 + 2 * DURATION);
    let _ = c.withdraw_near_credit();
    ctx_callback(T0 + 2 * DURATION, ok());
    c.on_withdraw_complete(alice(), U128(s.payout.0));
    paid_out += s.payout.0;

    let ops = c.ledger.ops_reserve;
    ctx(&platform(), 1, T0 + 2 * DURATION);
    let _ = c.withdraw_platform_fees(None);
    ctx_callback(T0 + 2 * DURATION, ok());
    c.on_platform_withdraw_complete(U128(ops));
    paid_out += ops;

    assert_eq!(c.ledger.total_obligations(), SEED + gross_in - paid_out);
    assert_eq!(c.ledger.in_flight, 0);
    assert_eq!(c.ledger.ops_reserve, 0);
    assert_token_conservation(&c);
}
