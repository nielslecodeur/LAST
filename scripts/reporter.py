#!/usr/bin/env python3
"""$LAST reporter bot: watches the Nearly token on NEAR mainnet and drives the last-pot contract.

What it does, block by block (FastNEAR neardata, finalized blocks):
  1. finds receipts executed on the $LAST token that log a NEP-141 `ft_transfer` to the account
     that signed the transaction (that is how every buy route ends: Rhea v2, DCL, aggregators);
  2. reads that transaction and sums the wNEAR the signer spent in it (`wrap.near` logs
     "Transfer N from <signer> to ..."). Buys paid with other tokens are ignored;
  3. if the NEAR spent >= the contract's `min_eligible_buy`, calls
     `record_buy(buyer, near_in, tx_hash, buy_timestamp_ns)` on the pot contract;
  4. whenever the round is past `deadline + grace`, calls `settle_round` (the contract then pays
     the winner by itself).

Blocks are processed in order, so reports are chronological. A buy that happens after the
current deadline waits until the round can be settled, then starts the next round.

Signing uses near-cli-rs with the legacy keychain of the reporter account (never printed).
Usage (Linux/WSL):
  python3 scripts/reporter.py --pot <pot>.near --token <token>.nearlytrade.near --reporter <reporter>.near
  add --dry-run to only print what would be sent.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

NEARDATA = "https://mainnet.neardata.xyz/v0"
RPC = "https://free.rpc.fastnear.com"
ARCHIVAL_RPC = "https://archival-rpc.mainnet.fastnear.com"
WRAP = "wrap.near"
WRAP_TRANSFER = re.compile(r"^Transfer (\d+) from (\S+) to (\S+)$")
WRAP_DEPOSIT = re.compile(r"^Deposit (\d+) NEAR to (\S+)$")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def http_json(url: str, body: dict | None = None, timeout: int = 30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data, {"content-type": "application/json", "user-agent": "last-reporter"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def rpc(method: str, params, archival: bool = False):
    res = http_json(ARCHIVAL_RPC if archival else RPC, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in res:
        raise RuntimeError(json.dumps(res["error"])[:300])
    return res["result"]


def view(contract: str, method: str, args: dict | None = None):
    r = rpc(
        "query",
        {
            "request_type": "call_function",
            "finality": "final",
            "account_id": contract,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode(),
        },
    )
    return json.loads(bytes(r["result"]).decode())


def call(contract: str, method: str, args: dict, signer: str, dry: bool) -> bool:
    cmd = [
        "near", "contract", "call-function", "as-transaction", contract, method,
        "json-args", json.dumps(args), "prepaid-gas", "60.0 Tgas", "attached-deposit", "0 NEAR",
        "sign-as", signer, "network-config", "mainnet", "sign-with-legacy-keychain", "send",
    ]
    if dry:
        log("DRY-RUN", method, json.dumps(args))
        return True
    out = subprocess.run(cmd, capture_output=True, text=True)
    text = (out.stdout or "") + (out.stderr or "")
    ok = out.returncode == 0 and "Error" not in text and "panicked" not in text
    tx = re.search(r"Transaction ID: (\S+)", text)
    log(method, "OK" if ok else "FAILED", tx.group(1) if tx else "", "" if ok else text.strip().splitlines()[-1:] )
    return ok


def nep141_transfers(logs: list[str]):
    for line in logs:
        if not line.startswith("EVENT_JSON:"):
            continue
        try:
            ev = json.loads(line[len("EVENT_JSON:"):])
        except ValueError:
            continue
        if ev.get("standard") == "nep141" and ev.get("event") == "ft_transfer":
            yield from ev.get("data", [])


def signer_of(receipt: dict) -> str | None:
    action = (receipt.get("receipt") or {}).get("Action")
    return action.get("signer_id") if action else None


def near_spent(tx_hash: str, signer: str) -> int:
    """wNEAR the signer sent out in this transaction (covers NEAR wrapped on the fly)."""
    for archival in (False, True):
        try:
            res = rpc("EXPERIMENTAL_tx_status", {"tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL"}, archival)
            break
        except Exception:
            res = None
    if not res:
        return 0
    spent = 0
    for o in res["receipts_outcome"]:
        if o["outcome"]["executor_id"] != WRAP:
            continue
        for line in o["outcome"]["logs"]:
            m = WRAP_TRANSFER.match(line)
            if m and m.group(2) == signer:
                spent += int(m.group(1))
    return spent


def find_buys(block: dict, token: str):
    """Yield (tx_hash, buyer, timestamp_ns) for token transfers to the tx signer in this block."""
    ts = int(block["block"]["header"]["timestamp_nanosec"])
    for shard in block.get("shards") or []:
        for reo in shard.get("receipt_execution_outcomes") or []:
            outcome = reo["execution_outcome"]["outcome"]
            if outcome["executor_id"] != token:
                continue
            signer = signer_of(reo.get("receipt") or {})
            if not signer:
                continue
            for t in nep141_transfers(outcome.get("logs") or []):
                if t.get("new_owner_id") == signer and t.get("old_owner_id") != signer:
                    yield reo.get("tx_hash"), signer, ts
                    break


def load_state(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(path: str, state: dict):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pot", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--reporter", required=True)
    ap.add_argument("--state", default=os.path.expanduser("~/.last-reporter.json"))
    ap.add_argument("--from-height", type=int, default=None, help="first block to scan (default: resume, else latest)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    cfg = view(a.pot, "get_config")
    if cfg["reporter_id"] != a.reporter and not a.dry_run:
        sys.exit(f"pot reporter is {cfg['reporter_id']}, not {a.reporter}")
    min_buy = int(cfg["min_eligible_buy"])
    log("pot", a.pot, "token", a.token, "min buy", min_buy / 1e24, "NEAR")

    state = load_state(a.state)
    height = a.from_height or state.get("height")
    if height is None:
        height = http_json(f"{NEARDATA}/last_block/final")["block"]["header"]["height"]
    pending: list[tuple[str, str, int, int]] = []  # buys waiting for a settlement

    while True:
        try:
            st = view(a.pot, "get_state")
            now = int(st["now_ns"])
            if st["status"] == "EXPIRED" and now >= int(st["settle_after_ns"]):
                call(a.pot, "settle_round", {}, a.reporter, a.dry_run)
                continue

            # Replay buys that arrived after the old deadline, once the round is settled.
            while pending and st["status"] == "IDLE":
                tx, buyer, ts, near_in = pending.pop(0)
                call(a.pot, "record_buy", {"buyer": buyer, "near_in": str(near_in), "tx_hash": tx, "buy_timestamp_ns": str(ts)}, a.reporter, a.dry_run)
                st = view(a.pot, "get_state")

            final = http_json(f"{NEARDATA}/last_block/final")["block"]["header"]["height"]
            if height > final:
                time.sleep(1.0)
                continue
            try:
                block = http_json(f"{NEARDATA}/block/{height}")
            except urllib.error.HTTPError as e:
                if e.code == 404:  # skipped height
                    height += 1
                    continue
                raise
            if block:
                for tx, buyer, ts in find_buys(block, a.token):
                    near_in = near_spent(tx, buyer)
                    if near_in < min_buy:
                        log("buy too small or not in NEAR", buyer, near_in / 1e24, tx)
                        continue
                    log("eligible buy", buyer, near_in / 1e24, "NEAR", tx)
                    deadline = int(st["deadline_ns"]) if st.get("deadline_ns") else None
                    if pending or (st["status"] != "IDLE" and deadline is not None and ts >= deadline):
                        pending.append((tx, buyer, ts, near_in))  # after the deadline: wait for settlement
                        continue
                    call(a.pot, "record_buy", {"buyer": buyer, "near_in": str(near_in), "tx_hash": tx, "buy_timestamp_ns": str(ts)}, a.reporter, a.dry_run)
                    st = view(a.pot, "get_state")
            height += 1
            save_state(a.state, {"height": height})
        except KeyboardInterrupt:
            raise
        except Exception as e:  # network hiccup: retry the same block
            log("error, retrying:", str(e)[:200])
            time.sleep(3)


if __name__ == "__main__":
    main()
