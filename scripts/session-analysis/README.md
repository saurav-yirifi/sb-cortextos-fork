# session-analysis

Reads Claude Code's per-session JSONL logs (`~/.claude/projects/<encoded-cwd>/*.jsonl`)
and reports where the tokens went. Stdlib-only Python; no install step.

## Usage

```bash
# from any project root — auto-detects the matching ~/.claude/projects dir
python3 scripts/session-analysis/analyze.py <subcommand> [opts]

# or point at a specific project
python3 scripts/session-analysis/analyze.py --project-dir ~/.claude/projects/<encoded> <subcommand>
```

### Subcommands

| Command | Reports |
|---|---|
| `summary` | Project totals (tokens + USD), per-session table sorted by spend, with branch + agent-name tags. |
| `session <id-or-prefix>` | One session in depth: tool-use distribution, top-N largest turns, hourly tokens. |
| `tools` | Tool-call totals across every session in the project. |
| `compact-candidates [--threshold K]` | Turns where `/compact` would likely have helped — high cache_read AND a safe boundary (text-only turn or 5-min idle gap). |
| `projects [--limit N]` | Cross-project leaderboard across all of `~/.claude/projects/`. |

USD is estimated using public Anthropic Opus 4.x list pricing — the constants
are at the top of `analyze.py`; update if Anthropic changes them. The estimate
ignores any plan discounts.

### Examples

```bash
python3 scripts/session-analysis/analyze.py summary
python3 scripts/session-analysis/analyze.py session 28ec1a74 --top 5
python3 scripts/session-analysis/analyze.py tools
python3 scripts/session-analysis/analyze.py compact-candidates --threshold 350
python3 scripts/session-analysis/analyze.py projects --limit 20
```

## What the JSONL contains

- `assistant` events carry `message.usage` — `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, plus a
  `cache_creation.ephemeral_{5m,1h}_input_tokens` breakdown used for accurate
  USD attribution.
- `agent-name` events tag a session with a subagent role label.
- `isSidechain: true` on an assistant event means it ran inside an Agent
  subagent — this is what separates "main thread cost" from "subagent cost".
- `gitBranch`, `cwd`, `model`, `version` ride on every assistant event.

## What's worth adding next

Ideas in rough priority order — open if/when we want them:

1. **Hook impact.** `system` events sometimes log hook stdout/stderr; large
   hook output inflates every subsequent cache_read. A `hooks` subcommand
   could attribute tokens to specific hook scripts.
2. **Per-cwd attribution within a session.** Multi-repo work flips `cwd`;
   group tokens by `cwd` to spot expensive directory hops.
3. **Cache-miss detection.** A turn whose `cache_read` drops sharply vs the
   previous turn is either a fresh prompt or a 5-min TTL expiry — separating
   them shows where caching policy is wasted.
4. **Per-turn p50/p90/p99 cache_read curve.** Single number per session
   today; a percentile view shows whether the cost is a long tail (many
   small turns) or a fat head (a few huge turns).
5. **Prompt extraction.** Pull the first 200 chars of every `user` event so
   `summary` can show "this session was about X" without manual grepping.
6. **Real subagent attribution.** Most cortextos sessions show zero
   `isSidechain` traffic because subagent runs land in their *own* JSONL
   under a different project dir. A correlation pass across `~/.claude/projects/`
   (matching by `parentSessionId` or by Agent tool_use id) would unify them.
7. **CSV / JSON output.** Add `--json` so the reports feed downstream tooling.
8. **Live tail.** Watch the active JSONL and stream a running USD/h estimate
   — complement to `scripts/self-healing/usage-monitor.sh` which uses ccusage.
9. **Diff between two sessions** — useful for "was this rerun cheaper than
   the original".

## Findings from the initial run (2026-05-11)

Numbers are pulled from `summary` / `session 28ec1a74` / `projects`.

- **`sb-cortextos-fork` project total: 182.7M tokens, ~$446.** One session
  (`28ec1a74`, the BL-004 fleet-wedge / context-discipline session) is **81%**
  of that spend: 146.5M tokens, ~$334, all on the main thread (zero
  `isSidechain`). It ran ~600 turns in a 2-hour 22:00–00:00Z window with
  cache_read climbing to ~430K/turn near the end. `compact-candidates
  --threshold 350` shows dozens of text-only boundaries where /compact would
  have been safe — none were taken. That's exactly the failure mode
  `.claude/rules/code-quality/compact-instructions.md` exists to prevent.
- **Bash is the dominant cost driver.** 348 calls across the project pulled
  62.0M cache_read — roughly 35% of all project tokens. Trim shell loops or
  break them across compact boundaries.
- **Cross-project leaderboard is sobering.** `sb-claude-jarvis` alone:
  3.6B tokens, ~$9.2k estimated. Four `sb-cortextos-fork-orgs-sb-personal-agents-*`
  directories each clock $2–2.7k. Subagent / org-agent traffic ends up under
  its OWN `~/.claude/projects/<encoded-cwd>/` entry, so the main project's
  "no sidechain traffic" number is misleading until idea 6 above is built.
