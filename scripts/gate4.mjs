#!/usr/bin/env node
// LAST — Gate 4 verification tool. READ-ONLY: no keys, no signatures, NEAR Testnet RPC only.
//
//   node scripts/gate4.mjs snapshot [--out file.json] [account ...]   state + financial invariants
//   node scripts/gate4.mjs tx <tx_hash> <signer_account>              gas, receipts, callbacks, events, errors
//   node scripts/gate4.mjs diff <before.json> <after.json>            what changed between two snapshots
//
// Env: LAST_CONTRACT (default last-armand.testnet), NEAR_RPC (default https://rpc.testnet.near.org).
// Exit code 1 if an invariant fails (snapshot) or the transaction failed (tx).

import { readFileSync, writeFileSync } from "node:fs";

const CONTRACT = process.env.LAST_CONTRACT ?? "last-armand.testnet";
const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.near.org";
const EXPLORER = "https://testnet.nearblocks.io";
const TOTAL_SUPPLY = 10n ** 24n;

if (!CONTRACT.endsWith(".testnet")) {
  console.error(`Refusing ${CONTRACT}: NEAR Testnet only.`);
  process.exit(2); // nothing pending yet: safe
}

// ------------------------------------------------------------------ rpc

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gate4", method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error.cause ?? j.error).slice(0, 300)}`);
  return j.result;
}

async function view(method, args = {}) {
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (r.error) throw new Error(`${method}: ${r.error}`);
  return JSON.parse(Buffer.from(r.result).toString() || "null");
}

const B = (s) => BigInt(s);
const near = (y, d = 6) => {
  const v = B(y);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const w = a / 10n ** 24n;
  const f = (a % 10n ** 24n).toString().padStart(24, "0").slice(0, d).replace(/0+$/, "");
  return `${neg ? "-" : ""}${w}${f ? "." + f : ""} NEAR`;
};
const last = (a) => `${(B(a) / 10n ** 16n).toString().replace(/(\d)(\d{2})$/, "$1.$2")} LAST`;
const tgas = (g) => `${(Number(g) / 1e12).toFixed(2)} Tgas`;

// ------------------------------------------------------------------ snapshot

async function snapshot(accounts) {
  const [game, market, integrity, supply, inventory, block] = await Promise.all([
    view("get_game_state"),
    view("get_market_state"),
    view("get_integrity"),
    view("ft_total_supply"),
    view("ft_balance_of", { account_id: CONTRACT }),
    rpc("block", { finality: "final" }),
  ]);
  const acc = {};
  for (const id of accounts) {
    const [state, vacc] = await Promise.all([
      view("get_account_state", { account_id: id }),
      rpc("query", { request_type: "view_account", finality: "final", account_id: id }).catch(() => null),
    ]);
    acc[id] = { ...state, near_amount: vacc?.amount ?? null };
  }
  const roundIds = new Set();
  if (game.last_settled_round_id) for (let i = B(game.last_settled_round_id); i >= 1n && roundIds.size < 10; i--) roundIds.add(i.toString());
  for (const a of Object.values(acc)) a.claimable_rounds.forEach((r) => roundIds.add(r));
  const rounds = {};
  for (const id of roundIds) rounds[id] = await view("get_round", { round_id: id });
  return { at: new Date().toISOString(), block_height: block.header.height, contract: CONTRACT, game, market, integrity, supply, inventory, accounts: acc, rounds };
}

