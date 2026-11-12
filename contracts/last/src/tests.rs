//! Contract-level unit tests (mocked blockchain). Sandbox tests live in `tests/integration`.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadataProvider;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};

use crate::accounting::{split_fee, BUY_FEE_BPS, SELL_FEE_BPS};
use crate::market::{calc_buy, calc_sell};
use crate::*;

const NEAR: u128 = ONE_NEAR;
const SEED: u128 = 3 * NEAR;
const MIN_BUY: u128 = 3 * NEAR / 100; // 0.03 NEAR
const DURATION: u64 = 120_000_000_000; // 120 s
const T0: u64 = 1_700_000_000_000_000_000;
/// Mocked contract balance: seed + generous storage buffer. Tests that check solvency override it.
const BALANCE: u128 = 1_000 * NEAR;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract_id() -> AccountId {
    acc("last.testnet")
}
fn alice() -> AccountId {
    acc("alice.testnet")
}
fn bob() -> AccountId {
    acc("bob.testnet")
}
fn carol() -> AccountId {
    acc("carol.testnet")
}

fn ctx(predecessor: &AccountId, deposit: u128, now: u64) {
    ctx_with_balance(predecessor, deposit, now, BALANCE);
}

fn ctx_with_balance(predecessor: &AccountId, deposit: u128, now: u64, balance: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance))
        .block_timestamp(now)
        .build());
}

fn config() -> InitConfig {
    InitConfig {
        owner_id: acc("owner.testnet"),
        treasury_id: acc("treasury.testnet"),
        platform_id: acc("ops.testnet"),
        round_duration_ns: U64(DURATION),
        min_eligible_buy: U128(MIN_BUY),
        seed_near: U128(SEED),
    }
}

/// Fresh contract with alice, bob and carol registered for FT storage.
fn setup() -> LastContract {
    ctx(&acc("owner.testnet"), SEED, T0);
    let mut c = LastContract::new(config());
    for a in [alice(), bob(), carol()] {
        let min = c.storage_balance_bounds().min.as_yoctonear();
        ctx(&a, min, T0);
        c.storage_deposit(None, None);
    }
    c
}

fn buy(c: &mut LastContract, who: &AccountId, gross: u128, now: u64) -> market::BuyResult {
    ctx(who, gross, now);
    c.buy(U128(0))
}

fn sell(c: &mut LastContract, who: &AccountId, tokens: u128, now: u64) -> market::SellResult {
    ctx(who, 1, now);
    c.sell(U128(tokens), U128(0))
}

fn bal(c: &LastContract, who: &AccountId) -> u128 {
    c.ft_balance_of(who.clone()).0
}

/// Token ledger: supply constant, market inventory + holders == supply.
fn assert_token_conservation(c: &LastContract) {
    assert_eq!(c.ft_total_supply().0, TOTAL_SUPPLY);
    let held: u128 = [alice(), bob(), carol()].iter().map(|a| bal(c, a)).sum();
    assert_eq!(c.market_inventory() + held, TOTAL_SUPPLY);
}

// ----------------------------------------------------------------------------------------------
// Init and token
// ----------------------------------------------------------------------------------------------

#[test]
fn init_mints_once_to_market_inventory() {
    let c = setup();
    assert_eq!(c.ft_total_supply().0, 10u128.pow(24));
    assert_eq!(bal(&c, &contract_id()), TOTAL_SUPPLY);
    let m = c.get_market_state();
    assert_eq!(m.near_reserve.0, SEED);
    assert_eq!(m.last_inventory.0, TOTAL_SUPPLY);
    assert_eq!(m.buy_fee_bps, 400);
    assert_eq!(m.sell_fee_bps, 200);
    let g = c.get_game_state();
    assert_eq!(g.status, "IDLE");
    assert_eq!(g.round_id.0, 1);
    assert_eq!(g.leader, None);
    let md = c.ft_metadata();
    assert_eq!((md.symbol.as_str(), md.decimals), ("LAST", 18));
    assert_eq!(c.ledger.total_obligations(), SEED);
}

#[test]
#[should_panic(expected = "ERR_BAD_SEED_DEPOSIT")]
fn init_requires_exact_seed_deposit() {
    ctx(&acc("owner.testnet"), SEED - 1, T0);
    LastContract::new(config());
}

