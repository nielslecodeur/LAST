//! $LAST jackpot contract (mainnet "Nearly" architecture).
//!
//! The $LAST token is launched on the Nearly launchpad and trades in its Rhea pool. Nearly sends
//! the pool fees and the buy/sell tax to this contract's account every few minutes, as plain NEAR
//! transfers. A transfer does not say who bought, so a **reporter** account (an off-chain bot that
//! reads the pool's swaps) calls `record_buy` for every buy of at least `min_eligible_buy` NEAR,
//! with the transaction hash so anyone can check it on an explorer.
//!
//! Game rules enforced here:
//! - an eligible buy takes the crown and resets the deadline to `buy time + round_duration`;
//! - once the deadline has passed (plus a short grace period so late reports still count), anyone
//!   can call `settle_round`: `winner_share_bps` of the available pot is sent to the winner
//!   automatically; the rest stays in the contract as the next round's starting pot;
//! - a failed transfer leaves the prize AVAILABLE and the winner can `claim_reward`.
//!
//! Trust model (disclosed): the reporter decides which buys are recorded. It cannot move funds.
//! The owner can only replace the reporter. Nobody can withdraw the pot except by winning.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

pub const BPS: u128 = 10_000;
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_UNWRAP: Gas = Gas::from_tgas(10);
const MAX_TX_HASH_LEN: usize = 64;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Rounds,
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct InitConfig {
    pub owner_id: AccountId,
    pub reporter_id: AccountId,
    /// The $LAST token contract on Nearly (informational, shown in views).
    pub token_id: AccountId,
    /// `wrap.near` on mainnet: fees that arrive as wNEAR can be unwrapped into the pot.
    pub wrap_id: AccountId,
    pub round_duration_ns: U64,
    pub min_eligible_buy: U128,
    /// Share of the available pot paid to a round's winner (e.g. 9000 = 90%).
    pub winner_share_bps: u16,
    /// Extra time after a deadline before settlement, so a late report of an in-time buy still counts.
    pub settle_grace_ns: U64,
    /// NEAR kept aside for storage growth; never paid out.
    pub reserve_floor: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayoutStatus {
    #[serde(rename = "AVAILABLE")]
    Available,
    #[serde(rename = "IN_FLIGHT")]
    InFlight,
    #[serde(rename = "PAID")]
    Paid,
}

#[near(serializers = [borsh])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Round {
    pub leader: AccountId,
    pub started_at_ns: u64,
    pub deadline_ns: u64,
    pub eligible_buys: u32,
    pub last_tx_hash: String,
}

#[near(serializers = [borsh])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledRound {
    pub winner: AccountId,
    pub prize: u128,
    pub started_at_ns: u64,
    pub ended_at_ns: u64,
    pub eligible_buys: u32,
    pub winning_tx_hash: String,
    pub status: PayoutStatus,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PotContract {
    owner_id: AccountId,
    reporter_id: AccountId,
    token_id: AccountId,
    wrap_id: AccountId,
    round_duration_ns: u64,
    min_eligible_buy: u128,
    winner_share_bps: u16,
    settle_grace_ns: u64,
    reserve_floor: u128,

    /// Id of the current round when one is running, or of the next round.
    round_id: u64,
    current: Option<Round>,
    /// Timestamp of the last recorded buy: reports must be in chronological order.
    last_buy_ns: u64,
    /// Deadline of the last settled round: older buys can no longer start a round.
    last_round_end_ns: u64,
    last_settled_round_id: Option<u64>,
    rounds: LookupMap<u64, SettledRound>,

    /// Prizes owed to winners (AVAILABLE + IN_FLIGHT).
    prizes_outstanding: u128,
    /// Part of `prizes_outstanding` sent by a pending transfer (already left the balance).
    in_flight: u128,
    total_paid: u128,
    total_buys_recorded: u64,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub round_id: U64,
    pub winner: AccountId,
    pub prize: U128,
    pub started_at_ns: U64,
    pub ended_at_ns: U64,
    pub eligible_buys: u32,
    pub winning_tx_hash: String,
    pub status: PayoutStatus,
}

