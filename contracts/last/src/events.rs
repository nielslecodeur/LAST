//! NEP-297 JSON events (standard "last", version 1.0.0). See docs/CONTRACT_API.md §5.
//!
//! Events feed the UI activity list only; winner, pots and balances always come from views.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId};
use near_sdk::json_types::{U128, U64};

pub const EVENT_STANDARD: &str = "last";
pub const EVENT_VERSION: &str = "1.0.0";

fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[allow(clippy::too_many_arguments)]
pub fn buy(
    account_id: &AccountId,
    gross: u128,
    fee: u128,
    tokens_out: u128,
    eligible: bool,
    round_id: Option<u64>,
    deadline_ns: Option<u64>,
) {
    emit(
        "buy",
        json!({
            "account_id": account_id,
            "gross": U128(gross),
            "fee": U128(fee),
            "tokens_out": U128(tokens_out),
            "eligible": eligible,
            "round_id": round_id.map(U64),
            "deadline_ns": deadline_ns.map(U64),
        }),
    );
}

pub fn sell(account_id: &AccountId, tokens_in: u128, gross_near_out: u128, fee: u128, payout: u128) {
    emit(
        "sell",
        json!({
            "account_id": account_id,
            "tokens_in": U128(tokens_in),
            "gross_near_out": U128(gross_near_out),
            "fee": U128(fee),
            "payout": U128(payout),
        }),
    );
}

pub fn round_started(round_id: u64, seed: u128, started_at_ns: u64) {
    emit(
        "round_started",
        json!({
            "round_id": U64(round_id),
            "seed": U128(seed),
            "started_at_ns": U64(started_at_ns),
        }),
    );
}
