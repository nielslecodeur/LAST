//! Pull payouts (docs/SPEC_V2.md §1.5, §2.2, §2.3 #10–12).
//!
//! Both payouts follow the same pattern:
//! 1. reserve: mark the amount IN_FLIGHT *before* creating the transfer promise, so a second
//!    request is rejected until the outcome is known;
//! 2. transfer + private callback;
//! 3. callback: success -> PAID and the liability is released; failure -> back to AVAILABLE,
//!    exactly once (the refunded NEAR is back in the balance).
//! Callbacks never panic: a panic would leave the reservation stuck IN_FLIGHT.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, Promise};

use crate::accounting::{add, sub};
use crate::game::ClaimStatus;
use crate::{events, LastContract, LastContractExt};

/// Gas reserved for `on_*_complete`. They only touch a few storage keys.
pub const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(10);

/// NEAR owed to an account from its sells, in yoctoNEAR.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Credit {
    pub available: u128,
    pub in_flight: u128,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithdrawResult {
    pub amount: U128,
    pub success: bool,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformWithdrawResult {
    pub amount: U128,
    pub success: bool,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimResult {
    pub round_id: U64,
    pub amount: U128,
    pub success: bool,
}

/// Outcome of the single transfer promise this callback is attached to.
fn transfer_succeeded() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 0).is_ok()
}

impl LastContract {
    pub(crate) fn credit_sale(&mut self, account_id: &AccountId, payout: u128) -> Credit {
        let mut credit = self.credits.get(account_id).cloned().unwrap_or_default();
        credit.available = add(credit.available, payout);
        self.credits.insert(account_id.clone(), credit.clone());
        self.ledger.credits_outstanding = add(self.ledger.credits_outstanding, payout);
        credit
    }

    pub(crate) fn unpaid_rounds_of(&self, account_id: &AccountId) -> Vec<u64> {
        self.claimable.get(account_id).cloned().unwrap_or_default()
    }
}

#[near]
impl LastContract {
    /// Withdraw the caller's whole available sale credit.
    #[payable]
    pub fn withdraw_near_credit(&mut self) -> Promise {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "ERR_ONE_YOCTO");
        let account_id = env::predecessor_account_id();
        let mut credit = self
            .credits
            .get(&account_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("ERR_NO_CREDIT"));
        require!(credit.in_flight == 0, "ERR_WITHDRAW_IN_FLIGHT");
        require!(credit.available > 0, "ERR_NO_CREDIT");

        let amount = credit.available;
        credit.available = 0;
        credit.in_flight = amount;
        self.credits.insert(account_id.clone(), credit);
        self.ledger.in_flight = add(self.ledger.in_flight, amount);
        events::credit_withdraw(&account_id, amount, "IN_FLIGHT");

