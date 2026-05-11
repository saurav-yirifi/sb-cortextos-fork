# 03 — Subagent token spend is invisible from the parent session's JSONL

**Severity:** P1 (observability blocker)
**Status:** Open
**Source:** `scripts/session-analysis/analyze.py projects` (2026-05-11)

## Evidence

Across `~/.claude/projects/` the leaderboard shows:

| Project (encoded cwd) | Total tokens | Est. USD (list) |
|---|---:|---:|
| `sb-claude-jarvis` | 3.6B | **$9,212** |
| `sb-astrology` | 950.7M | $2,026 |
| `sb-cortextos-fork-orgs-sb-personal-agents-<X>` (×4 dirs) | 500M–910M each | $2.0k–$2.7k each |
| `founders-peak-book` | 648.9M | $1,663 |
| `axi-sales-agent` (×2) | 307M–403M | $694–$1,041 |
| `sb-cortextos-fork` (this project, the main session dir) | 182.9M | $447 |

The main `sb-cortextos-fork` dir reports **zero** `isSidechain` traffic in every session. But the four `sb-cortextos-fork-orgs-sb-personal-agents-*` dirs (boss, analyst, devops, engineer/fullstack) total **~$9k** of org-agent activity that the parent dir's analyzer never sees.

This isn't a bug in `analyze.py` — it's how Claude Code lays out the data. Each agent process (spawned by cortextOS daemon under its own working directory) creates its own `~/.claude/projects/<encoded-cwd>/` tree. There's no parent→child pointer in the JSONL events; `isSidechain` only fires for **in-process** `Agent` tool subagents (which we barely use), not for cortextOS-spawned agents.

## Concrete impact

- **`summary` for the main project understates true cost by ~20×.** Real BL-004 spend isn't $446 — it's $446 + whatever fraction of the four org-agent dirs was BL-004 work (likely $2k–$5k more).
- **The "no subagent traffic" finding in issue 01 is misleading.** There WAS subagent traffic — it just lived in sibling project dirs.
- **No way today to ask "how much did *this feature* cost across boss + engineer + analyst + fullstack + devops?"**

## Action items

1. **Correlation pass — short term.** Walk all `~/.claude/projects/*/` JSONLs, build a map keyed on `(branch, time-window)`. When five agents all show activity on the same branch within the same hour, attribute them to one logical feature. Add this as `analyze.py feature <branch-name>`. ~50 lines of code; uses data we already have.
2. **Cortextos daemon → bus event when spawning an agent — long term.** When the daemon spawns an agent, emit `bus log-event agent_session_started --meta '{"parent_session": "...", "child_session": "...", "agent_role": "..."}'`. That gives us an explicit parent pointer instead of a heuristic correlation. Lives in `src/daemon/agent-manager.ts` near the spawn site.
3. **Dashboard view per feature.** Once (1) lands, surface "BL-XXX cost: $YY across 5 agents" on the dashboard. Today the dashboard shows agent uptime but not agent spend.
4. **Verify fix:** pick one recent BL item, run `analyze.py feature feat/<branch>` once correlation lands, and confirm we get a 4–6× higher number than the parent-dir-only view.

## Why this matters

Cost is one signal. The bigger one is: we can't currently answer "which agent burned the most tokens on feature X?" without grepping six JSONL trees by hand. That blocks the per-agent CLAUDE.md tuning, the per-role context-discipline thresholds, and any "promote a primitive to a different agent because it's cheaper there" decision.
