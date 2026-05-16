#!/usr/bin/env bash
#
# audit-prefix-size.sh — estimate always-loaded prefix size per agent
#
# Sums the byte size of every file Claude Code will load on agent boot
# via cwd traversal (repo CLAUDE.md + .claude/rules/*.md) plus the agent's
# own CLAUDE.md / IDENTITY.md / SOUL.md / GOALS.md / GUARDRAILS.md /
# HEARTBEAT.md / MEMORY.md (first 200 lines, per Claude Code's loading
# rule), and divides by 4 for a token estimate.
#
# Usage:  bash scripts/audit-prefix-size.sh [org]   (default: sb-personal)
# Deps:   wc, awk

set -euo pipefail

ORG="${1:-sb-personal}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$ROOT/orgs/$ORG/agents"

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "ERROR: $AGENTS_DIR does not exist" >&2
  exit 2
fi

# Repo-level always-loaded files (same for every agent)
repo_files=(
  "$ROOT/CLAUDE.md"
)
# Include all rules
while IFS= read -r f; do
  repo_files+=("$f")
done < <(find "$ROOT/.claude/rules" -name "*.md" -type f 2>/dev/null)

# Per-agent always-loaded files
agent_files_pattern=(
  "CLAUDE.md"
  "IDENTITY.md"
  "SOUL.md"
  "GOALS.md"
  "GUARDRAILS.md"
  "HEARTBEAT.md"
)

# MEMORY.md is loaded but only first 200 lines — handle separately

bytes_of() {
  local f=$1
  [[ -f "$f" ]] && wc -c < "$f" | tr -d ' ' || echo 0
}

# Compute repo (shared) total once
repo_total=0
for f in "${repo_files[@]}"; do
  b=$(bytes_of "$f")
  repo_total=$((repo_total + b))
done

printf "Repo-level always-loaded (shared across all agents):\n"
for f in "${repo_files[@]}"; do
  b=$(bytes_of "$f")
  rel=${f#$ROOT/}
  printf "  %-50s %6d B  (~%5d tok)\n" "$rel" "$b" "$((b / 4))"
done
printf "  %-50s %6d B  (~%5d tok)\n\n" "TOTAL (repo)" "$repo_total" "$((repo_total / 4))"

printf "Per-agent prefix (repo + agent files):\n"
printf "%-15s %-10s %-10s %-10s\n" "AGENT" "BYTES" "TOKENS" "FILES"
printf -- "----------------------------------------------------\n"

for agent_dir in "$AGENTS_DIR"/*/; do
  name=$(basename "$agent_dir")
  agent_total=0
  file_count=0

  for f in "${agent_files_pattern[@]}"; do
    path="$agent_dir$f"
    if [[ -f "$path" ]]; then
      b=$(bytes_of "$path")
      agent_total=$((agent_total + b))
      file_count=$((file_count + 1))
    fi
  done

  # MEMORY.md (first 200 lines only)
  mem="$agent_dir/MEMORY.md"
  if [[ -f "$mem" ]]; then
    mem_bytes=$(head -200 "$mem" 2>/dev/null | wc -c | tr -d ' ')
    agent_total=$((agent_total + mem_bytes))
    file_count=$((file_count + 1))
  fi

  full=$((repo_total + agent_total))
  printf "%-15s %-10s %-10s %s\n" "$name" "$full" "~$((full / 4))" "$file_count"
done
