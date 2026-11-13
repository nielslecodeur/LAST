//! Play balance (v0.4): trade without a wallet popup per trade.
//!
//! The play balance IS the existing NEAR credit (`credits[account].available`, counted in
//! `credits_outstanding`). It is filled by `deposit_balance` (wallet, attached NEAR) and by sells,
//! spent by `buy_from_balance`, and leaves the contract only through `withdraw_near_credit`
//! (1 yocto, wallet) to the account itself.
//!
//! `buy_from_balance` and `sell_to_balance` take no deposit, so a NEAR function-call access key
//! limited to this contract (the web app's session key) can call them. Such a key can therefore
//! trade the owner's balance and tokens, but never move NEAR or LAST to anyone else.

use near_sdk::json_types::U128;
use near_sdk::{env, near, require};

use crate::accounting::sub;
use crate::market::{BuyResult, SellResult};
use crate::payouts::Credit;
use crate::{events, LastContract, LastContractExt};

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepositResult {
    pub amount: U128,
    pub credit_available: U128,
}

#[near]
impl LastContract {
    /// Adds the attached NEAR to the caller's play balance. Registration (NEP-145) is required.
    #[payable]
    pub fn deposit_balance(&mut self) -> DepositResult {
        let account_id = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "ERR_ZERO_DEPOSIT");
        require!(account_id != env::current_account_id(), "ERR_FORBIDDEN");
        require!(self.is_registered(&account_id), "ERR_NOT_REGISTERED");
        let credit = self.credit_sale(&account_id, amount);
        events::balance_deposit(&account_id, amount);
        self.assert_solvent();
        DepositResult { amount: U128(amount), credit_available: U128(credit.available) }
    }

    /// Buy with `amount` yoctoNEAR taken from the caller's play balance. Same rules, fees, crown and
    /// timer logic as `buy` (`amount` is the gross, eligibility compares it to `min_eligible_buy`).
    pub fn buy_from_balance(&mut self, amount: U128, min_tokens_out: U128) -> BuyResult {
        let buyer = env::predecessor_account_id();
        let amount = amount.0;
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let mut credit: Credit = self.credits.get(&buyer).cloned().unwrap_or_default();
        require!(credit.available >= amount, "ERR_INSUFFICIENT_BALANCE_NEAR");
        // Debit first: the NEAR stops being owed to the buyer and becomes the trade's gross.
        credit.available -= amount;
        if credit == Credit::default() {
            self.credits.remove(&buyer);
        } else {
            self.credits.insert(buyer.clone(), credit);
        }
        self.ledger.credits_outstanding = sub(self.ledger.credits_outstanding, amount);
        self.internal_buy(buyer, amount, min_tokens_out.0)
    }

    /// `sell` without the 1 yocto, for the session key. Proceeds go to the caller's play balance.
    pub fn sell_to_balance(&mut self, tokens_in: U128, min_near_out: U128) -> SellResult {
        self.internal_sell(env::predecessor_account_id(), tokens_in.0, min_near_out.0)
    }
}
