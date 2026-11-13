//! LAST — Last Buyer Wins.
//!
//! One contract: NEP-141 token + internal NEAR/LAST constant-product market + last-buyer round game.
//! Interface: docs/CONTRACT_API.md. Engineering contract: docs/SPEC_V2.md.

pub mod accounting;
pub mod events;
pub mod game;
pub mod market;
pub mod payouts;
pub mod token;

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

use accounting::{add, Ledger};
use game::{Round, SettledRound};
use payouts::Credit;

/// 1,000,000 LAST with 18 decimals, minted once in `new`.
pub const TOTAL_SUPPLY: u128 = 1_000_000 * 10u128.pow(18);
pub const LAST_DECIMALS: u8 = 18;
pub const ONE_NEAR: u128 = 10u128.pow(24);

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    Credits,
    Rounds,
    Claimable,
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct InitConfig {
    pub owner_id: AccountId,
    pub treasury_id: AccountId,
    pub platform_id: AccountId,
    pub round_duration_ns: U64,
    pub min_eligible_buy: U128,
    pub seed_near: U128,
}

#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default)]
pub struct MarketTotals {
    /// Gross NEAR attached to buys.
    pub buy_volume: u128,
    /// Gross NEAR out of the reserve on sells (before the sell fee).
    pub sell_volume: u128,
    pub buy_count: u64,
    pub sell_count: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct LastContract {
    pub(crate) token: FungibleToken,
    /// Recorded for disclosure. No owner method can change leader, deadline, fees, supply or reserves.
    pub(crate) owner_id: AccountId,
    pub(crate) treasury_id: AccountId,
    pub(crate) platform_id: AccountId,
    pub(crate) round_duration_ns: u64,
    pub(crate) min_eligible_buy: u128,
    pub(crate) ledger: Ledger,
    /// Id of the current round when ACTIVE/EXPIRED, or of the next round when IDLE. Starts at 1.
    pub(crate) round_id: u64,
    pub(crate) current_round: Option<Round>,
    pub(crate) last_settled_round_id: Option<u64>,
    pub(crate) credits: LookupMap<AccountId, Credit>,
    /// Settled rounds by id (one small record per round).
    pub(crate) rounds: LookupMap<u64, SettledRound>,
    /// Winner -> settled round ids whose prize is not PAID yet.
    pub(crate) claimable: LookupMap<AccountId, Vec<u64>>,
    pub(crate) totals: MarketTotals,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketStateView {
    pub near_reserve: U128,
    pub last_inventory: U128,
    pub total_buy_volume: U128,
    pub total_sell_volume: U128,
    pub buy_count: U64,
    pub sell_count: U64,
    pub treasury_reserve: U128,
    pub ops_reserve: U128,
    pub buy_fee_bps: u16,
    pub sell_fee_bps: u16,
    pub min_eligible_buy: U128,
    pub round_duration_ns: U64,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountStateView {
    pub registered: bool,
    pub last_balance: U128,
    pub credit_available: U128,
    pub credit_in_flight: U128,
    pub claimable_rounds: Vec<U64>,
}

/// Fee model, read from the chain by the frontend instead of hard-coding the split.
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EconomicsView {
    pub model: String,
    pub buy_fee_bps: u16,
    pub sell_fee_bps: u16,
    /// Shares of each fee, in bps of the fee; they sum to 10000.
    pub jackpot_bps: u16,
    pub next_seed_bps: u16,
    pub treasury_bps: u16,
    pub platform_bps: u16,
    /// Bucket receiving the integer-division remainder.
    pub remainder_to: String,
    /// Whether `platform_id` can withdraw the platform share (`withdraw_platform_fees`).
    pub platform_withdrawable: bool,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolesView {
    pub owner_id: AccountId,
    pub treasury_id: AccountId,
    pub platform_id: AccountId,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrityView {
    pub account_balance: U128,
    pub storage_cost: U128,
    pub total_obligations: U128,
    pub market_near_reserve: U128,
    pub active_pot: U128,
    pub next_seed_pot: U128,
    pub treasury_reserve: U128,
    pub ops_reserve: U128,
    pub credits_outstanding: U128,
    pub prizes_outstanding: U128,
    /// Sent by a transfer promise, callback pending (subset of credits + prizes).
    pub in_flight: U128,
    /// `account_balance + in_flight - storage_cost - total_obligations`; never negative.
    pub surplus: U128,
}

#[near]
impl LastContract {
    /// One-time init. Attached deposit must equal `seed_near` and becomes the market NEAR reserve.
    /// Storage staking must already be covered by the contract account's own balance.
    #[init]
    #[payable]
    pub fn new(config: InitConfig) -> Self {
        let seed = config.seed_near.0;
        require!(
            env::attached_deposit().as_yoctonear() == seed,
            "ERR_BAD_SEED_DEPOSIT"
        );
        require!(
            seed > 0 && config.round_duration_ns.0 > 0 && config.min_eligible_buy.0 > 0,
            "ERR_BAD_CONFIG"
        );

        let me = env::current_account_id();
        let mut token = FungibleToken::new(StorageKey::Token);
        token.internal_register_account(&me);
        token.internal_deposit(&me, TOTAL_SUPPLY);
        FtMint { owner_id: &me, amount: U128(TOTAL_SUPPLY), memo: Some("LAST one-time mint") }
            .emit();

        let this = Self {
            token,
            owner_id: config.owner_id,
            treasury_id: config.treasury_id,
            platform_id: config.platform_id,
            round_duration_ns: config.round_duration_ns.0,
            min_eligible_buy: config.min_eligible_buy.0,
            ledger: Ledger { market_near_reserve: seed, ..Default::default() },
            round_id: 1,
            current_round: None,
            last_settled_round_id: None,
            credits: LookupMap::new(StorageKey::Credits),
            rounds: LookupMap::new(StorageKey::Rounds),
            claimable: LookupMap::new(StorageKey::Claimable),
            totals: MarketTotals::default(),
        };
        this.assert_solvent();
        this
    }

    pub fn get_market_state(&self) -> MarketStateView {
        MarketStateView {
            near_reserve: U128(self.ledger.market_near_reserve),
            last_inventory: U128(self.market_inventory()),
            total_buy_volume: U128(self.totals.buy_volume),
            total_sell_volume: U128(self.totals.sell_volume),
            buy_count: U64(self.totals.buy_count),
            sell_count: U64(self.totals.sell_count),
            treasury_reserve: U128(self.ledger.treasury_reserve),
            ops_reserve: U128(self.ledger.ops_reserve),
            buy_fee_bps: accounting::BUY_FEE_BPS as u16,
            sell_fee_bps: accounting::SELL_FEE_BPS as u16,
            min_eligible_buy: U128(self.min_eligible_buy),
            round_duration_ns: U64(self.round_duration_ns),
        }
    }

    pub fn get_account_state(&self, account_id: AccountId) -> AccountStateView {
        let credit = self.credits.get(&account_id).cloned().unwrap_or_default();
        AccountStateView {
            registered: self.is_registered(&account_id),
            last_balance: U128(self.last_balance_of(&account_id)),
            credit_available: U128(credit.available),
            credit_in_flight: U128(credit.in_flight),
            claimable_rounds: self.unpaid_rounds_of(&account_id).into_iter().map(U64).collect()
        }
    }

    pub fn get_economics(&self) -> EconomicsView {
        EconomicsView {
            model: accounting::ECONOMICS_MODEL.to_string(),
            buy_fee_bps: accounting::BUY_FEE_BPS as u16,
            sell_fee_bps: accounting::SELL_FEE_BPS as u16,
            jackpot_bps: accounting::JACKPOT_SHARE as u16,
            next_seed_bps: accounting::NEXT_SEED_SHARE as u16,
            treasury_bps: accounting::TREASURY_SHARE as u16,
            platform_bps: accounting::OPS_SHARE as u16,
            remainder_to: "treasury".to_string(),
            platform_withdrawable: true,
        }
    }

    /// Disclosed roles. None of them can change game outcome, fees, supply or reserves. The only
    /// privileged call is `platform_id` withdrawing the platform fee share (`ops_reserve`).
    pub fn get_roles(&self) -> RolesView {
        RolesView {
            owner_id: self.owner_id.clone(),
            treasury_id: self.treasury_id.clone(),
            platform_id: self.platform_id.clone(),
        }
    }

    /// Real account balance vs every named obligation (SPEC §1.6). For demo reconciliation.
    pub fn get_integrity(&self) -> IntegrityView {
        let balance = env::account_balance().as_yoctonear();
        let storage = Self::storage_cost();
        let total = self.ledger.total_obligations();
        let l = &self.ledger;
        IntegrityView {
            account_balance: U128(balance),
            storage_cost: U128(storage),
            total_obligations: U128(total),
            market_near_reserve: U128(l.market_near_reserve),
            active_pot: U128(l.active_pot),
            next_seed_pot: U128(l.next_seed_pot),
            treasury_reserve: U128(l.treasury_reserve),
            ops_reserve: U128(l.ops_reserve),
            credits_outstanding: U128(l.credits_outstanding),
            prizes_outstanding: U128(l.prizes_outstanding),
            in_flight: U128(l.in_flight),
            surplus: U128(add(balance, l.in_flight).saturating_sub(add(storage, total))),
        }
    }
}

impl LastContract {
    fn storage_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage())
    }

    /// Balance must cover storage staking plus every named obligation (SPEC §1.6). NEAR sent by a
    /// pending transfer promise has already left the balance but is still owed (or comes back), so
    /// it is counted on the balance side.
    pub(crate) fn assert_solvent(&self) {
        let need = add(self.ledger.total_obligations(), Self::storage_cost());
        let have = add(env::account_balance().as_yoctonear(), self.ledger.in_flight);
        require!(have >= need, "ERR_INSOLVENT");
    }
}

#[cfg(test)]
mod tests;
