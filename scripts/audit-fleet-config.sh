#!/usr/bin/env bash
#
# audit-fleet-config.sh — read-only drift report for cortextOS fleet config
#
# Compares each agent's config.json + .claude/settings.json against the
# expected pattern for its role tier. Prints a table; flags drift rows
# with [DRIFT].
#
# Usage:  bash scripts/audit-fleet-config.sh [org]   (default: sb-personal)
# Deps:   jq
#
# Expected pattern (encoded below):
#   boss/analyst     -> opus, 1M enabled, ctx_warning=40, ctx_handoff=50
#   engineer/fullstack -> opus, 1M enabled, ctx_warning=50, ctx_handoff=60
#   devops/token-auditor -> sonnet, ctx_warning=70, ctx_handoff=80
#   devops-c         -> gpt-5-codex, ctx_warning=70, ctx_handoff=80
#   all (except devops-c) -> max_session_seconds in staggered band [25200, 32400]
#   none should have enableAllProjectMcpServers: true (use enabledMcpjsonServers)

set -euo pipefail

ORG="${1:-sb-personal}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$ROOT/orgs/$ORG/agents"

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "ERROR: $AGENTS_DIR does not exist" >&2
  exit 2
fi

expected_for() {
  local name=$1
  case "$name" in
    boss|analyst)        echo "opus 40 50" ;;
    engineer|fullstack)  echo "opus 50 60" ;;
    devops|token-auditor) echo "sonnet 70 80" ;;
    devops-c)            echo "gpt-5-codex 70 80" ;;
    *)                   echo "unknown 70 80" ;;
  esac
}

drift_rows=0
total_rows=0

printf "%-15s %-14s %-5s %-5s %-7s %-10s %-6s %s\n" \
  "AGENT" "MODEL" "WARN" "HOFF" "MAX_S" "1M_DISABLE" "MCP" "FLAGS"
printf -- "--------------------------------------------------------------------------------\n"

for agent_dir in "$AGENTS_DIR"/*/; do
  name=$(basename "$agent_dir")
  config="$agent_dir/config.json"
  settings="$agent_dir/.claude/settings.json"
  env_file="$agent_dir/.env"
  mcp_file="$agent_dir/.mcp.json"

  [[ -f "$config" ]] || { printf "%-15s [no config.json]\n" "$name"; continue; }

  model=$(jq -r '.model // "unset"' "$config")
  warn=$(jq -r '.ctx_warning_threshold // "null"' "$config")
  handoff=$(jq -r '.ctx_handoff_threshold // "null"' "$config")
  max_s=$(jq -r '.max_session_seconds // "default(255600)"' "$config")
  enabled=$(jq -r '.enabled // "true"' "$config")

  # 1M flag check from .env (operative line, not commented)
  disable_1m="no"
  if [[ -f "$env_file" ]] && grep -qE "^[^#]*CLAUDE_CODE_DISABLE_1M_CONTEXT=true" "$env_file" 2>/dev/null; then
    disable_1m="yes"
  fi

  # MCP allowlist source
  mcp_mode="(unset)"
  if [[ -f "$settings" ]]; then
    enable_all=$(jq -r '.enableAllProjectMcpServers // false' "$settings")
    allowlist_count=$(jq -r '(.enabledMcpjsonServers // []) | length' "$settings")
    if [[ "$enable_all" == "true" ]]; then
      mcp_mode="ALL"
    elif (( allowlist_count > 0 )); then
      mcp_mode="$allowlist_count"
    fi
  fi

  # Build flags
  flags=""
  read -r exp_model exp_warn exp_handoff < <(expected_for "$name")
  [[ "$model" != "$exp_model" ]] && flags+="MODEL "
  [[ "$warn"  != "$exp_warn"  ]] && flags+="WARN "
  [[ "$handoff" != "$exp_handoff" ]] && flags+="HOFF "
  [[ "$mcp_mode" == "ALL" ]] && flags+="MCP-ALL "
  [[ "$enabled" == "false" ]] && flags+="DISABLED "

  # max_session_seconds: skip for devops-c (intentionally 255600)
  if [[ "$name" != "devops-c" ]]; then
    if [[ "$max_s" =~ ^[0-9]+$ ]] && { (( max_s < 25200 )) || (( max_s > 32400 )); }; then
      flags+="MAX_S "
    fi
  fi

  # 1M flag check: should be DISABLED on non-opus (moot but tidy); ENABLED on opus
  if [[ "$model" == "opus" && "$disable_1m" == "yes" ]]; then
    flags+="1M-OFF "
  fi

  total_rows=$((total_rows + 1))
  if [[ -n "$flags" ]]; then
    drift_rows=$((drift_rows + 1))
    marker="[DRIFT]"
  else
    marker=""
  fi

  printf "%-15s %-14s %-5s %-5s %-7s %-10s %-6s %s%s\n" \
    "$name" "$model" "$warn" "$handoff" "$max_s" "$disable_1m" "$mcp_mode" "$flags" "$marker"
done

printf -- "--------------------------------------------------------------------------------\n"
echo "checked: $total_rows  drift: $drift_rows"

# Exit non-zero if any drift, so CI / cron can detect.
[[ "$drift_rows" -eq 0 ]] || exit 1