        let promise = Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                    .on_withdraw_complete(account_id, U128(amount)),
            );
        self.assert_solvent();
        promise
    }

    #[private]
    pub fn on_withdraw_complete(&mut self, account_id: AccountId, amount: U128) -> WithdrawResult {
        let amount = amount.0;
        let success = transfer_succeeded();
        let Some(mut credit) = self.credits.get(&account_id).cloned() else {
            log!("on_withdraw_complete: no credit for {}", account_id);
            return WithdrawResult { amount: U128(amount), success: false };
        };
        if credit.in_flight != amount {
            log!("on_withdraw_complete: in-flight mismatch for {}", account_id);
            return WithdrawResult { amount: U128(amount), success: false };
        }
        credit.in_flight = 0;
        self.ledger.in_flight = sub(self.ledger.in_flight, amount);
        if success {
            self.ledger.credits_outstanding = sub(self.ledger.credits_outstanding, amount);
            events::credit_withdraw(&account_id, amount, "PAID");
        } else {
            credit.available = add(credit.available, amount);
            events::credit_withdraw(&account_id, amount, "FAILED");
        }
        if credit == Credit::default() {
            self.credits.remove(&account_id); // free storage once fully paid
        } else {
            self.credits.insert(account_id, credit);
        }
        WithdrawResult { amount: U128(amount), success }
    }

    /// Pay the prize of a settled round to its recorded winner.
    pub fn claim_reward(&mut self, round_id: U64) -> Promise {
        let caller = env::predecessor_account_id();
        let mut round = self
            .rounds
            .get(&round_id.0)
            .cloned()
            .unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_ROUND"));
        require!(round.winner == caller, "ERR_NOT_WINNER");
        match round.claim_status {
            ClaimStatus::Paid => env::panic_str("ERR_ALREADY_PAID"),
            ClaimStatus::InFlight => env::panic_str("ERR_CLAIM_IN_FLIGHT"),
            ClaimStatus::Available => {}
        }
        require!(round.prize > 0, "ERR_EMPTY_PRIZE");

        let amount = round.prize;
        round.claim_status = ClaimStatus::InFlight;
        self.rounds.insert(round_id.0, round);
        self.ledger.in_flight = add(self.ledger.in_flight, amount);
        events::prize_claim(round_id.0, &caller, amount, "IN_FLIGHT");

        let promise = Promise::new(caller)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                    .on_prize_payment_complete(round_id),
            );
        self.assert_solvent();
        promise
    }

    #[private]
    pub fn on_prize_payment_complete(&mut self, round_id: U64) -> ClaimResult {
        let success = transfer_succeeded();
        let Some(mut round) = self.rounds.get(&round_id.0).cloned() else {
            log!("on_prize_payment_complete: unknown round {}", round_id.0);
            return ClaimResult { round_id, amount: U128(0), success: false };
        };
        if round.claim_status != ClaimStatus::InFlight {
            log!("on_prize_payment_complete: round {} not in flight", round_id.0);
            return ClaimResult { round_id, amount: U128(round.prize), success: false };
        }
        let amount = round.prize;
        self.ledger.in_flight = sub(self.ledger.in_flight, amount);
        if success {
            round.claim_status = ClaimStatus::Paid;
            self.ledger.prizes_outstanding = sub(self.ledger.prizes_outstanding, amount);
            let mut unpaid = self.unpaid_rounds_of(&round.winner);
            unpaid.retain(|id| *id != round_id.0);
            if unpaid.is_empty() {
                self.claimable.remove(&round.winner);
            } else {
                self.claimable.insert(round.winner.clone(), unpaid);
            }
            events::prize_claim(round_id.0, &round.winner, amount, "PAID");
        } else {
            round.claim_status = ClaimStatus::Available;
            events::prize_claim(round_id.0, &round.winner, amount, "FAILED");
        }
        self.rounds.insert(round_id.0, round);
        ClaimResult { round_id, amount: U128(amount), success }
    }

    /// Crown Economy V2: the platform (`platform_id` only) withdraws its 5% fee share.
    ///
    /// Only `ops_reserve` can be touched: never the market reserve, pots, credits or prizes.
    /// The amount leaves `ops_reserve` *before* the transfer promise, so a second request can only
    /// take what is left (no double withdrawal) and, while in flight, the obligation and the balance
    /// both dropped by the same amount (solvency stays exact). On a failed transfer the private
    /// callback puts it back. `amount = None` withdraws the whole share.
    #[payable]
    pub fn withdraw_platform_fees(&mut self, amount: Option<U128>) -> Promise {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "ERR_ONE_YOCTO");
        let caller = env::predecessor_account_id();
        require!(caller == self.platform_id, "ERR_FORBIDDEN");
        let available = self.ledger.ops_reserve;
        let amount = amount.map_or(available, |a| a.0);
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        require!(amount <= available, "ERR_INSUFFICIENT_PLATFORM_FEES");

        self.ledger.ops_reserve = sub(available, amount);
        events::platform_withdraw(&caller, amount, "IN_FLIGHT");

        let promise = Promise::new(caller)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                    .on_platform_withdraw_complete(U128(amount)),
            );
        self.assert_solvent();
        promise
    }

    /// Never panics. `#[private]`: only this contract's own promise can call it, with the amount it
    /// reserved, so a failure is restored exactly once.
    #[private]
    pub fn on_platform_withdraw_complete(&mut self, amount: U128) -> PlatformWithdrawResult {
        let success = transfer_succeeded();
        if success {
            events::platform_withdraw(&self.platform_id, amount.0, "PAID");
        } else {
            self.ledger.ops_reserve = add(self.ledger.ops_reserve, amount.0);
            events::platform_withdraw(&self.platform_id, amount.0, "FAILED");
        }
        PlatformWithdrawResult { amount, success }
    }
}
