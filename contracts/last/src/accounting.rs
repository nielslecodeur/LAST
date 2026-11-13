//! Native-NEAR liability ledgers and fee allocation (docs/SPEC_V2.md §1.3, §1.6).
//!
//! Every yoctoNEAR the contract owes is in exactly one bucket of [`Ledger`]. Fees are split with
//! integer floors and the remainder goes to the treasury, so `split_fee(f).total() == f` always.
//!
//! Crown Economy V2 (docs/LAST_Crown_Economy_Tokenomics_V2.md, model C): 85% current jackpot,
//! 10% next-round starting pot, 0% treasury, 5% platform. The treasury share is 0: it only
//! receives the integer-division remainder (at most 2 yoctoNEAR per fee), per the project rule
//! "remainders go to the treasury bucket". The platform share is withdrawable by `platform_id`
//! (payouts.rs `withdraw_platform_fees`); in V1 it was locked forever.

use near_sdk::near;

use crate::market::mul_div;

pub const BPS: u128 = 10_000;
pub const BUY_FEE_BPS: u128 = 400;
pub const SELL_FEE_BPS: u128 = 200;

/// Identifier of the fee model, exposed by `get_economics`.
pub const ECONOMICS_MODEL: &str = "crown-economy-v2";

pub const JACKPOT_SHARE: u128 = 8_500;
pub const NEXT_SEED_SHARE: u128 = 1_000;
pub const TREASURY_SHARE: u128 = 0;
pub const OPS_SHARE: u128 = 500;

const _: () = assert!(JACKPOT_SHARE + NEXT_SEED_SHARE + TREASURY_SHARE + OPS_SHARE == BPS);
const _: () = assert!(BUY_FEE_BPS < BPS && SELL_FEE_BPS < BPS);

/// `floor(amount * bps / BPS)` without overflow.
pub fn fee_of(amount: u128, bps: u128) -> u128 {
    mul_div(amount, bps, BPS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeSplit {
    pub jackpot: u128,
    pub next_seed: u128,
    pub treasury: u128,
    pub ops: u128,
}

impl FeeSplit {
    pub fn total(&self) -> u128 {
        self.jackpot + self.next_seed + self.treasury + self.ops
    }
}

/// 85 / 10 / 0 / 5 split of a fee; rounding remainder → treasury.
pub fn split_fee(fee: u128) -> FeeSplit {
    let jackpot = mul_div(fee, JACKPOT_SHARE, BPS);
    let next_seed = mul_div(fee, NEXT_SEED_SHARE, BPS);
    let ops = mul_div(fee, OPS_SHARE, BPS);
    // Cannot underflow: each floor(fee * s / BPS) <= fee * s / BPS and the shares sum to BPS.
    // TREASURY_SHARE is 0, so the treasury gets exactly the rounding remainder.
    let treasury = fee - jackpot - next_seed - ops;
    FeeSplit { jackpot, next_seed, treasury, ops }
}

/// Native-NEAR obligations of the contract, all in yoctoNEAR.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ledger {
    /// `X` of the x*y=k market. Only buy/sell move it.
    pub market_near_reserve: u128,
    /// Jackpot of the current round (0 when IDLE).
    pub active_pot: u128,
    /// Seed waiting for the next round.
    pub next_seed_pot: u128,
    pub treasury_reserve: u128,
    pub ops_reserve: u128,
    /// Sale credits not yet paid (available + in flight).
    pub credits_outstanding: u128,
    /// Settled prizes not yet paid (available + in flight).
    pub prizes_outstanding: u128,
    /// Part of `credits_outstanding + prizes_outstanding` already sent by a transfer promise whose
    /// callback has not run. The runtime deducts it from the balance when the promise is created,
    /// but it stays an obligation until success is confirmed (it comes back on failure).
    pub in_flight: u128,
}

impl Ledger {
    /// Credit a trading fee. `round_active` must be decided *before* the call (SPEC §1.3):
    /// ACTIVE → jackpot share to the live pot; IDLE → jackpot + next-seed shares to the next seed.
    pub fn allocate_fee(&mut self, fee: u128, round_active: bool) -> FeeSplit {
        let split = split_fee(fee);
        if round_active {
            self.active_pot = add(self.active_pot, split.jackpot);
            self.next_seed_pot = add(self.next_seed_pot, split.next_seed);
        } else {
            self.next_seed_pot = add(self.next_seed_pot, add(split.jackpot, split.next_seed));
        }
        self.treasury_reserve = add(self.treasury_reserve, split.treasury);
        self.ops_reserve = add(self.ops_reserve, split.ops);
        split
    }

    /// Sum of every named obligation.
    pub fn total_obligations(&self) -> u128 {
        [
            self.market_near_reserve,
            self.active_pot,
            self.next_seed_pot,
            self.treasury_reserve,
            self.ops_reserve,
            self.credits_outstanding,
            self.prizes_outstanding,
        ]
        .into_iter()
        .fold(0, add)
    }
}

pub fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| near_sdk::env::panic_str("ERR_OVERFLOW"))
}

