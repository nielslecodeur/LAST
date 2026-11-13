//! Constant-product (x*y=k) NEAR/LAST market math (docs/SPEC_V2.md §1.4, §1.5).
//!
//! Pure functions over reserves: no state, no `env`. All products use 256-bit intermediates and
//! every division floors, which always rounds in favour of the reserves.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, NearToken};

use crate::accounting::{add, fee_of, sub, BUY_FEE_BPS, SELL_FEE_BPS};
use crate::game::Status;
use crate::{events, LastContract, LastContractExt};

uint::construct_uint! {
    pub struct U256(4);
}

/// `floor(a * b / c)` with a 256-bit product. Panics if `c == 0` or the result exceeds `u128`.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    mul_div_wide(U256::from(a), U256::from(b), U256::from(c))
}

fn mul_div_wide(a: U256, b: U256, c: U256) -> u128 {
    if c.is_zero() {
        near_sdk::env::panic_str("ERR_DIV_ZERO");
    }
    // a, b < 2^128 at every call site, so a * b < 2^256.
    let q = a * b / c;
    if q > U256::from(u128::MAX) {
        near_sdk::env::panic_str("ERR_OVERFLOW");
    }
    q.as_u128()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuyQuote {
    pub fee: u128,
    pub net_near: u128,
    pub tokens_out: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SellQuote {
    pub gross_near_out: u128,
    pub fee: u128,
    pub payout: u128,
}

/// Buy with `gross` yoctoNEAR against reserves `x` (NEAR) / `y` (LAST).
/// `fee = floor(gross * 4%)`, `net = gross - fee`, `tokens_out = floor(y * net / (x + net))`.
pub fn calc_buy(x: u128, y: u128, gross: u128) -> BuyQuote {
    let fee = fee_of(gross, BUY_FEE_BPS);
    let net_near = gross - fee;
    let denom = U256::from(x) + U256::from(net_near);
    let tokens_out = if denom.is_zero() {
        0
    } else {
        mul_div_wide(U256::from(y), U256::from(net_near), denom)
    };
    BuyQuote { fee, net_near, tokens_out }
}

/// Sell `tokens_in` atomic LAST against reserves `x` / `y`.
/// `gross = floor(x * tokens_in / (y + tokens_in))`, `fee = floor(gross * 2%)`, `payout = gross - fee`.
pub fn calc_sell(x: u128, y: u128, tokens_in: u128) -> SellQuote {
    let denom = U256::from(y) + U256::from(tokens_in);
    let gross_near_out = if denom.is_zero() {
        0
    } else {
        mul_div_wide(U256::from(x), U256::from(tokens_in), denom)
    };
    let fee = fee_of(gross_near_out, SELL_FEE_BPS);
    SellQuote { gross_near_out, fee, payout: gross_near_out - fee }
}

// ---------------------------------------------------------------------------------------------
// Contract entry points
// ---------------------------------------------------------------------------------------------

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuyResult {
    pub tokens_out: U128,
    pub fee: U128,
    pub eligible: bool,
    pub round_id: U64,
    pub leader: Option<AccountId>,
    pub deadline_ns: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellResult {
    pub gross_near_out: U128,
    pub fee: U128,
    pub payout: U128,
    pub credit_available: U128,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuyQuoteView {
    pub tokens_out: U128,
    pub fee: U128,
    pub net_near: U128,
    pub eligible: bool,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellQuoteView {
    pub gross_near_out: U128,
    pub fee: U128,
    pub payout: U128,
}

#[near]
impl LastContract {
    /// Buy LAST with the attached NEAR. Trade, fee allocation and leader/deadline update happen in
    /// one state transition (SPEC §1.4).
    #[payable]
    pub fn buy(&mut self, min_tokens_out: U128) -> BuyResult {
        let gross = env::attached_deposit().as_yoctonear();
        require!(gross > 0, "ERR_ZERO_DEPOSIT");
        self.internal_buy(env::predecessor_account_id(), gross, min_tokens_out.0)
    }

    /// Sell LAST from the caller's own balance. Proceeds become a withdrawable NEAR credit; no NEAR
    /// is sent here (SPEC §1.5). Never touches leader or deadline.
    #[payable]
    pub fn sell(&mut self, tokens_in: U128, min_near_out: U128) -> SellResult {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "ERR_ONE_YOCTO");
        self.internal_sell(env::predecessor_account_id(), tokens_in.0, min_near_out.0)
    }

    /// Same integer math as `buy` against current reserves. Never panics on small amounts.
    pub fn quote_buy(&self, gross_near: U128) -> BuyQuoteView {
        let q = calc_buy(self.ledger.market_near_reserve, self.market_inventory(), gross_near.0);
        BuyQuoteView {
            tokens_out: U128(q.tokens_out),
            fee: U128(q.fee),
            net_near: U128(q.net_near),
            eligible: gross_near.0 >= self.min_eligible_buy,
        }
    }

    pub fn quote_sell(&self, tokens_in: U128) -> SellQuoteView {
        let q = calc_sell(self.ledger.market_near_reserve, self.market_inventory(), tokens_in.0);
        SellQuoteView {
            gross_near_out: U128(q.gross_near_out),
            fee: U128(q.fee),
            payout: U128(q.payout),
        }
    }
}

impl LastContract {
    /// Shared buy path: `buy` (attached NEAR) and `buy_from_balance` (play balance). The `gross`
    /// NEAR is already held by the contract and no longer counted as an obligation when this runs.
    pub(crate) fn internal_buy(&mut self, buyer: AccountId, gross: u128, min_tokens_out: u128) -> BuyResult {
        let me = env::current_account_id();
        let now = env::block_timestamp();

        require!(gross > 0, "ERR_ZERO_DEPOSIT");
        require!(buyer != me, "ERR_FORBIDDEN");
        require!(self.is_registered(&buyer), "ERR_NOT_REGISTERED");
        let status = self.status_at(now);
        require!(status != Status::Expired, "ERR_ROUND_EXPIRED");

        let y = self.market_inventory();
        let q = calc_buy(self.ledger.market_near_reserve, y, gross);
        require!(q.tokens_out > 0, "ERR_ZERO_OUTPUT");
        require!(q.tokens_out >= min_tokens_out, "ERR_SLIPPAGE");
        require!(q.tokens_out < y, "ERR_INSUFFICIENT_LIQUIDITY");

        // Decide eligibility and round start *before* allocating this trade's fee (SPEC §1.3).
        let eligible = gross >= self.min_eligible_buy;
        if eligible && status == Status::Idle {
            self.start_round(&buyer, now);
        }
        let round_active = self.current_round.is_some();
        self.ledger.allocate_fee(q.fee, round_active);
        if eligible {
            self.record_qualifying_buy(&buyer, now);
        }

        self.ledger.market_near_reserve = add(self.ledger.market_near_reserve, q.net_near);
        self.token.internal_transfer(&me, &buyer, q.tokens_out, None);
        self.totals.buy_volume = add(self.totals.buy_volume, gross);
        self.totals.buy_count += 1;

        let round = self.current_round.as_ref();
        let deadline = round.map(|r| r.deadline_ns);
        events::buy(
            &buyer,
            gross,
            q.fee,
            q.tokens_out,
            eligible,
            round.map(|_| self.round_id),
            deadline,
        );
        self.assert_solvent();

        BuyResult {
            tokens_out: U128(q.tokens_out),
            fee: U128(q.fee),
            eligible,
            round_id: U64(self.round_id),
            leader: round.map(|r| r.leader.clone()),
            deadline_ns: deadline.map(U64),
        }
    }

    /// Shared sell path: `sell` (1 yocto, wallet) and `sell_to_balance` (session key).
    pub(crate) fn internal_sell(&mut self, seller: AccountId, tokens_in: u128, min_near_out: u128) -> SellResult {
        let me = env::current_account_id();

        require!(seller != me, "ERR_FORBIDDEN");
        require!(tokens_in > 0, "ERR_ZERO_AMOUNT");
        require!(self.is_registered(&seller), "ERR_NOT_REGISTERED");
        require!(self.last_balance_of(&seller) >= tokens_in, "ERR_INSUFFICIENT_BALANCE");
        require!(
            self.status_at(env::block_timestamp()) != Status::Expired,
            "ERR_ROUND_EXPIRED"
        );

        let x = self.ledger.market_near_reserve;
        let q = calc_sell(x, self.market_inventory(), tokens_in);
        require!(q.payout > 0, "ERR_ZERO_OUTPUT");
        require!(q.payout >= min_near_out, "ERR_SLIPPAGE");
        require!(q.gross_near_out < x, "ERR_INSUFFICIENT_LIQUIDITY");

        self.ledger.market_near_reserve = sub(x, q.gross_near_out);
        self.token.internal_transfer(&seller, &me, tokens_in, None);
        let round_active = self.current_round.is_some();
        self.ledger.allocate_fee(q.fee, round_active);
        let credit = self.credit_sale(&seller, q.payout);
        self.totals.sell_volume = add(self.totals.sell_volume, q.gross_near_out);
        self.totals.sell_count += 1;

        events::sell(&seller, tokens_in, q.gross_near_out, q.fee, q.payout);
        self.assert_solvent();

        SellResult {
            gross_near_out: U128(q.gross_near_out),
            fee: U128(q.fee),
            payout: U128(q.payout),
            credit_available: U128(credit.available),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const X0: u128 = 3 * NEAR;
    const Y0: u128 = 1_000_000 * 1_000_000_000_000_000_000; // 10^24

    #[test]
    fn mul_div_floors_and_handles_wide_products() {
        assert_eq!(mul_div(7, 3, 2), 10);
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
        assert_eq!(mul_div(u128::MAX, 2, 4), u128::MAX / 2);
    }

    #[test]
    #[should_panic(expected = "ERR_OVERFLOW")]
    fn mul_div_rejects_u128_overflow() {
        mul_div(u128::MAX, 2, 1);
    }

    #[test]
    #[should_panic(expected = "ERR_DIV_ZERO")]
    fn mul_div_rejects_zero_divisor() {
        mul_div(1, 1, 0);
    }

    #[test]
    fn demo_min_buy_quote() {
        // 0.03 NEAR into the 3 NEAR / 1M LAST demo pool.
        let gross = 3 * NEAR / 100;
        let q = calc_buy(X0, Y0, gross);
        assert_eq!(q.fee, 12 * 10u128.pow(20)); // 0.0012 NEAR
        assert_eq!(q.net_near, gross - q.fee);
        assert_eq!(q.tokens_out, mul_div(Y0, q.net_near, X0 + q.net_near));
        // Fee + 1% price impact: ~9,508.7 LAST instead of gross / spot = 10,000 LAST.
        assert!(q.tokens_out < 10_000 * 10u128.pow(18));
        assert!(q.tokens_out > 9_508 * 10u128.pow(18));
        assert!(q.tokens_out < 9_509 * 10u128.pow(18));
    }

    #[test]
    fn buy_never_increases_k_rounding_favours_pool() {
        for gross in [1u128, 26, 1_000, NEAR / 1000, NEAR, 50 * NEAR, 10_000 * NEAR] {
            let q = calc_buy(X0, Y0, gross);
            let k_before = U256::from(X0) * U256::from(Y0);
            let k_after = U256::from(X0 + q.net_near) * U256::from(Y0 - q.tokens_out);
            assert!(k_after >= k_before, "k decreased for gross {gross}");
            assert!(q.tokens_out < Y0);
            assert_eq!(q.fee + q.net_near, gross);
        }
    }

    #[test]
    fn sell_never_decreases_k_and_never_drains() {
        for tokens_in in [1u128, 10u128.pow(18), Y0 / 100, Y0, 1000 * Y0] {
            let q = calc_sell(X0, Y0, tokens_in);
            let k_before = U256::from(X0) * U256::from(Y0);
            let k_after = U256::from(X0 - q.gross_near_out) * U256::from(Y0 + tokens_in);
            assert!(k_after >= k_before);
            assert!(q.gross_near_out < X0);
            assert_eq!(q.fee + q.payout, q.gross_near_out);
        }
    }

    #[test]
    fn dust_produces_zero_output() {
        // 1 yoctoNEAR buy: fee 0, net 1, out = floor(10^24 / (3*10^24 + 1)) = 0.
        assert_eq!(calc_buy(X0, Y0, 1).tokens_out, 0);
        assert_eq!(calc_buy(X0, Y0, 0), BuyQuote { fee: 0, net_near: 0, tokens_out: 0 });
        assert_eq!(calc_sell(X0, Y0, 0).payout, 0);
    }

    #[test]
    fn round_trip_loses_fees() {
        let gross = NEAR;
        let b = calc_buy(X0, Y0, gross);
        let s = calc_sell(X0 + b.net_near, Y0 - b.tokens_out, b.tokens_out);
        assert!(s.payout < gross);
        // Sell returns the net back (minus rounding) before the 2% sell fee.
        assert!(s.gross_near_out <= b.net_near);
        assert!(b.net_near - s.gross_near_out <= 1);
    }

    #[test]
    fn extreme_reserves_do_not_overflow() {
        let q = calc_buy(u128::MAX / 2, u128::MAX, u128::MAX / 2);
        assert!(q.tokens_out > 0);
        let s = calc_sell(u128::MAX, u128::MAX / 2, u128::MAX / 2);
        assert!(s.gross_near_out > 0);
    }
}
