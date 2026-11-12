//! LAST — Last Buyer Wins.
//!
//! One contract: NEP-141 token + internal NEAR/LAST constant-product market + last-buyer round game.
//! Interface: docs/CONTRACT_API.md. Engineering contract: docs/SPEC_V2.md.
//!
//! Gate 0 skeleton: modules and constants only, no state or methods yet.

pub mod accounting;
pub mod events;
pub mod game;
pub mod market;
pub mod payouts;
pub mod token;

/// 1,000,000 LAST with 18 decimals, minted once in `new`.
pub const TOTAL_SUPPLY: u128 = 1_000_000 * 10u128.pow(18);
pub const LAST_DECIMALS: u8 = 18;
pub const ONE_NEAR: u128 = 10u128.pow(24);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_supply_is_ten_pow_24() {
        assert_eq!(TOTAL_SUPPLY, 10u128.pow(24));
    }
}