pub fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).unwrap_or_else(|| near_sdk::env::panic_str("ERR_UNDERFLOW"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readme_example_one_near_buy() {
        let one_near = 10u128.pow(24);
        let fee = fee_of(one_near, BUY_FEE_BPS);
        assert_eq!(fee, 4 * 10u128.pow(22)); // 0.04 NEAR
        let s = split_fee(fee);
        // Crown Economy V2 example (doc §3): 0.034 / 0.004 / 0 / 0.002
        assert_eq!(s.jackpot, 34 * 10u128.pow(21)); // 0.034
        assert_eq!(s.next_seed, 4 * 10u128.pow(21)); // 0.004
        assert_eq!(s.treasury, 0);
        assert_eq!(s.ops, 2 * 10u128.pow(21)); // 0.002
    }

    #[test]
    fn readme_example_one_near_sell() {
        let one_near = 10u128.pow(24);
        let fee = fee_of(one_near, SELL_FEE_BPS);
        assert_eq!(one_near - fee, 98 * 10u128.pow(22)); // seller gets 0.98
        let s = split_fee(fee);
        assert_eq!(
            (s.jackpot, s.next_seed, s.treasury, s.ops),
            (17 * 10u128.pow(21), 2 * 10u128.pow(21), 0, 10u128.pow(21))
        );
    }

    #[test]
    fn remainder_goes_to_treasury_and_is_conserved() {
        for fee in [0u128, 1, 2, 3, 7, 9, 13, 19, 99, 10_001, 123_456_789, u128::MAX] {
            let s = split_fee(fee);
            assert_eq!(s.total(), fee, "fee {fee}");
            assert_eq!(s.jackpot, fee / 10_000 * 8_500 + (fee % 10_000) * 8_500 / 10_000);
            // Treasury share is 0: it only ever holds the remainder of the three floors.
            assert!(s.treasury <= 2, "fee {fee}: treasury {}", s.treasury);
        }
        // fee = 1: everything floors to 0 except treasury.
        assert_eq!(split_fee(1), FeeSplit { jackpot: 0, next_seed: 0, treasury: 1, ops: 0 });
    }

    #[test]
    fn fee_of_large_amount_does_not_overflow() {
        assert_eq!(fee_of(u128::MAX, BUY_FEE_BPS), (u128::MAX / 10_000) * 400 + (u128::MAX % 10_000) * 400 / 10_000);
    }

    #[test]
    fn idle_fee_goes_to_next_seed() {
        let mut l = Ledger::default();
        let s = l.allocate_fee(1_000_000, false);
        assert_eq!(l.active_pot, 0);
        assert_eq!(l.next_seed_pot, s.jackpot + s.next_seed);
        assert_eq!(l.total_obligations(), 1_000_000);
    }

    #[test]
    fn active_fee_goes_to_pot() {
        let mut l = Ledger::default();
        l.allocate_fee(1_000_000, true);
        assert_eq!(l.active_pot, 850_000);
        assert_eq!(l.next_seed_pot, 100_000);
        assert_eq!(l.treasury_reserve, 0);
        assert_eq!(l.ops_reserve, 50_000);
    }
}
