//! Native-NEAR liability ledgers and fee allocation (docs/SPEC_V2.md §1.3, §1.6).
//!
//! Gate 0: constants only. Fee split and invariant checks are implemented on `feat/contracts`.

pub const BPS: u128 = 10_000;
pub const BUY_FEE_BPS: u128 = 400;
pub const SELL_FEE_BPS: u128 = 200;

pub const JACKPOT_SHARE: u128 = 7_000;
pub const NEXT_SEED_SHARE: u128 = 1_000;
pub const TREASURY_SHARE: u128 = 1_500;
pub const OPS_SHARE: u128 = 500;

const _: () = assert!(JACKPOT_SHARE + NEXT_SEED_SHARE + TREASURY_SHARE + OPS_SHARE == BPS);
const _: () = assert!(BUY_FEE_BPS < BPS && SELL_FEE_BPS < BPS);
