//! Round state machine (docs/SPEC_V2.md §2.2).
//!
//! IDLE (no round) -> ACTIVE (leader + deadline) -> EXPIRED (derived: now >= deadline) -> SETTLED.
//! Gate 1: start of a round and leader/deadline updates from `buy`. `settle_round` lands in Gate 2.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

use crate::accounting::add;
use crate::{events, LastContract, LastContractExt};

#[near(serializers = [borsh])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Round {
    pub leader: AccountId,
    pub started_at_ns: u64,
    pub deadline_ns: u64,
    pub qualifying_buy_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Active,
    Expired,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Idle => "IDLE",
            Status::Active => "ACTIVE",
            Status::Expired => "EXPIRED",
        }
    }
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameStateView {
    pub status: String,
    pub round_id: U64,
    pub leader: Option<AccountId>,
    pub started_at_ns: Option<U64>,
    pub deadline_ns: Option<U64>,
    pub active_pot: U128,
    pub next_seed_pot: U128,
    pub qualifying_buy_count: u32,
    pub last_settled_round_id: Option<U64>,
    pub now_ns: U64,
}

impl LastContract {
    /// `now >= deadline` is EXPIRED: no ambiguous equality (SPEC §2.3 #2).
    pub(crate) fn status_at(&self, now_ns: u64) -> Status {
        match &self.current_round {
            None => Status::Idle,
            Some(r) if now_ns >= r.deadline_ns => Status::Expired,
            Some(_) => Status::Active,
        }
    }

    pub(crate) fn deadline_from(&self, now_ns: u64) -> u64 {
        now_ns
            .checked_add(self.round_duration_ns)
            .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"))
    }

    /// IDLE -> ACTIVE. The pending next-round seed becomes the live pot *before* the triggering
    /// trade's fee is allocated (SPEC §1.3).
    pub(crate) fn start_round(&mut self, leader: &AccountId, now_ns: u64) {
        debug_assert!(self.current_round.is_none());
        self.ledger.active_pot = add(self.ledger.active_pot, self.ledger.next_seed_pot);
        self.ledger.next_seed_pot = 0;
        self.current_round = Some(Round {
            leader: leader.clone(),
            started_at_ns: now_ns,
            deadline_ns: self.deadline_from(now_ns),
            qualifying_buy_count: 0,
        });
        events::round_started(self.round_id, self.ledger.active_pot, now_ns);
    }

    /// Eligible buy in an ACTIVE round: new leader, deadline reset.
    pub(crate) fn record_qualifying_buy(&mut self, buyer: &AccountId, now_ns: u64) {
        let deadline = self.deadline_from(now_ns);
        let round = self
            .current_round
            .as_mut()
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACTIVE_ROUND"));
        round.leader = buyer.clone();
        round.deadline_ns = deadline;
        round.qualifying_buy_count += 1;
    }
}

#[near]
impl LastContract {
    pub fn get_game_state(&self) -> GameStateView {
        let now = env::block_timestamp();
        let r = self.current_round.as_ref();
        GameStateView {
            status: self.status_at(now).as_str().to_string(),
            round_id: U64(self.round_id),
            leader: r.map(|r| r.leader.clone()),
            started_at_ns: r.map(|r| U64(r.started_at_ns)),
            deadline_ns: r.map(|r| U64(r.deadline_ns)),
            active_pot: U128(self.ledger.active_pot),
            next_seed_pot: U128(self.ledger.next_seed_pot),
            qualifying_buy_count: r.map_or(0, |r| r.qualifying_buy_count),
            last_settled_round_id: self.last_settled_round_id.map(U64),
            now_ns: U64(now),
        }
    }
}
