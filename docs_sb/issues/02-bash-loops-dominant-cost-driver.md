# 02 — Bash-shell loops are the dominant cost driver

**Severity:** P2 (workflow hygiene)
**Status:** Open
**Source:** `scripts/session-analysis/analyze.py tools` (2026-05-11)

## Evidence

Across all 9 recorded sessions in `sb-cortextos-fork`:

| Tool | Calls | cache_read attributed | Output |
|---|---:|---:|---:|
| **Bash** | **348** | **62.0M** | 249.9K |
| Edit | 33 | 8.3M | 49.4K |
| Read | 33 | 6.0M | 22.8K |
| TaskUpdate | 19 | 5.4M | 31.9K |
| ScheduleWakeup | 14 | 4.0M | 6.5K |
| TaskCreate | 11 | 1.6M | 27.7K |
| Write | 11 | 2.7M | 43.8K |
| (rest) | 17 | <2M | <2K |

Bash alone is **~35 % of all project tokens** and **~57 % of all tool-attributed cache_read**. In session `28ec1a74` specifically: 217 of 319 tool calls (68 %) were Bash, attributing 48.9M cache_read.

## Why Bash specifically

A Bash call carries the same cache_read as any other turn — what makes Bash dominant is *frequency*. Three observable patterns from the largest session:

1. **`git status` / `git log` / `gh pr view` polling.** Repeated multiple times per phase to re-check state instead of remembering the last call's output.
2. **Test/build re-runs.** `npm run build` + `npm test` between phases is correct; running them every 2–3 file edits is the cost trap.
3. **Tight retry loops.** When a command fails (eg `gh` rate-limit, network hiccup), the recovery pattern was "try again, then try again, then try again" with full context re-read each iteration.

## Action items

1. **CLAUDE.md guidance: batch Bash calls.** Current `tool-use efficiency` rule in the global CLAUDE.md covers this for file creates ("each create fires a system-reminder refresh"). Add the parallel rule: *"When you need git status + git log + git diff, fire all three in one assistant turn — three sequential single-call turns each pay full cache_read."* Most rounds of "where are we" can be a single multi-line Bash block.
2. **Test/build cadence rule.** Already implicit in `before writing code`. Make it explicit: `npm run build && npm test` runs **once at end of phase**, not after each edit. The pre-commit hook is the gate for actual regressions.
3. **Retry-loop guard.** When the same command fails twice in a row, stop and reason. The third attempt is rarely the one that succeeds; it's a class-of-trap (see `code-quality/network-call-timeouts.md`'s "don't wrap deterministic-too-short in retry-once" line).
4. **Verify fix:** run `analyze.py tools` after the next 2–3 feature merges. Bash share should drop below 40 % of cache_read (currently 57 %). If it stays high, the rule isn't sticking and we need a SessionEnd hook that warns when Bash > 50 % of a session's turns.

## Adjacent rules

- `.claude/rules/code-quality/network-call-timeouts.md` — retry mis-labels deterministic failures as transient.
- Global CLAUDE.md `tool-use efficiency` block — already covers parallel-tool-call discipline; add Bash-batching example.
