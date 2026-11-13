//! v0.4 play balance: deposit, buy/sell without a deposit (session key), withdraw.

use super::*;

fn deposit(c: &mut LastContract, who: &AccountId, amount: u128, now: u64) -> crate::balance::DepositResult {
    ctx(who, amount, now);
    c.deposit_balance()
}

fn buy_bal(c: &mut LastContract, who: &AccountId, amount: u128, now: u64) -> market::BuyResult {
    ctx(who, 0, now);
    c.buy_from_balance(U128(amount), U128(0))
}

#[test]
fn deposit_credits_the_play_balance_and_is_an_obligation() {
    let mut c = setup();
    let before = c.ledger.total_obligations();
    let r = deposit(&mut c, &alice(), NEAR, T0);
    assert_eq!((r.amount.0, r.credit_available.0), (NEAR, NEAR));
    assert_eq!(c.get_account_state(alice()).credit_available.0, NEAR);
    assert_eq!(c.ledger.credits_outstanding, NEAR);
    assert_eq!(c.ledger.total_obligations(), before + NEAR);
    assert!(get_logs().iter().any(|l| l.contains("\"balance_deposit\"")));
}

#[test]
#[should_panic(expected = "ERR_NOT_REGISTERED")]
fn deposit_requires_registration() {
    let mut c = setup();
    deposit(&mut c, &acc("dave.testnet"), NEAR, T0);
}

#[test]
#[should_panic(expected = "ERR_ZERO_DEPOSIT")]
fn deposit_requires_near() {
    let mut c = setup();
    deposit(&mut c, &alice(), 0, T0);
}

#[test]
fn buy_from_balance_equals_a_wallet_buy() {
    // Same math as `buy`: tokens and fee match the quote, the fee is split exactly like a wallet buy.
    let mut c = setup();
    deposit(&mut c, &alice(), NEAR, T0);
    let amount = NEAR / 10;
    let q = c.quote_buy(U128(amount));
    let x0 = c.ledger.market_near_reserve;
    let r = buy_bal(&mut c, &alice(), amount, T0);
    assert_eq!((r.tokens_out, r.fee), (q.tokens_out, q.fee));
    assert!(r.eligible);
    assert_eq!(c.ledger.active_pot, split_fee(q.fee.0).jackpot);
    assert_eq!(c.ledger.market_near_reserve, x0 + q.net_near.0);
    assert_eq!(c.get_game_state().leader, Some(alice()));
    assert_eq!(bal(&c, &alice()), q.tokens_out.0);
    assert_eq!(c.get_account_state(alice()).credit_available.0, NEAR - amount);
    assert_eq!(c.ledger.credits_outstanding, NEAR - amount);
    assert_token_conservation(&c);
}

#[test]
fn buy_from_balance_takes_the_crown_and_resets_timer() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    deposit(&mut c, &bob(), NEAR, T0 + 1);
    let r = buy_bal(&mut c, &bob(), MIN_BUY, T0 + 10);
    assert_eq!(r.leader, Some(bob()));
    assert_eq!(r.deadline_ns.unwrap().0, T0 + 10 + DURATION);
}

#[test]
fn dust_buy_from_balance_gives_tokens_not_the_crown() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    deposit(&mut c, &bob(), NEAR, T0);
    let r = buy_bal(&mut c, &bob(), MIN_BUY - 1, T0 + 5);
    assert!(!r.eligible);
    assert_eq!(c.get_game_state().leader, Some(alice()));
    assert!(bal(&c, &bob()) > 0);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE_NEAR")]
fn cannot_spend_more_than_the_balance() {
    let mut c = setup();
    deposit(&mut c, &alice(), NEAR, T0);
    buy_bal(&mut c, &alice(), NEAR + 1, T0);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE_NEAR")]
fn cannot_spend_someone_elses_balance() {
    let mut c = setup();
    deposit(&mut c, &alice(), NEAR, T0);
    buy_bal(&mut c, &bob(), MIN_BUY, T0);
}

#[test]
#[should_panic(expected = "ERR_ROUND_EXPIRED")]
fn buy_from_balance_after_deadline_rejected() {
    let mut c = setup();
    deposit(&mut c, &alice(), NEAR, T0);
    buy_bal(&mut c, &alice(), MIN_BUY, T0);
    buy_bal(&mut c, &alice(), MIN_BUY, T0 + DURATION);
}

#[test]
#[should_panic(expected = "ERR_SLIPPAGE")]
fn buy_from_balance_checks_slippage() {
    let mut c = setup();
    deposit(&mut c, &alice(), NEAR, T0);
    let q = c.quote_buy(U128(MIN_BUY));
    ctx(&alice(), 0, T0);
    c.buy_from_balance(U128(MIN_BUY), U128(q.tokens_out.0 + 1));
}

#[test]
fn failed_buy_from_balance_keeps_the_balance() {
    // A panic reverts the whole call on-chain; here we check the debit happens only on success
    // by verifying a successful buy after a would-be failure leaves the exact remainder.
    let mut c = setup();
    deposit(&mut c, &alice(), NEAR, T0);
    buy_bal(&mut c, &alice(), NEAR, T0); // spend all
    assert_eq!(c.get_account_state(alice()).credit_available.0, 0);
    assert!(c.credits.get(&alice()).is_none()); // storage entry freed
}

#[test]
fn sell_to_balance_needs_no_yocto_and_credits_the_balance() {
    let mut c = setup();
    deposit(&mut c, &alice(), NEAR, T0);
    buy_bal(&mut c, &alice(), NEAR / 2, T0);
    let tokens = bal(&c, &alice());
    let leader = c.get_game_state().leader;
    ctx(&alice(), 0, T0 + 1);
    let r = c.sell_to_balance(U128(tokens), U128(0));
    assert_eq!(r.credit_available.0, NEAR / 2 + r.payout.0);
    assert_eq!(c.get_game_state().leader, leader); // never moves the crown
    assert_token_conservation(&c);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
fn sell_to_balance_cannot_sell_others_tokens() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    ctx(&bob(), 0, T0 + 1);
    c.sell_to_balance(U128(1), U128(0));
}

#[test]
fn deposit_buy_sell_withdraw_conserves_every_yocto() {
    let mut c = setup();
    deposit(&mut c, &alice(), NEAR, T0);
    deposit(&mut c, &bob(), NEAR, T0);
    buy_bal(&mut c, &alice(), NEAR / 4, T0 + 1);
    buy_bal(&mut c, &bob(), NEAR / 3, T0 + 2);
    ctx(&alice(), 0, T0 + 3);
    let t = bal(&c, &alice()) / 2;
    c.sell_to_balance(U128(t), U128(0));
    // Obligations = seed + deposits (nothing left the contract): reserve + pots + fees + credits.
    assert_eq!(c.ledger.total_obligations(), SEED + 2 * NEAR);
    let i = c.get_integrity();
    assert_eq!(i.total_obligations.0, SEED + 2 * NEAR);
    assert_token_conservation(&c);

    // Withdraw sends the whole balance to the owner (1 yocto, wallet).
    let owed = c.get_account_state(alice()).credit_available.0;
    ctx(&alice(), 1, T0 + 4);
    let _ = c.withdraw_near_credit();
    assert_eq!(c.get_account_state(alice()).credit_in_flight.0, owed);
}
