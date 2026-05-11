# 01 — Context-discipline rules weren't applied to their own authoring session

**Severity:** P1 (learning incident, no immediate production impact)
**Status:** Open
**Source:** `scripts/session-analysis/analyze.py` on `~/.claude/projects/-Volumes-MacStorage-UserData-0devprojects-sb-cortextos-fork/` (2026-05-11)

## Evidence

Session `28ec1a74-f863-42ac-932b-2d051c6baa70` (tagged `agent-fleet-wedge-fix`) consumed **146.5M tokens (~$334 list)** in one ~2-hour window on 2026-05-08 22:00–00:00Z. That is **81 %** of this project's entire recorded spend (182.7M, ~$446).

- 583 assistant turns; near the end each turn was loading ~430K of cached context just to issue one Bash call.
- `cache_read` alone: 143.5M tokens — 97 % of the session's spend.
- Output across the whole session: 638K tokens. **The cost wasn't generation; it was the per-turn re-read of accumulated context.**
- `compact-candidates --threshold 350` finds dozens of text-only boundary turns and 5-min idle gaps inside this session where `/compact` would have been safe. None were taken.
- The session that authored / refined `.claude/rules/code-quality/compact-instructions.md` is the session that demonstrates the failure mode that file exists to prevent. Direct dogfood gap.

## Root cause hypothesis

`/compact` is operator-typed at the prompt — the agent itself cannot invoke it (this is already documented in `code-quality/agent-side-compact-not-invokable.md`). The agent has no automated signal that surfaces "we are at a safe boundary AND context is yellow/orange; recommend /compact" to the operator. So the boundary passes, context keeps growing, and cost compounds.

## Action items

1. **Heartbeat / status-line surface that flags compact-eligible moments.** When `context-pct.json` is yellow or orange AND the latest turn is text-only (no tool_use) or the agent has been idle ≥60s, emit a one-line operator hint: `"context yellow at <pct>% — /compact <canned-prompt> would be safe here"`. Quote the relevant canned prompt from `compact-instructions.md` inline so the operator can copy-paste in one keystroke.
2. **Auto-tag long-running sessions.** If a single session exceeds a budget threshold (default: 50M cache_read tokens OR 4 hours wall-clock), log a `bus warn` event so it surfaces in the dashboard and Telegram.
3. **Post-session retro hook.** On `SessionEnd`, run `analyze.py session <id>` and append the summary to `MEMORY.md` (or a separate `session-retros/` dir). Cheap accountability — if we run another 146M session, we'll see it the next morning.
4. **Verify fix:** re-run the analyzer after the next multi-phase feature; the single-session-max should fall under 30M tokens or have at least one explicit /compact event in the JSONL.

## Class of trap

Same shape as `code-quality/auditor-misses-themselves.md`: the agent shipping a fleet-wide rule has a blind spot at exactly the role doing the shipping. Worth one line in that subfile noting this incident as a second data point.
