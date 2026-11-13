use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{env, testing_env, AccountId, NearToken, PromiseResult};

use crate::*;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MIN: u128 = NEAR / 2; // 0.5 NEAR
const DUR: u64 = 3_600_000_000_000; // 60 min
const GRACE: u64 = 120_000_000_000; // 2 min
const FLOOR: u128 = NEAR / 2;
const T0: u64 = 1_800_000_000_000_000_000;
const BAL: u128 = 10 * NEAR;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    acc("pot.last.near")
}
fn reporter() -> AccountId {
    acc("reporter.last.near")
}
fn owner() -> AccountId {
    acc("owner.near")
}

fn ctx(pred: &AccountId, deposit: u128, now: u64, balance: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance))
        .block_timestamp(now)
        .build());
}

fn ctx_cb(now: u64, balance: u128, ok: bool) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(me())
            .predecessor_account_id(me())
            .account_balance(NearToken::from_yoctonear(balance))
            .block_timestamp(now)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }],
    );
}

fn setup() -> PotContract {
    ctx(&owner(), 0, T0, BAL);
    PotContract::new(InitConfig {
        owner_id: owner(),
        reporter_id: reporter(),
        token_id: None,
        wrap_id: acc("wrap.near"),
        round_duration_ns: U64(DUR),
        min_eligible_buy: U128(MIN),
        winner_share_bps: 9_000,
        settle_grace_ns: U64(GRACE),
        reserve_floor: U128(FLOOR),
    })
}

fn rec(c: &mut PotContract, buyer: &str, near_in: u128, ts: u64, now: u64) -> StateView {
    ctx(&reporter(), 0, now, BAL);
    c.record_buy(acc(buyer), U128(near_in), format!("tx{ts}"), U64(ts))
}

#[test]
fn first_eligible_buy_starts_round() {
    let mut c = setup();
    let s = rec(&mut c, "alice.near", MIN, T0 + 10, T0 + 20);
    assert_eq!(s.status, "ACTIVE");
    assert_eq!(s.leader, Some(acc("alice.near")));
    assert_eq!(s.deadline_ns, Some(U64(T0 + 10 + DUR)));
    assert_eq!(s.eligible_buys, 1);
    assert!(get_logs().iter().any(|l| l.contains("round_started")));
}

#[test]
fn second_buy_takes_crown_and_resets_from_buy_time() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0 + 1);
    let s = rec(&mut c, "bob.near", NEAR, T0 + 1_000, T0 + 5_000);
    assert_eq!(s.leader, Some(acc("bob.near")));
    assert_eq!(s.deadline_ns, Some(U64(T0 + 1_000 + DUR)));
    assert_eq!(s.eligible_buys, 2);
    assert_eq!(s.last_tx_hash.as_deref(), Some(format!("tx{}", T0 + 1_000).as_str()));
}

#[test]
#[should_panic(expected = "ERR_NOT_REPORTER")]
fn only_reporter_records() {
    let mut c = setup();
    ctx(&acc("alice.near"), 0, T0, BAL);
    c.record_buy(acc("alice.near"), U128(MIN), "tx".into(), U64(T0));
}

#[test]
#[should_panic(expected = "ERR_NOT_ELIGIBLE")]
fn small_buy_rejected() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN - 1, T0, T0);
}

#[test]
#[should_panic(expected = "ERR_OUT_OF_ORDER")]
fn reports_must_be_chronological() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0 + 100, T0 + 200);
    rec(&mut c, "bob.near", MIN, T0 + 50, T0 + 300);
}

#[test]
#[should_panic(expected = "ERR_FUTURE_BUY")]
fn future_buy_rejected() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0 + 100, T0 + 50);
}

#[test]
fn late_report_of_in_time_buy_still_counts() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    // Bob bought 1 ns before the deadline; the reporter sees it 30 s later (within grace).
    let s = rec(&mut c, "bob.near", MIN, T0 + DUR - 1, T0 + DUR + 30_000_000_000);
    assert_eq!(s.leader, Some(acc("bob.near")));
    assert_eq!(s.status, "ACTIVE");
}

#[test]
#[should_panic(expected = "ERR_ROUND_EXPIRED")]
fn buy_at_deadline_cannot_extend_round() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    rec(&mut c, "bob.near", MIN, T0 + DUR, T0 + DUR + 1);
}

#[test]
#[should_panic(expected = "ERR_NOT_EXPIRED")]
fn settle_waits_for_grace() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    ctx(&acc("anyone.near"), 0, T0 + DUR + GRACE - 1, BAL);
    c.settle_round();
}

#[test]
#[should_panic(expected = "ERR_NO_ACTIVE_ROUND")]
fn settle_idle_rejected() {
    let mut c = setup();
    ctx(&acc("anyone.near"), 0, T0, BAL);
    c.settle_round();
}

#[test]
fn settle_pays_winner_share_and_keeps_rest_as_seed() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    let now = T0 + DUR + GRACE;
    ctx(&acc("anyone.near"), 0, now, BAL);
    let storage = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
    let pot = BAL - storage - FLOOR;
    let r = c.settle_round();
    assert_eq!(r.winner, acc("alice.near"));
    assert_eq!(r.prize.0, pot * 9 / 10);
    assert_eq!(r.status, PayoutStatus::InFlight);
    assert_eq!(r.winning_tx_hash, format!("tx{T0}"));
    // Transfer created: balance went down by the prize, still owed until the callback.
    assert_eq!(env::account_balance().as_yoctonear(), BAL - r.prize.0);
    assert_eq!(c.in_flight, r.prize.0);
    assert_eq!(c.prizes_outstanding, r.prize.0);

    ctx_cb(now, BAL - r.prize.0, true);
    assert!(c.on_payout(U64(1)));
    assert_eq!(c.get_round(U64(1)).unwrap().status, PayoutStatus::Paid);
    assert_eq!((c.in_flight, c.prizes_outstanding, c.total_paid), (0, 0, r.prize.0));
    let s = c.get_state();
    assert_eq!(s.status, "IDLE");
    assert_eq!(s.round_id.0, 2);
    assert_eq!(s.last_settled_round_id, Some(U64(1)));
    // About 10% of the old pot stays as the next round's starting pot.
    assert!(s.pot.0 > 0 && s.pot.0 <= pot - r.prize.0);
}

