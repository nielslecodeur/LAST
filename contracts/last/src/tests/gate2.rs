//! Gate 2: settlement, prize claims, sale-credit withdrawals and their callbacks.
//!
//! `#[private]` is enforced by the generated WASM entry point, not by the Rust method, so
//! "callback only from self" is covered by the sandbox tests in `tests/integration`.

use super::*;
use near_sdk::{env, PromiseResult};

/// Context of a private callback: called by the contract itself, with the transfer's outcome.
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

/// alice then bob buy; round 1 expires with bob as leader; carol settles.
fn settled_round_won_by_bob() -> (LastContract, u128) {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    buy(&mut c, &bob(), MIN_BUY, T0 + 1);
    let pot = c.ledger.active_pot;
    ctx(&carol(), 0, T0 + 1 + DURATION);
    c.settle_round();
    (c, pot)
}

// ---- settle_round -----------------------------------------------------------------------------

#[test]
#[should_panic(expected = "ERR_NO_ACTIVE_ROUND")]
fn settle_when_idle_rejected() {
    let mut c = setup();
    ctx(&carol(), 0, T0);
    c.settle_round();
}

#[test]
#[should_panic(expected = "ERR_NOT_EXPIRED")]
fn settle_before_deadline_rejected() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    ctx(&carol(), 0, T0 + DURATION - 1);
    c.settle_round();
}

#[test]
fn settle_reserves_pot_for_winner_and_keeps_next_seed() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    buy(&mut c, &bob(), MIN_BUY, T0 + 1);
    let pot = c.ledger.active_pot;
    let next_seed = c.ledger.next_seed_pot;
    let obligations = c.ledger.total_obligations();

    ctx(&carol(), 0, T0 + 1 + DURATION); // exactly at the deadline: expired
    let r = c.settle_round();
    assert_eq!(r.round_id.0, 1);
    assert_eq!(r.winner, bob());
    assert_eq!(r.prize.0, pot);
    assert_eq!(r.ended_at_ns.0, T0 + 1 + DURATION);
    assert_eq!(r.qualifying_buy_count, 2);
    assert_eq!(r.claim_status, "AVAILABLE");
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"round_settled\"")));

    let g = c.get_game_state();
    assert_eq!(g.status, "IDLE");
    assert_eq!(g.round_id.0, 2);
    assert_eq!(g.last_settled_round_id, Some(U64(1)));
    assert_eq!(g.leader, None);
    assert_eq!(g.active_pot.0, 0);
    assert_eq!(g.next_seed_pot.0, next_seed);
    assert_eq!(c.ledger.prizes_outstanding, pot);
    assert_eq!(c.ledger.total_obligations(), obligations);
    assert_eq!(c.get_round(U64(1)), Some(r));
    assert_eq!(c.get_round(U64(2)), None);
    assert_eq!(c.get_account_state(bob()).claimable_rounds, vec![U64(1)]);
    assert!(c.get_account_state(alice()).claimable_rounds.is_empty());
}

#[test]
#[should_panic(expected = "ERR_NO_ACTIVE_ROUND")]
fn double_settle_rejected() {
    let (mut c, _) = settled_round_won_by_bob();
    ctx(&alice(), 0, T0 + 10 * DURATION);
    c.settle_round();
}

#[test]
fn next_round_starts_from_seed_and_never_touches_old_prize() {
    let (mut c, pot) = settled_round_won_by_bob();
    let seed = c.ledger.next_seed_pot;
    let r = buy(&mut c, &alice(), MIN_BUY, T0 + 5 * DURATION);
    assert_eq!(r.round_id.0, 2);
    assert_eq!(r.leader, Some(alice()));
    let s = split_fee(r.fee.0);
    assert_eq!(c.ledger.active_pot, seed + s.jackpot);
    assert_eq!(c.ledger.next_seed_pot, s.next_seed);
    assert_eq!(c.ledger.prizes_outstanding, pot);
    assert_eq!(c.get_round(U64(1)).unwrap().prize.0, pot);
}

#[test]
fn trades_resume_after_settlement() {
    let (mut c, _) = settled_round_won_by_bob();
    let t = bal(&c, &alice()) / 2;
    sell(&mut c, &alice(), t, T0 + 3 * DURATION);
    assert_eq!(c.get_game_state().status, "IDLE");
}

// ---- claim_reward -----------------------------------------------------------------------------

#[test]
#[should_panic(expected = "ERR_NOT_WINNER")]
fn non_winner_cannot_claim() {
    let (mut c, _) = settled_round_won_by_bob();
    ctx(&alice(), 0, T0 + 3 * DURATION);
    let _ = c.claim_reward(U64(1));
}

#[test]
#[should_panic(expected = "ERR_UNKNOWN_ROUND")]
fn claim_unknown_round_rejected() {
    let (mut c, _) = settled_round_won_by_bob();
    ctx(&bob(), 0, T0 + 3 * DURATION);
    let _ = c.claim_reward(U64(2));
}