#[near(serializers = [json])]
pub struct StateView {
    /// "IDLE" | "ACTIVE" | "EXPIRED"
    pub status: String,
    pub round_id: U64,
    pub leader: Option<AccountId>,
    pub started_at_ns: Option<U64>,
    pub deadline_ns: Option<U64>,
    pub settle_after_ns: Option<U64>,
    pub eligible_buys: u32,
    pub last_tx_hash: Option<String>,
    /// NEAR currently available for prizes (balance minus storage, reserve and owed prizes).
    pub pot: U128,
    /// What the winner would receive if the round settled now.
    pub prize_if_settled_now: U128,
    pub prizes_outstanding: U128,
    pub in_flight: U128,
    pub total_paid: U128,
    pub total_buys_recorded: U64,
    pub last_settled_round_id: Option<U64>,
    pub now_ns: U64,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub reporter_id: AccountId,
    pub token_id: AccountId,
    pub wrap_id: AccountId,
    pub round_duration_ns: U64,
    pub min_eligible_buy: U128,
    pub winner_share_bps: u16,
    pub settle_grace_ns: U64,
    pub reserve_floor: U128,
}

fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"))
}
fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).unwrap_or_else(|| env::panic_str("ERR_UNDERFLOW"))
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let payload = json!({ "standard": "last-pot", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[near]
impl PotContract {
    #[init]
    pub fn new(config: InitConfig) -> Self {
        require!(config.round_duration_ns.0 > 0, "ERR_BAD_CONFIG");
        require!(config.min_eligible_buy.0 > 0, "ERR_BAD_CONFIG");
        require!((config.winner_share_bps as u128) <= BPS && config.winner_share_bps > 0, "ERR_BAD_CONFIG");
        Self {
            owner_id: config.owner_id,
            reporter_id: config.reporter_id,
            token_id: config.token_id,
            wrap_id: config.wrap_id,
            round_duration_ns: config.round_duration_ns.0,
            min_eligible_buy: config.min_eligible_buy.0,
            winner_share_bps: config.winner_share_bps,
            settle_grace_ns: config.settle_grace_ns.0,
            reserve_floor: config.reserve_floor.0,
            round_id: 1,
            current: None,
            last_buy_ns: 0,
            last_round_end_ns: 0,
            last_settled_round_id: None,
            rounds: LookupMap::new(StorageKey::Rounds),
            prizes_outstanding: 0,
            in_flight: 0,
            total_paid: 0,
            total_buys_recorded: 0,
        }
    }

    // ------------------------------------------------------------------------------------------
    // Reporter
    // ------------------------------------------------------------------------------------------

    /// Record an eligible $LAST buy seen in the Nearly pool. Reporter only.
    /// `buy_timestamp_ns` is the block timestamp of the buy; reports must be chronological.
    pub fn record_buy(&mut self, buyer: AccountId, near_in: U128, tx_hash: String, buy_timestamp_ns: U64) -> StateView {
        require!(env::predecessor_account_id() == self.reporter_id, "ERR_NOT_REPORTER");
        require!(!tx_hash.is_empty() && tx_hash.len() <= MAX_TX_HASH_LEN, "ERR_BAD_TX_HASH");
        require!(near_in.0 >= self.min_eligible_buy, "ERR_NOT_ELIGIBLE");
        let now = env::block_timestamp();
        let ts = buy_timestamp_ns.0;
        require!(ts <= now, "ERR_FUTURE_BUY");
        require!(ts >= self.last_buy_ns, "ERR_OUT_OF_ORDER");

        match self.current.as_mut() {
            Some(round) => {
                require!(ts < round.deadline_ns, "ERR_ROUND_EXPIRED");
                round.leader = buyer.clone();
                round.deadline_ns = ts
                    .checked_add(self.round_duration_ns)
                    .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"));
                round.eligible_buys += 1;
                round.last_tx_hash = tx_hash.clone();
            }
            None => {
                require!(ts >= self.last_round_end_ns, "ERR_STALE_BUY");
                let deadline = ts
                    .checked_add(self.round_duration_ns)
                    .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"));
                self.current = Some(Round {
                    leader: buyer.clone(),
                    started_at_ns: ts,
                    deadline_ns: deadline,
                    eligible_buys: 1,
                    last_tx_hash: tx_hash.clone(),
                });
                emit("round_started", json!({ "round_id": U64(self.round_id), "started_at_ns": U64(ts) }));
            }
        }
        self.last_buy_ns = ts;
        self.total_buys_recorded += 1;
        let deadline = self.current.as_ref().map(|r| r.deadline_ns).unwrap_or(0);
        emit(
            "buy_recorded",
            json!({
                "round_id": U64(self.round_id),
                "buyer": buyer,
                "near_in": near_in,
                "tx_hash": tx_hash,
                "buy_timestamp_ns": U64(ts),
                "deadline_ns": U64(deadline),
            }),
        );
        self.get_state()
    }

    // ------------------------------------------------------------------------------------------
    // Settlement and payouts
    // ------------------------------------------------------------------------------------------

    /// Permissionless once `deadline + grace` has passed. Reserves the prize and sends it to the
    /// winner in the same call; the callback marks it PAID or leaves it AVAILABLE for a retry.
    pub fn settle_round(&mut self) -> RoundView {
        let now = env::block_timestamp();
        let round = self.current.clone().unwrap_or_else(|| env::panic_str("ERR_NO_ACTIVE_ROUND"));
        require!(now >= round.deadline_ns.saturating_add(self.settle_grace_ns), "ERR_NOT_EXPIRED");
        self.current = None;

        let pot = self.available_pot();
        let prize = pot
            .checked_mul(self.winner_share_bps as u128)
            .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"))
            / BPS;
        let round_id = self.round_id;
        let mut settled = SettledRound {
            winner: round.leader.clone(),
            prize,
            started_at_ns: round.started_at_ns,
            ended_at_ns: round.deadline_ns,
            eligible_buys: round.eligible_buys,
            winning_tx_hash: round.last_tx_hash.clone(),
            status: PayoutStatus::Available,
        };
        self.last_round_end_ns = round.deadline_ns;
        self.last_settled_round_id = Some(round_id);
        self.round_id += 1;

        emit(
            "round_settled",
            json!({
                "round_id": U64(round_id),
                "winner": round.leader,
                "prize": U128(prize),
                "pot": U128(pot),
                "settled_by": env::predecessor_account_id(),
            }),
        );

        if prize == 0 {
            settled.status = PayoutStatus::Paid;
            self.rounds.insert(round_id, settled.clone());
        } else {
            self.prizes_outstanding = add(self.prizes_outstanding, prize);
            settled.status = PayoutStatus::InFlight;
            self.rounds.insert(round_id, settled.clone());
            self.send_prize(round_id, &settled.winner, prize).detach();
        }
        Self::view(round_id, &settled)
    }

    /// Retry a payout whose automatic transfer failed. Winner only.
    pub fn claim_reward(&mut self, round_id: U64) -> Promise {
        let mut r = self.rounds.get(&round_id.0).cloned().unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_ROUND"));
        require!(r.winner == env::predecessor_account_id(), "ERR_NOT_WINNER");
        match r.status {
            PayoutStatus::Paid => env::panic_str("ERR_ALREADY_PAID"),
            PayoutStatus::InFlight => env::panic_str("ERR_PAYOUT_IN_FLIGHT"),
            PayoutStatus::Available => {}
        }
        r.status = PayoutStatus::InFlight;
        let (winner, prize) = (r.winner.clone(), r.prize);
        self.rounds.insert(round_id.0, r);
        self.send_prize(round_id.0, &winner, prize)
    }

    #[private]
    pub fn on_payout(&mut self, round_id: U64) -> bool {
        let success = env::promise_results_count() == 1 && env::promise_result_checked(0, 0).is_ok();
        let Some(mut r) = self.rounds.get(&round_id.0).cloned() else {
            log!("on_payout: unknown round {}", round_id.0);
            return false;
        };
        if r.status != PayoutStatus::InFlight {
            log!("on_payout: round {} not in flight", round_id.0);
            return false;
        }
        self.in_flight = sub(self.in_flight, r.prize);
        if success {
            r.status = PayoutStatus::Paid;
            self.prizes_outstanding = sub(self.prizes_outstanding, r.prize);
            self.total_paid = add(self.total_paid, r.prize);
        } else {
            r.status = PayoutStatus::Available;
        }
        emit(
            "payout",
            json!({ "round_id": round_id, "winner": r.winner, "amount": U128(r.prize), "status": if success { "PAID" } else { "FAILED" } }),
        );
        self.rounds.insert(round_id.0, r);
        success
    }

    // ------------------------------------------------------------------------------------------
    // Fee intake helpers
    // ------------------------------------------------------------------------------------------

    /// Accept wNEAR sent with `ft_transfer_call` (kept for the pot); refund any other token.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = (sender_id, msg);
        if env::predecessor_account_id() == self.wrap_id {
            PromiseOrValue::Value(U128(0))
        } else {
            PromiseOrValue::Value(amount)
        }
    }

    /// Unwrap wNEAR held by this contract into native NEAR (pot). Anyone can call it.
    /// Requires this account to be registered on `wrap_id` (one-time `storage_deposit`).
    pub fn unwrap_wnear(&mut self, amount: U128) -> Promise {
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        Promise::new(self.wrap_id.clone()).function_call(
            "near_withdraw".to_string(),
            json!({ "amount": amount }).to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            GAS_FOR_UNWRAP,
        )
    }

    // ------------------------------------------------------------------------------------------
    // Admin (deliberately minimal)
    // ------------------------------------------------------------------------------------------

    /// Replace the reporter (e.g. if its key leaks). Owner only. Cannot touch funds or rounds.
    #[payable]
    pub fn set_reporter(&mut self, reporter_id: AccountId) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "ERR_ONE_YOCTO");
        require!(env::predecessor_account_id() == self.owner_id, "ERR_NOT_OWNER");
        emit("reporter_changed", json!({ "from": self.reporter_id, "to": reporter_id }));
        self.reporter_id = reporter_id;
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    pub fn get_state(&self) -> StateView {
        let now = env::block_timestamp();
        let r = self.current.as_ref();
        let status = match r {
            None => "IDLE",
            Some(r) if now >= r.deadline_ns => "EXPIRED",
            Some(_) => "ACTIVE",
        };
        let pot = self.available_pot();
        StateView {
            status: status.to_string(),
            round_id: U64(self.round_id),
            leader: r.map(|r| r.leader.clone()),
            started_at_ns: r.map(|r| U64(r.started_at_ns)),
            deadline_ns: r.map(|r| U64(r.deadline_ns)),
            settle_after_ns: r.map(|r| U64(r.deadline_ns.saturating_add(self.settle_grace_ns))),
            eligible_buys: r.map_or(0, |r| r.eligible_buys),
            last_tx_hash: r.map(|r| r.last_tx_hash.clone()),
            pot: U128(pot),
            prize_if_settled_now: U128(pot.saturating_mul(self.winner_share_bps as u128) / BPS),
            prizes_outstanding: U128(self.prizes_outstanding),
            in_flight: U128(self.in_flight),
            total_paid: U128(self.total_paid),
            total_buys_recorded: U64(self.total_buys_recorded),
            last_settled_round_id: self.last_settled_round_id.map(U64),
            now_ns: U64(now),
        }
    }

    pub fn get_round(&self, round_id: U64) -> Option<RoundView> {
        self.rounds.get(&round_id.0).map(|r| Self::view(round_id.0, r))
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner_id: self.owner_id.clone(),
            reporter_id: self.reporter_id.clone(),
            token_id: self.token_id.clone(),
            wrap_id: self.wrap_id.clone(),
            round_duration_ns: U64(self.round_duration_ns),
            min_eligible_buy: U128(self.min_eligible_buy),
            winner_share_bps: self.winner_share_bps,
            settle_grace_ns: U64(self.settle_grace_ns),
            reserve_floor: U128(self.reserve_floor),
        }
    }
}