function invariants(s) {
  const i = s.integrity;
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok, detail });
  const obligations = ["market_near_reserve", "active_pot", "next_seed_pot", "treasury_reserve", "ops_reserve", "credits_outstanding", "prizes_outstanding"].reduce((t, k) => t + B(i[k]), 0n);
  const have = B(i.account_balance) + B(i.in_flight);
  const need = B(i.storage_cost) + B(i.total_obligations);

  check("I1 solvency: balance + in_flight >= storage + obligations", have >= need, `${near(have)} >= ${near(need)}`);
  check("I2 total_obligations = sum of the 7 buckets", obligations === B(i.total_obligations), `${near(obligations)} vs ${near(i.total_obligations)}`);
  check("I3 surplus = balance + in_flight - storage - obligations", B(i.surplus) === (have > need ? have - need : 0n), near(i.surplus));
  check("I4 integrity reserve = market reserve", i.market_near_reserve === s.market.near_reserve, near(s.market.near_reserve));
  check("I5 integrity pots = game pots", i.active_pot === s.game.active_pot && i.next_seed_pot === s.game.next_seed_pot, `active ${near(i.active_pot)}, next ${near(i.next_seed_pot)}`);
  check("I6 LAST supply fixed at 10^24", B(s.supply) === TOTAL_SUPPLY, last(s.supply));
  check("I7 market LAST inventory = contract FT balance", s.market.last_inventory === s.inventory, last(s.inventory));
  // the contract's own FT balance IS the inventory: do not count it twice
  const held = Object.entries(s.accounts).filter(([id]) => id !== s.contract).reduce((t, [, a]) => t + B(a.last_balance), 0n);
  check("I8 inventory + listed accounts' LAST <= supply", B(s.inventory) + held <= TOTAL_SUPPLY, `${last(B(s.inventory) + held)}`);
  const g = s.game;
  const gameOk =
    g.status === "IDLE"
      ? g.leader === null && B(g.active_pot) === 0n
      : g.leader !== null && (g.status === "ACTIVE" ? B(g.now_ns) < B(g.deadline_ns) : B(g.now_ns) >= B(g.deadline_ns));
  check("I9 game status consistent (IDLE: no leader, pot 0 / ACTIVE: now<deadline / EXPIRED: now>=deadline)", gameOk, `${g.status} round ${g.round_id}`);
  const credits = Object.values(s.accounts).reduce((t, a) => t + B(a.credit_available) + B(a.credit_in_flight), 0n);
  check("I10 listed accounts' credits <= credits_outstanding", credits <= B(i.credits_outstanding), `${near(credits)} <= ${near(i.credits_outstanding)}`);
  let claimsOk = true;
  for (const [id, a] of Object.entries(s.accounts)) for (const r of a.claimable_rounds) {
    const rv = s.rounds[r];
    if (!rv || rv.winner !== id || rv.claim_status === "PAID") claimsOk = false;
  }
  check("I11 claimable_rounds: winner = account, status != PAID", claimsOk, "");
  const unpaid = Object.values(s.rounds).filter((r) => r && r.claim_status !== "PAID").reduce((t, r) => t + B(r.prize), 0n);
  check("I12 unpaid prizes of listed rounds <= prizes_outstanding", unpaid <= B(i.prizes_outstanding), `${near(unpaid)} <= ${near(i.prizes_outstanding)}`);
  return out;
}

function printSnapshot(s, inv) {
  const g = s.game, m = s.market, i = s.integrity;
  console.log(`LAST ${s.contract} @ block ${s.block_height} (${s.at})`);
  console.log(`game    : ${g.status} round #${g.round_id} leader=${g.leader ?? "-"} pot=${near(g.active_pot)} next_seed=${near(g.next_seed_pot)} eligible_buys=${g.qualifying_buy_count} last_settled=${g.last_settled_round_id ?? "-"}`);
  if (g.deadline_ns) console.log(`          deadline in ${((Number(B(g.deadline_ns) - B(g.now_ns))) / 1e9).toFixed(1)} s (chain time)`);
  console.log(`market  : X=${near(m.near_reserve)} Y=${last(m.last_inventory)} buys=${m.buy_count} sells=${m.sell_count} vol_in=${near(m.total_buy_volume)} vol_out=${near(m.total_sell_volume)} treasury=${near(m.treasury_reserve)} ops=${near(m.ops_reserve)}`);
  console.log(`ledger  : balance=${near(i.account_balance)} storage=${near(i.storage_cost)} obligations=${near(i.total_obligations)} credits=${near(i.credits_outstanding)} prizes=${near(i.prizes_outstanding)} in_flight=${near(i.in_flight)} surplus=${near(i.surplus)}`);
  for (const [id, a] of Object.entries(s.accounts)) {
    console.log(`account : ${id} registered=${a.registered} LAST=${last(a.last_balance)} credit=${near(a.credit_available)} in_flight=${near(a.credit_in_flight)} claimable=[${a.claimable_rounds}] wallet=${a.near_amount ? near(a.near_amount, 4) : "?"}`);
  }
  for (const [id, r] of Object.entries(s.rounds)) {
    if (r) console.log(`round   : #${id} winner=${r.winner} prize=${near(r.prize)} buys=${r.qualifying_buy_count} claim=${r.claim_status}`);
  }
  console.log("invariants:");
  for (const c of inv) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
}