#[test]
fn claim_success_pays_once() {
    let (mut c, pot) = settled_round_won_by_bob();
    let now = T0 + 3 * DURATION;
    ctx(&bob(), 0, now);
    let _ = c.claim_reward(U64(1));
    // The transfer left the balance when the promise was created; the prize is still owed.
    assert_eq!(env::account_balance().as_yoctonear(), BALANCE - pot);
    assert_eq!(c.get_round(U64(1)).unwrap().claim_status, "IN_FLIGHT");
    assert_eq!(c.ledger.in_flight, pot);
    assert_eq!(c.ledger.prizes_outstanding, pot);

    ctx_callback(now, ok());
    let res = c.on_prize_payment_complete(U64(1));
    assert!(res.success);
    assert_eq!(res.amount.0, pot);
    assert_eq!(c.get_round(U64(1)).unwrap().claim_status, "PAID");
    assert_eq!(c.ledger.in_flight, 0);
    assert_eq!(c.ledger.prizes_outstanding, 0);
    assert!(c.get_account_state(bob()).claimable_rounds.is_empty());

    // A replayed callback changes nothing.
    ctx_callback(now, ok());
    assert!(!c.on_prize_payment_complete(U64(1)).success);
    assert_eq!(c.ledger.prizes_outstanding, 0);
}

#[test]
#[should_panic(expected = "ERR_ALREADY_PAID")]
fn second_claim_after_payment_rejected() {
    let (mut c, _) = settled_round_won_by_bob();
    let now = T0 + 3 * DURATION;
    ctx(&bob(), 0, now);
    let _ = c.claim_reward(U64(1));
    ctx_callback(now, ok());
    c.on_prize_payment_complete(U64(1));
    ctx(&bob(), 0, now + 1);
    let _ = c.claim_reward(U64(1));
}

#[test]
#[should_panic(expected = "ERR_CLAIM_IN_FLIGHT")]
fn concurrent_claim_rejected() {
    let (mut c, _) = settled_round_won_by_bob();
    ctx(&bob(), 0, T0 + 3 * DURATION);
    let _ = c.claim_reward(U64(1));
    ctx(&bob(), 0, T0 + 3 * DURATION);
    let _ = c.claim_reward(U64(1));
}

#[test]
fn failed_prize_transfer_restores_claim_exactly_once() {
    let (mut c, pot) = settled_round_won_by_bob();
    let now = T0 + 3 * DURATION;
    ctx(&bob(), 0, now);
    let _ = c.claim_reward(U64(1));
    ctx_callback(now, PromiseResult::Failed);
    let res = c.on_prize_payment_complete(U64(1));
    assert!(!res.success);
    assert_eq!(c.get_round(U64(1)).unwrap().claim_status, "AVAILABLE");
    assert_eq!(c.ledger.in_flight, 0);
    assert_eq!(c.ledger.prizes_outstanding, pot);
    assert_eq!(c.get_account_state(bob()).claimable_rounds, vec![U64(1)]);
    assert!(get_logs().iter().any(|l| l.contains("\"status\":\"FAILED\"")));

    // Replayed failure callback: nothing is restored twice.
    ctx_callback(now, PromiseResult::Failed);
    c.on_prize_payment_complete(U64(1));
    assert_eq!(c.ledger.prizes_outstanding, pot);
    assert_eq!(c.ledger.in_flight, 0);

    // The winner can retry and get paid.
    ctx(&bob(), 0, now + 1);
    let _ = c.claim_reward(U64(1));
    ctx_callback(now + 1, ok());
    assert!(c.on_prize_payment_complete(U64(1)).success);
    assert_eq!(c.ledger.prizes_outstanding, 0);
}

#[test]
fn leader_who_sold_everything_still_claims() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    let all = bal(&c, &alice());
    sell(&mut c, &alice(), all, T0 + 1);
    ctx(&carol(), 0, T0 + DURATION);
    assert_eq!(c.settle_round().winner, alice());
    ctx(&alice(), 0, T0 + DURATION + 1);
    let _ = c.claim_reward(U64(1));
    assert_eq!(c.get_round(U64(1)).unwrap().claim_status, "IN_FLIGHT");
}

// ---- withdraw_near_credit ---------------------------------------------------------------------

