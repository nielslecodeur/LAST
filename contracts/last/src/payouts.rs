//! Pull payouts (docs/SPEC_V2.md §1.5, §2.2).
//!
//! Gate 1: sale-credit ledger only. `withdraw_near_credit`, `claim_reward` and their private
//! callbacks (AVAILABLE -> IN_FLIGHT -> PAID / AVAILABLE) land in Gate 2.

use near_sdk::{near, AccountId};

use crate::accounting::add;
use crate::LastContract;

/// NEAR owed to an account from its sells, in yoctoNEAR.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Credit {
    pub available: u128,
    pub in_flight: u128,
}

impl LastContract {
    pub(crate) fn credit_sale(&mut self, account_id: &AccountId, payout: u128) -> Credit {
        let mut credit = self.credits.get(account_id).cloned().unwrap_or_default();
        credit.available = add(credit.available, payout);
        self.credits.insert(account_id.clone(), credit.clone());
        self.ledger.credits_outstanding = add(self.ledger.credits_outstanding, payout);
        credit
    }
}