#[test]
#[should_panic(expected = "ERR_INSOLVENT")]
fn init_requires_balance_for_storage() {
    // Pre-funded balance 0: after the deposit the account holds only the seed, nothing for storage.
    ctx_with_balance(&acc("owner.testnet"), SEED, T0, 0);
    LastContract::new(config());
}

#[test]
#[should_panic(expected = "ERR_USE_SELL")]
fn cannot_ft_transfer_to_market() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    ctx(&alice(), 1, T0);
    c.ft_transfer(contract_id(), U128(1), None);
}

#[test]
#[should_panic(expected = "ERR_POSITIVE_BALANCE")]
fn cannot_force_unregister_with_balance() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    ctx(&alice(), 1, T0);
    c.storage_unregister(Some(true));
}

#[test]
fn transfers_do_not_touch_game() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    let before = c.get_game_state();
    let pot = c.ledger.clone();
    ctx(&alice(), 1, T0 + 1);
    c.ft_transfer(bob(), U128(1_000), None);
    let after = c.get_game_state();
    assert_eq!(after.leader, before.leader);
    assert_eq!(after.deadline_ns, before.deadline_ns);
    assert_eq!(c.ledger, pot);
    assert_token_conservation(&c);
}

// ----------------------------------------------------------------------------------------------
// Buy
// ----------------------------------------------------------------------------------------------

#[test]
#[should_panic(expected = "ERR_NOT_REGISTERED")]
fn buy_requires_registration() {
    let mut c = setup();
    buy(&mut c, &acc("stranger.testnet"), NEAR, T0);
}

#[test]
#[should_panic(expected = "ERR_ZERO_DEPOSIT")]
fn buy_requires_deposit() {
    let mut c = setup();
    buy(&mut c, &alice(), 0, T0);
}

#[test]
#[should_panic(expected = "ERR_ZERO_OUTPUT")]
fn buy_dust_with_zero_output_rejected() {
    let mut c = setup();
    buy(&mut c, &alice(), 1, T0);
}

#[test]
#[should_panic(expected = "ERR_SLIPPAGE")]
fn buy_slippage() {
    let mut c = setup();
    let q = c.quote_buy(U128(NEAR));
    ctx(&alice(), NEAR, T0);
    c.buy(U128(q.tokens_out.0 + 1));
}

#[test]
fn buy_matches_quote_and_moves_reserves() {
    let mut c = setup();
    let q = c.quote_buy(U128(NEAR));
    let r = buy(&mut c, &alice(), NEAR, T0);
    assert_eq!(r.tokens_out, q.tokens_out);
    assert_eq!(r.fee.0, NEAR * BUY_FEE_BPS / 10_000);
    assert_eq!(bal(&c, &alice()), q.tokens_out.0);
    let m = c.get_market_state();
    assert_eq!(m.near_reserve.0, SEED + q.net_near.0);
    assert_eq!(m.last_inventory.0, TOTAL_SUPPLY - q.tokens_out.0);
    assert_eq!(m.total_buy_volume.0, NEAR);
    assert_token_conservation(&c);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"buy\"")));
}

#[test]
fn first_eligible_buy_starts_round_and_funds_pot() {
    let mut c = setup();
    let r = buy(&mut c, &alice(), MIN_BUY, T0);
    assert!(r.eligible);
    assert_eq!(r.leader, Some(alice()));
    assert_eq!(r.deadline_ns, Some(U64(T0 + DURATION)));
    let s = split_fee(r.fee.0);
    let g = c.get_game_state();
    assert_eq!(g.status, "ACTIVE");
    assert_eq!(g.round_id.0, 1);
    assert_eq!(g.qualifying_buy_count, 1);
    assert_eq!(g.active_pot.0, s.jackpot);
    assert_eq!(g.next_seed_pot.0, s.next_seed);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"round_started\"")));
}

#[test]
fn idle_dust_buy_feeds_next_seed_which_moves_into_first_round() {
    let mut c = setup();
    let dust = MIN_BUY - 1;
    let r1 = buy(&mut c, &alice(), dust, T0);
    assert!(!r1.eligible);
    assert_eq!(r1.leader, None);
    let s1 = split_fee(r1.fee.0);
    let g = c.get_game_state();
    assert_eq!(g.status, "IDLE");
    assert_eq!(g.active_pot.0, 0);
    assert_eq!(g.next_seed_pot.0, s1.jackpot + s1.next_seed); // 80% while idle

    let r2 = buy(&mut c, &bob(), MIN_BUY, T0 + 10);
    let s2 = split_fee(r2.fee.0);
    let g = c.get_game_state();
    assert_eq!(g.leader, Some(bob()));
    assert_eq!(g.active_pot.0, s1.jackpot + s1.next_seed + s2.jackpot);
    assert_eq!(g.next_seed_pot.0, s2.next_seed);
}