#[test]
fn withdraw_credit_success() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    let t = bal(&c, &alice()) / 2;
    let payout = sell(&mut c, &alice(), t, T0 + 1).payout.0;

    ctx(&alice(), 1, T0 + 2);
    let _ = c.withdraw_near_credit();
    let a = c.get_account_state(alice());
    assert_eq!((a.credit_available.0, a.credit_in_flight.0), (0, payout));
    assert_eq!(c.ledger.in_flight, payout);
    assert_eq!(c.ledger.credits_outstanding, payout);

    // Selling again while the withdrawal is in flight adds to `available`.
    let t2 = bal(&c, &alice());
    let payout2 = sell(&mut c, &alice(), t2, T0 + 3).payout.0;
    assert_eq!(c.get_account_state(alice()).credit_available.0, payout2);

    ctx_callback(T0 + 4, ok());
    let res = c.on_withdraw_complete(alice(), U128(payout));
    assert!(res.success);
    let a = c.get_account_state(alice());
    assert_eq!((a.credit_available.0, a.credit_in_flight.0), (payout2, 0));
    assert_eq!(c.ledger.credits_outstanding, payout2);
    assert_eq!(c.ledger.in_flight, 0);

    // Second withdrawal empties the credit and frees its storage entry.
    ctx(&alice(), 1, T0 + 5);
    let _ = c.withdraw_near_credit();
    ctx_callback(T0 + 6, ok());
    c.on_withdraw_complete(alice(), U128(payout2));
    assert_eq!(c.ledger.credits_outstanding, 0);
    assert!(c.credits.get(&alice()).is_none());
}

#[test]
fn failed_withdraw_restores_credit_exactly_once() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    let t = bal(&c, &alice());
    let payout = sell(&mut c, &alice(), t, T0 + 1).payout.0;
    ctx(&alice(), 1, T0 + 2);
    let _ = c.withdraw_near_credit();
    ctx_callback(T0 + 3, PromiseResult::Failed);
    assert!(!c.on_withdraw_complete(alice(), U128(payout)).success);
    let a = c.get_account_state(alice());
    assert_eq!((a.credit_available.0, a.credit_in_flight.0), (payout, 0));
    assert_eq!(c.ledger.credits_outstanding, payout);
    assert_eq!(c.ledger.in_flight, 0);
    // Replay: in-flight is 0, so nothing is restored again.
    ctx_callback(T0 + 3, PromiseResult::Failed);
    c.on_withdraw_complete(alice(), U128(payout));
    assert_eq!(c.get_account_state(alice()).credit_available.0, payout);
}

#[test]
#[should_panic(expected = "ERR_WITHDRAW_IN_FLIGHT")]
fn concurrent_withdraw_rejected() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    let t = bal(&c, &alice()) / 2;
    sell(&mut c, &alice(), t, T0 + 1);
    ctx(&alice(), 1, T0 + 2);
    let _ = c.withdraw_near_credit();
    sell(&mut c, &alice(), t / 2, T0 + 3);
    ctx(&alice(), 1, T0 + 4);
    let _ = c.withdraw_near_credit();
}

#[test]
#[should_panic(expected = "ERR_NO_CREDIT")]
fn withdraw_without_credit_rejected() {
    let mut c = setup();
    ctx(&alice(), 1, T0);
    let _ = c.withdraw_near_credit();
}

#[test]
#[should_panic(expected = "ERR_ONE_YOCTO")]
fn withdraw_requires_one_yocto() {
    let mut c = setup();
    ctx(&alice(), 0, T0);
    let _ = c.withdraw_near_credit();
}

// ---- conservation across the whole cycle ------------------------------------------------------

#[test]
fn full_cycle_conservation() {
    // buy, dust, sell, expiry, settle, claim, withdraw: every yocto in is in a bucket or paid out.
    let mut c = setup();
    let mut gross_in = 0u128;
    let mut paid_out = 0u128;
    for (who, g, t) in [(alice(), NEAR, T0), (bob(), MIN_BUY, T0 + 1), (carol(), MIN_BUY - 1, T0 + 2)] {
        buy(&mut c, &who, g, t);
        gross_in += g;
    }
    let t = bal(&c, &alice()) / 3;
    let payout = sell(&mut c, &alice(), t, T0 + 3).payout.0;
    assert_eq!(c.ledger.total_obligations(), SEED + gross_in - paid_out);

    ctx(&carol(), 0, T0 + 1 + DURATION);
    let prize = c.settle_round().prize.0;
    assert_eq!(c.ledger.total_obligations(), SEED + gross_in - paid_out);

    ctx(&bob(), 0, T0 + 2 * DURATION);
    let _ = c.claim_reward(U64(1));
    ctx_callback(T0 + 2 * DURATION, ok());
    c.on_prize_payment_complete(U64(1));
    paid_out += prize;
    assert_eq!(c.ledger.total_obligations(), SEED + gross_in - paid_out);

    ctx(&alice(), 1, T0 + 2 * DURATION);
    let _ = c.withdraw_near_credit();
    ctx_callback(T0 + 2 * DURATION, ok());
    c.on_withdraw_complete(alice(), U128(payout));
    paid_out += payout;
    assert_eq!(c.ledger.total_obligations(), SEED + gross_in - paid_out);
    assert_eq!(c.ledger.in_flight, 0);
    assert_token_conservation(&c);
}
