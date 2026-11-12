//! NEP-141 / NEP-145 / NEP-148 integration (docs/CONTRACT_API.md §4).
//!
//! Wraps `near_contract_standards::FungibleToken` with three LAST-specific guards:
//! - LAST cannot be `ft_transfer`-ed to the contract itself: the market inventory only changes
//!   through `buy`/`sell`, so it always matches the token ledger.
//! - `storage_unregister(force = true)` with a positive balance is refused: no burn path.
//! - Metadata is fixed in code; nothing can mint after `new`.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{env, log, near, require, AccountId, NearToken, PromiseOrValue};

use crate::{LastContract, LastContractExt, LAST_DECIMALS};

pub const TOKEN_NAME: &str = "LAST — Last Buyer Wins";
pub const TOKEN_SYMBOL: &str = "LAST";

impl LastContract {
    pub(crate) fn is_registered(&self, account_id: &AccountId) -> bool {
        self.token.accounts.contains_key(account_id)
    }

    pub(crate) fn last_balance_of(&self, account_id: &AccountId) -> u128 {
        self.token.accounts.get(account_id).unwrap_or(0)
    }

    /// `Y` of the market: LAST held by the contract's own account.
    pub(crate) fn market_inventory(&self) -> u128 {
        self.last_balance_of(&env::current_account_id())
    }
}

#[near]
impl FungibleTokenCore for LastContract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(receiver_id != env::current_account_id(), "ERR_USE_SELL");
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(receiver_id != env::current_account_id(), "ERR_USE_SELL");
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for LastContract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            // Only reachable if the sender unregistered (with a zero balance) while its
            // ft_transfer_call was in flight. Logged, not hidden.
            log!("Refund of {} LAST burned: sender {} unregistered", burned, sender_id);
        }
        used.into()
    }
}

#[near]
impl StorageManagement for LastContract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let account_id = env::predecessor_account_id();
        require!(account_id != env::current_account_id(), "ERR_FORBIDDEN");
        require!(self.last_balance_of(&account_id) == 0, "ERR_POSITIVE_BALANCE");
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for LastContract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: TOKEN_NAME.to_string(),
            symbol: TOKEN_SYMBOL.to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: LAST_DECIMALS,
        }
    }
}