#[test]
fn second_eligible_buy_takes_crown_and_resets_timer() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    let r = buy(&mut c, &bob(), MIN_BUY, T0 + 60_000_000_000);
    assert_eq!(r.leader, Some(bob()));
    assert_eq!(r.deadline_ns, Some(U64(T0 + 60_000_000_000 + DURATION)));
    assert_eq!(c.get_game_state().qualifying_buy_count, 2);
}

#[test]
fn active_dust_buy_moves_price_and_pot_but_not_crown() {
    let mut c = setup();
    buy(&mut c, &bob(), MIN_BUY, T0);
    let before = c.get_game_state();
    let price_before = c.get_market_state();
    let r = buy(&mut c, &alice(), MIN_BUY - 1, T0 + 5);
    assert!(!r.eligible);
    assert_eq!(r.leader, Some(bob()));
    let after = c.get_game_state();
    assert_eq!(after.leader, Some(bob()));
    assert_eq!(after.deadline_ns, before.deadline_ns);
    assert_eq!(after.qualifying_buy_count, 1);
    let s = split_fee(r.fee.0);
    assert_eq!(after.active_pot.0, before.active_pot.0 + s.jackpot);
    assert!(c.get_market_state().near_reserve.0 > price_before.near_reserve.0);
}

#[test]
fn buy_one_ns_before_deadline_succeeds() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    let r = buy(&mut c, &bob(), MIN_BUY, T0 + DURATION - 1);
    assert_eq!(r.leader, Some(bob()));
}

#[test]
#[should_panic(expected = "ERR_ROUND_EXPIRED")]
fn buy_exactly_at_deadline_rejected() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    assert_eq!(c.status_at(T0 + DURATION), game::Status::Expired);
    buy(&mut c, &bob(), MIN_BUY, T0 + DURATION);
}

#[test]
#[should_panic(expected = "ERR_ROUND_EXPIRED")]
fn dust_buy_after_deadline_rejected() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    buy(&mut c, &bob(), MIN_BUY - 1, T0 + DURATION + 1);
}

#[test]
fn expired_state_is_visible_in_view() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    ctx(&carol(), 0, T0 + DURATION);
    let g = c.get_game_state();
    assert_eq!(g.status, "EXPIRED");
    assert_eq!(g.leader, Some(alice()));
    assert_eq!(g.now_ns.0, T0 + DURATION);
}

// ----------------------------------------------------------------------------------------------
// Sell
// ----------------------------------------------------------------------------------------------

#[test]
fn sell_creates_credit_and_keeps_leader() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    buy(&mut c, &bob(), MIN_BUY, T0 + 1);
    let before = c.get_game_state();
    let obligations_before = c.ledger.total_obligations();
    let x_before = c.ledger.market_near_reserve;

    let tokens = bal(&c, &alice()) / 2;
    let q = c.quote_sell(U128(tokens));
    let r = sell(&mut c, &alice(), tokens, T0 + 2);
    assert_eq!(r.payout, q.payout);
    assert_eq!(r.fee.0, r.gross_near_out.0 * SELL_FEE_BPS / 10_000);
    assert_eq!(r.credit_available, r.payout);

    let after = c.get_game_state();
    assert_eq!(after.leader, Some(bob()));
    assert_eq!(after.deadline_ns, before.deadline_ns);
    let s = split_fee(r.fee.0);
    assert_eq!(after.active_pot.0, before.active_pot.0 + s.jackpot);
    assert_eq!(c.ledger.market_near_reserve, x_before - r.gross_near_out.0);
    // A sell moves NEAR between buckets only: total obligations unchanged.
    assert_eq!(c.ledger.total_obligations(), obligations_before);

    let a = c.get_account_state(alice());
    assert_eq!(a.credit_available, r.payout);
    assert_eq!(a.credit_in_flight.0, 0);
    assert_token_conservation(&c);
}

#[test]
fn leader_can_sell_everything_and_stay_leader() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    let all = bal(&c, &alice());
    sell(&mut c, &alice(), all, T0 + 1);
    assert_eq!(bal(&c, &alice()), 0);
    assert_eq!(c.get_game_state().leader, Some(alice()));
}

