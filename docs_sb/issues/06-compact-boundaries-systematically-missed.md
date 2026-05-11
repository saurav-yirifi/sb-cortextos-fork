# 06 — `/compact`-eligible boundaries systematically missed across sessions

**Severity:** P1 (recurring cost driver, root cause of issue 01)
**Status:** Open
**Source:** `scripts/session-analysis/analyze.py compact-candidates --threshold 350` (2026-05-11)

## Evidence

Inside session `28ec1a74`, the analyzer finds **dozens** of turns that meet both criteria:

- `cache_read + cache_create ≥ 350K tokens` (well into the orange/red severity band for a 1M-context Opus session, per `compact-instructions.md`'s threshold table).
- AND the turn is either text-only (no `tool_use`) or is followed by a ≥5-minute idle gap.

A representative sample (all from session `28ec1a74`, 2026-05-08T23:00–23:21Z):

```
23:07:40  cr= 348.5K  (text-boundary)
23:08:19  cr= 350.2K  (text-boundary)
23:10:36  cr= 354.5K  (text-boundary)
23:11:15  cr= 358.0K  (text-boundary)
23:13:46  cr= 362.6K  (text-boundary)
23:14:32  cr= 368.4K  (text-boundary)
23:15:15  cr= 372.3K  (text-boundary)
23:19:10  cr= 378.6K  (text-boundary)
23:21:48  cr= 382.0K  (text-boundary)
…
```

Every one of these was a moment where:

1. The agent had just produced a text-only reply (or the operator paused ≥5 minutes — natural human breakpoint).
2. Context was already past the 1M-context orange threshold (42–50 %).
3. `compact-instructions.md` documents a canned operator prompt for exactly this case.
4. Nothing fired. The next turn re-paid the full 350K+ cache_read tax. Multiply by ~30 missed boundaries and you have the bulk of this session's $334 spend.

## Root cause

Identical to issue 01 — `/compact` is operator-typed, agent can't invoke it, no automated surface tells the operator "now is the cheap moment." Issue 06 is the *operational* expression of the *systemic* problem in issue 01.

## Action items

1. **Heartbeat hint (already proposed in issue 01).** When the analyzer's criteria are met *in real time*, the agent emits a one-line operator-facing nudge with the canned prompt pre-quoted. Operator copy-pastes; one keystroke `/compact <quoted-text>`.
2. **`compact-candidates` should run on a cron.** Lightweight: every 10 min, scan the active session's JSONL tail, emit a Telegram message if a candidate appears within the last 5 min of activity. Same pattern as `scripts/self-healing/usage-monitor.sh` but session-specific.
3. **Track misses retrospectively.** On SessionEnd, `analyze.py session <id>` should report `missed_compact_boundaries: N` and bus-event it. Feed that number to the dashboard. Goal over time: drive it toward zero.
4. **Tune `ctx_handoff_threshold` per the existing rule.** `compact-instructions.md` flags 1M-Opus agents specifically — default `ctx_handoff_threshold: 80` is decorative because Claude Code auto-compacts at ~42–45 %. **All Opus-1M agent configs should explicitly set `ctx_handoff_threshold: 50`** to match the red severity boundary. Audit the existing fleet's `config.json` files in `orgs/*/agents/*/`. This is a config-only change, no code.
5. **Verify fix:** re-run `compact-candidates --threshold 350` on a fresh long session. The number of text-only candidates after the operator first sees the hint should drop to zero (because the operator compacts when nudged).

## Quick wins

- (4) is the lowest-effort, highest-leverage action. Audit `orgs/*/agents/*/config.json` for `ctx_handoff_threshold` and flag any 1M-Opus agent with the legacy 80 default. One PR.
- (1) requires harness work; depends on whether the heartbeat surface in `compact-instructions.md`'s Layer 1b is actually wired into the agent loop today, or if it's still aspirational.

## Adjacent rules / docs

- `.claude/rules/code-quality/compact-instructions.md` — threshold table + canned prompts (already exists).
- `.claude/rules/code-quality/agent-side-compact-not-invokable.md` — why agents can't self-compact (already exists).
- `scripts/self-healing/usage-monitor.sh` — model for the Telegram-alert plumbing the new cron would reuse.
