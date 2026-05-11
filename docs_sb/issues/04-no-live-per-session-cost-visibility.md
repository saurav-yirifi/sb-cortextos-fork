# 04 — No live per-session cost visibility while a session is running

**Severity:** P2 (operational blind spot)
**Status:** Open
**Source:** comparison of `scripts/self-healing/usage-monitor.sh` with what `analyze.py` reveals after the fact (2026-05-11)

## Evidence

We already have `scripts/self-healing/usage-monitor.sh` — it calls `ccusage blocks --json`, computes USD/hr for the active 5-hour Claude Code session window, sends Telegram alerts on tier transitions (GREEN/YELLOW/RED). Good as a high-level alarm.

What it can't tell us:

- **Which session** is burning the tokens. Tier flips RED → was it the BL-004 fullstack session, or the devops agent, or interactive operator work?
- **Whether a single session is running away** (e.g. 146.5M in 2 hours, like `28ec1a74` did). Tier alerts fire on the aggregated 5-hour window — by the time it flips, the runaway has already happened.
- **Whether `/compact` would help right now.** No surface tells the operator "the active session is 380K context with a text-only boundary — now is the cheap moment."

Concretely: on 2026-05-08, `28ec1a74` burned ~$334 in one window. usage-monitor.sh almost certainly flipped RED at some point during that, but no signal said *"`agent-fleet-wedge-fix` is the runaway — consider /compact"*. The operator had to wait for post-hoc analysis to see it.

## Action items

1. **Live tail mode for `analyze.py`.** Add `analyze.py live [--session <id>] [--interval 30]` that:
   - Watches the most-recently-modified JSONL in the project dir (or a specified session).
   - Every N seconds prints: turns-so-far, cache_read total, USD-so-far, latest cache_read per turn, current branch, last 3 tool calls.
   - Optional `--alert-threshold <USD>` that fires a Telegram message (reuse the bot the self-healing scripts already use) when a single session crosses the threshold.
2. **Statusline integration.** Claude Code surfaces `statusLine` output above the prompt. Have the harness emit `cost: $X.YY · ctx: ZZ%` per turn. We already compute context-pct elsewhere; piggyback the USD calc. This is the cheapest possible "operator awareness" signal — visible without any extra script.
3. **Threshold-driven heartbeat.** When session cache_read crosses 50M (≈$75 list) OR session wall-time exceeds 4h, emit `bus log-event session_budget_alert` so it surfaces in the dashboard + Telegram, naming the specific session id and current branch.
4. **Verify fix:** during the next multi-phase feature, the operator should be able to glance at the prompt (or get a Telegram alert) and see runaway-session shape before it crosses $100 list. Post-merge, `analyze.py summary` should show no session above 30M tokens unless an alert was acknowledged.

## Why pre-emptive matters more than retrospective

The whole point of `compact-instructions.md`'s threshold table (yellow 35–42 %, orange 42–50 %, red ≥50 % on 1M context) is that intervention is cheap **at the boundary**. By the time `analyze.py summary` shows a 146M-token session, the spend has already happened. Live visibility flips the loop from forensic to preventive.
