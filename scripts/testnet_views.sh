#!/usr/bin/env bash
# Read-only snapshot of the deployed LAST contract on NEAR Testnet (no signature, no keys).
# Usage (Linux/WSL): scripts/testnet_views.sh [contract_id] [account_id]
set -euo pipefail

CONTRACT="${1:-last-armand.testnet}"
ACCOUNT="${2:-}"

view() {
  local method="$1" args="${2:-{\}}"
  echo "== $method $args"
  near contract call-function as-read-only "$CONTRACT" "$method" json-args "$args" \
    network-config testnet now 2>/dev/null | sed -n '/^[{["0-9]/,$p' | sed '/^$/q'
}

view get_game_state
view get_market_state
view get_integrity
view get_roles
view ft_metadata
view ft_total_supply
view storage_balance_bounds
view quote_buy '{"gross_near":"30000000000000000000000"}'
if [[ -n "$ACCOUNT" ]]; then
  view get_account_state "{\"account_id\":\"$ACCOUNT\"}"
fi