impl PotContract {
    /// Balance usable for prizes: everything except storage staking, the reserve floor and prizes
    /// still owed. NEAR in flight already left the balance, so only the not-yet-sent part is owed.
    fn available_pot(&self) -> u128 {
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        let owed_in_balance = self.prizes_outstanding.saturating_sub(self.in_flight);
        balance
            .saturating_sub(storage)
            .saturating_sub(self.reserve_floor)
            .saturating_sub(owed_in_balance)
    }

    fn send_prize(&mut self, round_id: u64, winner: &AccountId, prize: u128) -> Promise {
        self.in_flight = add(self.in_flight, prize);
        Promise::new(winner.clone()).transfer(NearToken::from_yoctonear(prize)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_CALLBACK)
                .on_payout(U64(round_id)),
        )
    }

    fn view(round_id: u64, r: &SettledRound) -> RoundView {
        RoundView {
            round_id: U64(round_id),
            winner: r.winner.clone(),
            prize: U128(r.prize),
            started_at_ns: U64(r.started_at_ns),
            ended_at_ns: U64(r.ended_at_ns),
            eligible_buys: r.eligible_buys,
            winning_tx_hash: r.winning_tx_hash.clone(),
            status: r.status,
        }
    }
}

#[cfg(test)]
mod tests;
