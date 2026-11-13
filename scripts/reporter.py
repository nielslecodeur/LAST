#!/usr/bin/env python3
"""$LAST reporter bot: watches the Nearly token on NEAR mainnet and drives the last-pot contract.

Every few seconds it asks the FastNEAR transactions API for the transactions that touched the
$LAST token since the last one it processed (one request, instead of downloading every block),
then for each successful transaction:
  1. buy detection: a receipt executed on the token logs a NEP-141 `ft_transfer` to the account
     that signed the transaction (how every buy route ends: Rhea v2, DCL, aggregators);
  2. NEAR spent = `wrap.near` logs "Transfer N from <signer> to ..." in that transaction (covers
     NEAR wrapped on the fly). Buys paid with other tokens are ignored;
  3. if NEAR spent >= the contract's `min_eligible_buy`, it calls
     `record_buy(buyer, near_in, tx_hash, buy_timestamp_ns)` on the pot contract;
  4. whenever the round is past `deadline + grace`, it calls `settle_round` (the contract then
     pays the winner by itself).

Transactions are processed in chain order (block height, index), so reports are chronological.
A buy after the current deadline waits until the round can be settled, then starts the next round.

Signing uses near-cli-rs with the legacy keychain of the reporter account (never printed).
Usage (Linux/WSL):
  python3 scripts/reporter.py --pot <pot>.near --token <token>.nearlytrade.near --reporter <reporter>.near
  --from-height H  start from block H (e.g. the launch block) on the first run
  --dry-run        only print what would be sent
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

TX_API = "https://tx.main.fastnear.com/v0"
# Public RPC endpoints, tried in order (rate limits are per endpoint).
RPCS = ["https://near.drpc.org", "https://rpc.ankr.com/near", "https://archival-rpc.mainnet.fastnear.com", "https://free.rpc.fastnear.com"]
WRAP = "wrap.near"
WRAP_TRANSFER = re.compile(r"^Transfer (\d+) from (\S+) to (\S+)$")
POLL_S = 10
STATE_REFRESH_S = 15


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def http_json(url: str, body: dict | None = None, timeout: int = 30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data, {"content-type": "application/json", "user-agent": "last-reporter"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def rpc(method: str, params):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    last: Exception | None = None
    for url in RPCS:
        try:
            res = http_json(url, body)
        except (urllib.error.URLError, TimeoutError) as e:  # 429 / 5xx / network: next endpoint
            last = e
            continue
        if "error" in res:
            raise RuntimeError(json.dumps(res["error"])[:300])
        return res["result"]
    raise last if last else RuntimeError("no RPC endpoint")


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
    log(method, "OK" if ok else "FAILED", tx.group(1) if tx else "", "" if ok else text.strip().splitlines()[-1:])
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


def analyse(tx: dict, token: str):
    """(buyer, near_in, buy_timestamp_ns) if this transaction is a $LAST buy, else None."""
    signer = tx["transaction"]["signer_id"]
    ts = None
    near_in = 0
    for r in tx.get("receipts") or []:
        eo = r["execution_outcome"]
        out = eo["outcome"]
        if "Failure" in json.dumps(out.get("status", {})):
            continue
        logs = out.get("logs") or []
        if out["executor_id"] == token and ts is None:
            for t in nep141_transfers(logs):
                if t.get("new_owner_id") == signer and t.get("old_owner_id") != signer:
                    ts = int(eo["block_timestamp"])
                    break
        if out["executor_id"] == WRAP:
            for line in logs:
                m = WRAP_TRANSFER.match(line)
                if m and m.group(2) == signer:
                    near_in += int(m.group(1))
    return (signer, near_in, ts) if ts is not None else None


def new_txs(token: str, cursor: tuple[int, int]) -> list[dict]:
    """Successful token transactions strictly after `cursor`, oldest first (pages back as needed)."""
    found: list[dict] = []
    max_h = None
    while True:
        page = http_json(f"{TX_API}/account", {"account_id": token, "max_block_height": max_h})
        txs = page.get("account_txs") or []
        stop = False
        for t in txs:
            key = (int(t["tx_block_height"]), int(t["tx_index"]))
            if key <= cursor:
                stop = True
                continue
            if t.get("is_success", True):
                found.append(t)
        if stop or not txs or len(txs) < 2:
            break
        oldest = min(int(t["tx_block_height"]) for t in txs)
        if max_h is not None and oldest >= max_h:
            break
        max_h = oldest - 1 if oldest > 0 else None
    uniq = {t["transaction_hash"]: t for t in found}
    return sorted(uniq.values(), key=lambda t: (int(t["tx_block_height"]), int(t["tx_index"])))


def tx_details(hashes: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(0, len(hashes), 20):
        res = http_json(f"{TX_API}/transactions", {"tx_hashes": hashes[i : i + 20]})
        for t in res.get("transactions") or []:
            if t:
                out[t["transaction"]["hash"]] = t
    return out


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
    ap.add_argument("--from-height", type=int, default=None, help="first block to scan on the first run")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    cfg = view(a.pot, "get_config")
    if cfg["reporter_id"] != a.reporter and not a.dry_run:
        sys.exit(f"pot reporter is {cfg['reporter_id']}, not {a.reporter}")
    min_buy = int(cfg["min_eligible_buy"])
    log("pot", a.pot, "token", a.token, "min buy", min_buy / 1e24, "NEAR")

    saved = load_state(a.state)
    if "cursor" in saved:
        cursor = tuple(saved["cursor"])
    elif a.from_height is not None:
        cursor = (a.from_height - 1, 1 << 30)
    else:
        cursor = (rpc("block", {"finality": "final"})["header"]["height"], 1 << 30)
    log("starting after block", cursor[0])

    pending: list[tuple[str, str, int, int]] = []  # buys after the deadline, waiting for settlement
    st: dict = {}
    st_at = 0.0

    beat_at = 0.0

    def refresh():
        nonlocal st, st_at, beat_at
        st, st_at = view(a.pot, "get_state"), time.time()
        if st_at - beat_at >= 300:  # heartbeat every 5 min
            beat_at = st_at
            left = ""
            if st.get("deadline_ns"):
                left = f" | {max(0, int(st['deadline_ns']) - int(st['now_ns'])) // 60_000_000_000} min left"
            log(f"alive: {st['status']} round {st['round_id']} | leader {st.get('leader')}{left} | pot {int(st['pot']) / 1e24:.4f} NEAR")

    def record(tx: str, buyer: str, ts: int, near_in: int):
        call(a.pot, "record_buy", {"buyer": buyer, "near_in": str(near_in), "tx_hash": tx, "buy_timestamp_ns": str(ts)}, a.reporter, a.dry_run)
        refresh()

    while True:
        try:
            if time.time() - st_at >= STATE_REFRESH_S:
                refresh()
            now = int(st["now_ns"]) + int((time.time() - st_at) * 1e9)
            if st["status"] == "EXPIRED" and now >= int(st["settle_after_ns"]):
                call(a.pot, "settle_round", {}, a.reporter, a.dry_run)
                refresh()
                continue
            while pending and st["status"] == "IDLE":
                record(*pending.pop(0))

            txs = new_txs(a.token, cursor)
            if txs:
                details = tx_details([t["transaction_hash"] for t in txs])
                for t in txs:
                    h = t["transaction_hash"]
                    d = details.get(h)
                    if d is None:
                        raise RuntimeError(f"no details yet for {h}")  # retry the batch later
                    buy = analyse(d, a.token)
                    if buy:
                        buyer, near_in, ts = buy
                        if near_in < min_buy:
                            log("buy below minimum or not paid in NEAR", buyer, near_in / 1e24, h)
                        else:
                            log("eligible buy", buyer, near_in / 1e24, "NEAR", h)
                            deadline = int(st["deadline_ns"]) if st.get("deadline_ns") else None
                            if pending or (st["status"] != "IDLE" and deadline is not None and ts >= deadline):
                                pending.append((h, buyer, ts, near_in))
                            else:
                                record(h, buyer, ts, near_in)
                    cursor = (int(t["tx_block_height"]), int(t["tx_index"]))
                    save_state(a.state, {"cursor": list(cursor)})
            time.sleep(POLL_S)
        except KeyboardInterrupt:
            raise
        except urllib.error.HTTPError as e:
            wait = 30 if e.code == 429 else 5
            log(f"HTTP {e.code} on {getattr(e, 'url', '')}, retrying in {wait}s")
            time.sleep(wait)
        except Exception as e:  # network hiccup: retry from the same cursor
            log("error, retrying:", str(e)[:200])
            time.sleep(5)


if __name__ == "__main__":
    main()