// ------------------------------------------------------------------ tx

async function inspectTx(hash, signer) {
  const r = await rpc("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
  const t = r.transaction;
  const attached = t.actions.reduce((g, a) => g + B(a.FunctionCall?.gas ?? 0), 0n);
  console.log(`tx ${hash}  (${EXPLORER}/txns/${hash})`);
  console.log(`signer ${t.signer_id} → ${t.receiver_id}`);
  for (const a of t.actions) {
    if (a.FunctionCall) {
      const args = Buffer.from(a.FunctionCall.args, "base64").toString();
      console.log(`  action FunctionCall ${a.FunctionCall.method_name}(${args}) deposit=${a.FunctionCall.deposit} gas=${tgas(a.FunctionCall.gas)}`);
    } else console.log(`  action ${typeof a === "string" ? a : Object.keys(a)[0]}`);
  }
  // receipt id → method, from the receipts list
  const methods = {};
  for (const rc of r.receipts ?? []) {
    const acts = rc.receipt?.Action?.actions ?? [];
    methods[rc.receipt_id] = acts.map((a) => (a.FunctionCall ? a.FunctionCall.method_name : typeof a === "string" ? a : Object.keys(a)[0])).join("+");
  }
  let burnt = B(r.transaction_outcome.outcome.gas_burnt);
  let failed = false;
  console.log(`  [tx]  gas_burnt=${tgas(r.transaction_outcome.outcome.gas_burnt)}`);
  for (const ro of r.receipts_outcome) {
    const o = ro.outcome;
    burnt += B(o.gas_burnt);
    const st = o.status;
    let status;
    if (st.SuccessValue !== undefined) {
      const v = Buffer.from(st.SuccessValue, "base64").toString();
      status = `OK ${v ? v.slice(0, 160) : ""}`;
    } else if (st.SuccessReceiptId) status = "OK → promise";
    else if (st.Failure) {
      failed = true;
      const m = /ERR_[A-Z0-9_]+/.exec(JSON.stringify(st.Failure));
      status = `FAILURE ${m ? m[0] : JSON.stringify(st.Failure).slice(0, 160)}`;
    } else status = JSON.stringify(st).slice(0, 80);
    const method = methods[ro.id] ?? "";
    const isCallback = /^on_.*_complete$/.test(method);
    console.log(`  [${o.executor_id}${method ? " " + method : ""}${isCallback ? " (callback)" : ""}] gas=${tgas(o.gas_burnt)} ${status}`);
    for (const log of o.logs) {
      if (log.startsWith("EVENT_JSON:")) {
        const e = JSON.parse(log.slice(11));
        console.log(`      event ${e.standard}:${e.event} ${JSON.stringify(e.data[0])}`);
      } else console.log(`      log ${log}`);
    }
  }
  const final = r.status.SuccessValue !== undefined ? "SUCCESS" : r.status.Failure ? "FAILURE" : JSON.stringify(r.status);
  console.log(`final: ${final} · total gas burnt ${tgas(burnt)} of ${tgas(attached)} attached (${attached ? ((Number(burnt) / Number(attached)) * 100).toFixed(0) : "-"}%) · network fee burnt ${near(sumTokens(r))}`);
  return !(failed || final === "FAILURE");
}

function sumTokens(r) {
  return [r.transaction_outcome, ...r.receipts_outcome].reduce((t, x) => t + B(x.outcome.tokens_burnt), 0n);
}

// ------------------------------------------------------------------ diff

function diff(a, b) {
  const rows = [];
  const cmp = (label, x, y, fmt = (v) => v) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      const delta = /^\d+$/.test(String(x)) && /^\d+$/.test(String(y)) ? ` (Δ ${fmt((B(y) - B(x)).toString())})` : "";
      rows.push(`${label}: ${fmt(x)} → ${fmt(y)}${delta}`);
    }
  };
  for (const k of ["status", "round_id", "leader", "deadline_ns", "qualifying_buy_count", "last_settled_round_id"]) cmp(`game.${k}`, a.game[k], b.game[k]);
  for (const k of ["active_pot", "next_seed_pot"]) cmp(`game.${k}`, a.game[k], b.game[k], near);
  for (const k of ["near_reserve", "total_buy_volume", "total_sell_volume", "treasury_reserve", "ops_reserve"]) cmp(`market.${k}`, a.market[k], b.market[k], near);
  cmp("market.last_inventory", a.market.last_inventory, b.market.last_inventory, last);
  for (const k of ["buy_count", "sell_count"]) cmp(`market.${k}`, a.market[k], b.market[k]);
  for (const k of ["account_balance", "credits_outstanding", "prizes_outstanding", "in_flight", "surplus"]) cmp(`ledger.${k}`, a.integrity[k], b.integrity[k], near);
  for (const id of new Set([...Object.keys(a.accounts), ...Object.keys(b.accounts)])) {
    const x = a.accounts[id] ?? {}, y = b.accounts[id] ?? {};
    cmp(`${id}.LAST`, x.last_balance, y.last_balance, last);
    for (const k of ["credit_available", "credit_in_flight", "near_amount"]) cmp(`${id}.${k}`, x[k], y[k], near);
    cmp(`${id}.claimable_rounds`, x.claimable_rounds, y.claimable_rounds);
    cmp(`${id}.registered`, x.registered, y.registered);
  }
  for (const id of new Set([...Object.keys(a.rounds), ...Object.keys(b.rounds)])) cmp(`round#${id}.claim_status`, a.rounds[id]?.claim_status ?? null, b.rounds[id]?.claim_status ?? null);
  console.log(`diff ${a.at} (block ${a.block_height}) → ${b.at} (block ${b.block_height})`);
  console.log(rows.length ? rows.map((r) => "  " + r).join("\n") : "  (no change)");
}

// ------------------------------------------------------------------ main

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "snapshot") {
    let out = null;
    const accounts = [];
    for (let i = 0; i < rest.length; i++) rest[i] === "--out" ? (out = rest[++i]) : accounts.push(rest[i]);
    const s = await snapshot(accounts);
    const inv = invariants(s);
    printSnapshot(s, inv);
    if (out) writeFileSync(out, JSON.stringify(s, null, 2));
    process.exitCode = inv.every((c) => c.ok) ? 0 : 1;
  } else if (cmd === "tx" && rest.length === 2) {
    process.exitCode = (await inspectTx(rest[0], rest[1])) ? 0 : 1;
  } else if (cmd === "diff" && rest.length === 2) {
    diff(JSON.parse(readFileSync(rest[0], "utf8")), JSON.parse(readFileSync(rest[1], "utf8")));
  } else {
    console.log("usage: node scripts/gate4.mjs snapshot [--out f.json] [account ...] | tx <hash> <signer> | diff <a.json> <b.json>");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 3;
}