#[test]
fn failed_payout_restores_claim_exactly_once_then_winner_claims() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    let now = T0 + DUR + GRACE;
    ctx(&acc("anyone.near"), 0, now, BAL);
    let prize = c.settle_round().prize.0;

    ctx_cb(now, BAL, false); // transfer failed: NEAR came back
    assert!(!c.on_payout(U64(1)));
    assert_eq!(c.get_round(U64(1)).unwrap().status, PayoutStatus::Available);
    assert_eq!((c.in_flight, c.prizes_outstanding), (0, prize));
    // The unpaid prize is excluded from the pot.
    assert!(c.get_state().pot.0 < BAL - prize);
    ctx_cb(now, BAL, false); // replayed callback: no change
    assert!(!c.on_payout(U64(1)));
    assert_eq!((c.in_flight, c.prizes_outstanding), (0, prize));

    ctx(&acc("alice.near"), 0, now + 1, BAL);
    let _ = c.claim_reward(U64(1));
    assert_eq!(c.in_flight, prize);
    ctx_cb(now + 2, BAL - prize, true);
    assert!(c.on_payout(U64(1)));
    assert_eq!(c.prizes_outstanding, 0);
}

#[test]
#[should_panic(expected = "ERR_NOT_WINNER")]
fn only_winner_claims() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    ctx(&acc("anyone.near"), 0, T0 + DUR + GRACE, BAL);
    c.settle_round();
    ctx_cb(T0 + DUR + GRACE, BAL, false);
    c.on_payout(U64(1));
    ctx(&acc("bob.near"), 0, T0 + DUR + GRACE + 1, BAL);
    let _ = c.claim_reward(U64(1));
}

#[test]
#[should_panic(expected = "ERR_PAYOUT_IN_FLIGHT")]
fn no_claim_while_payout_in_flight() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    ctx(&acc("anyone.near"), 0, T0 + DUR + GRACE, BAL);
    c.settle_round();
    ctx(&acc("alice.near"), 0, T0 + DUR + GRACE + 1, BAL);
    let _ = c.claim_reward(U64(1));
}

#[test]
#[should_panic(expected = "ERR_STALE_BUY")]
fn stale_buy_cannot_start_new_round() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    ctx(&acc("anyone.near"), 0, T0 + DUR + GRACE, BAL);
    c.settle_round();
    // A buy from before the old deadline, reported after settlement, is too late.
    rec(&mut c, "bob.near", MIN, T0 + DUR - 5, T0 + DUR + GRACE + 1);
}

#[test]
fn buy_after_settlement_starts_next_round() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    let now = T0 + DUR + GRACE;
    ctx(&acc("anyone.near"), 0, now, BAL);
    c.settle_round();
    let s = rec(&mut c, "bob.near", MIN, now + 10, now + 20);
    assert_eq!(s.round_id.0, 2);
    assert_eq!(s.leader, Some(acc("bob.near")));
}

#[test]
fn empty_pot_settles_with_zero_prize() {
    let mut c = setup();
    rec(&mut c, "alice.near", MIN, T0, T0);
    // Balance covers only storage + floor: nothing to win yet.
    ctx(&acc("anyone.near"), 0, T0 + DUR + GRACE, FLOOR);
    let r = c.settle_round();
    assert_eq!(r.prize.0, 0);
    assert_eq!(r.status, PayoutStatus::Paid);
    assert_eq!(c.in_flight, 0);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_sets_reporter() {
    let mut c = setup();
    ctx(&reporter(), 1, T0, BAL);
    c.set_reporter(acc("evil.near"));
}

#[test]
fn owner_rotates_reporter() {
    let mut c = setup();
    ctx(&owner(), 1, T0, BAL);
    c.set_reporter(acc("reporter2.near"));
    assert_eq!(c.get_config().reporter_id, acc("reporter2.near"));
}

#[test]
fn owner_sets_token_once() {
    let mut c = setup();
    assert_eq!(c.get_config().token_id, None);
    ctx(&owner(), 1, T0, BAL);
    c.set_token_id(acc("last-abc123.nearlytrade.near"));
    assert_eq!(c.get_config().token_id, Some(acc("last-abc123.nearlytrade.near")));
}

#[test]
#[should_panic(expected = "ERR_TOKEN_ALREADY_SET")]
fn token_cannot_be_changed() {
    let mut c = setup();
    ctx(&owner(), 1, T0, BAL);
    c.set_token_id(acc("a.nearlytrade.near"));
    c.set_token_id(acc("b.nearlytrade.near"));
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_sets_token() {
    let mut c = setup();
    ctx(&reporter(), 1, T0, BAL);
    c.set_token_id(acc("a.nearlytrade.near"));
}

#[test]
fn wnear_accepted_other_tokens_refunded() {
    let mut c = setup();
    ctx(&acc("wrap.near"), 0, T0, BAL);
    match c.ft_on_transfer(acc("nearly.near"), U128(5), String::new()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 0),
        _ => panic!(),
    }
    ctx(&acc("random.token.near"), 0, T0, BAL);
    match c.ft_on_transfer(acc("x.near"), U128(5), String::new()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 5),
        _ => panic!(),
    }
}