#[test]
#[should_panic(expected = "ERR_ONE_YOCTO")]
fn sell_requires_one_yocto() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    ctx(&alice(), 0, T0);
    c.sell(U128(1_000), U128(0));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
fn sell_more_than_balance() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    let too_much = bal(&c, &alice()) + 1;
    sell(&mut c, &alice(), too_much, T0);
}

#[test]
#[should_panic(expected = "ERR_SLIPPAGE")]
fn sell_slippage() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    let t = bal(&c, &alice());
    let q = c.quote_sell(U128(t));
    ctx(&alice(), 1, T0);
    c.sell(U128(t), U128(q.payout.0 + 1));
}

#[test]
#[should_panic(expected = "ERR_ROUND_EXPIRED")]
fn sell_after_deadline_rejected() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY, T0);
    sell(&mut c, &alice(), 1_000_000, T0 + DURATION);
}

#[test]
fn idle_sell_fee_goes_to_next_seed() {
    let mut c = setup();
    buy(&mut c, &alice(), MIN_BUY - 1, T0); // dust: stays IDLE
    let seed_before = c.ledger.next_seed_pot;
    let all = bal(&c, &alice());
    let r = sell(&mut c, &alice(), all, T0 + 1);
    let s = split_fee(r.fee.0);
    assert_eq!(c.ledger.next_seed_pot, seed_before + s.jackpot + s.next_seed);
    assert_eq!(c.ledger.active_pot, 0);
}

// ----------------------------------------------------------------------------------------------
// Conservation and solvency
// ----------------------------------------------------------------------------------------------

#[test]
fn conservation_over_mixed_sequence() {
    let mut c = setup();
    let users = [alice(), bob(), carol()];
    let mut gross_in: u128 = 0;
    let mut now = T0;
    // Deterministic pseudo-random walk (LCG), no external crates.
    let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        seed >> 33
    };
    for _ in 0..300 {
        now += 1_000_000_000; // 1 s, never reaches the 120 s deadline between eligible buys
        let who = users[(next() % 3) as usize].clone();
        let roll = next() % 10;
        if roll < 6 {
            // Buys from dust to 2 NEAR.
            let gross = 1_000_000 + (next() as u128) * (2 * NEAR / (1u128 << 31));
            let x = c.ledger.market_near_reserve;
            if calc_buy(x, c.market_inventory(), gross).tokens_out == 0 {
                continue;
            }
            buy(&mut c, &who, gross, now);
            gross_in += gross;
            // Keep the round alive so trades stay legal.
            buy(&mut c, &who, MIN_BUY, now);
            gross_in += MIN_BUY;
        } else {
            let held = bal(&c, &who);
            if held == 0 {
                continue;
            }
            let t = held / (1 + (next() % 4) as u128);
            let q = calc_sell(c.ledger.market_near_reserve, c.market_inventory(), t);
            if q.payout == 0 {
                continue;
            }
            sell(&mut c, &who, t, now);
        }
        // Every yoctoNEAR that came in is in exactly one bucket.
        assert_eq!(c.ledger.total_obligations(), SEED + gross_in);
        assert_token_conservation(&c);
    }
    let credits: u128 = users
        .iter()
        .map(|u| c.get_account_state(u.clone()).credit_available.0)
        .sum();
    assert_eq!(c.ledger.credits_outstanding, credits);
    assert!(c.totals.sell_count > 0 && c.totals.buy_count > 0);
}

#[test]
#[should_panic(expected = "ERR_INSOLVENT")]
fn trade_rejected_if_balance_does_not_cover_obligations() {
    let mut c = setup();
    // Balance after the 1 NEAR deposit = seed + 1 NEAR = obligations exactly: nothing left to
    // cover storage, as if NEAR had leaked outside the ledger.
    ctx_with_balance(&alice(), NEAR, T0, SEED);
    c.buy(U128(0));
}

#[test]
fn integrity_view_reports_surplus() {
    let mut c = setup();
    buy(&mut c, &alice(), NEAR, T0);
    let i = c.get_integrity();
    assert_eq!(i.total_obligations.0, SEED + NEAR);
    // The mocked runtime, like the real one, counts the attached deposit in the balance.
    assert_eq!(i.account_balance.0, BALANCE + NEAR);
    assert_eq!(i.surplus.0, i.account_balance.0 - i.storage_cost.0 - i.total_obligations.0);
}
