# 05 — TaskCreate carries disproportionate cache_create overhead

**Severity:** P3 (efficiency, not correctness)
**Status:** Open — needs investigation before action
**Source:** `scripts/session-analysis/analyze.py tools` (2026-05-11)

## Evidence

Tool-level breakdown across all sessions:

| Tool | Calls | cache_read | **cache_create** | cache_create / call |
|---|---:|---:|---:|---:|
| Bash | 348 | 62.0M | 1.0M | 2.9K |
| TaskCreate | **11** | 1.6M | **531.9K** | **48.4K** |
| TaskUpdate | 19 | 5.4M | 266.3K | 14.0K |
| Read | 33 | 6.0M | 57.9K | 1.8K |
| Skill | 1 | 15.4K | 157.9K | 157.9K |
| Edit | 33 | 8.3M | 128.5K | 3.9K |
| Write | 11 | 2.7M | 14.9K | 1.4K |

`TaskCreate` creates **17× more cache per call than Bash**. `TaskUpdate` is ~5× more. `Skill` (single call) created 158K of cache — but that's a one-time skill-loading cost, expected.

## Hypothesis

`cache_create` charges happen when context that wasn't previously cached gets written into the 1h (or 5m) ephemeral cache. A 48K cache-create per TaskCreate call suggests one of:

1. **The Task tool's system prompt is being re-cached on each call** — possibly because Task tool data injection (current task list, task definitions) breaks the existing cache prefix.
2. **TaskCreate is appending the new task to a list that's part of the cached prefix**, forcing the suffix-after-the-list to re-cache.
3. **Some other instrumentation** writes a fresh ephemeral block per Task* operation.

Cost impact at this volume is modest (~$16 list across all 30 Task* calls). But the ratio is suspicious enough to investigate before it scales.

## Action items

1. **Inspect one TaskCreate turn in detail.** Read the assistant event right before and right after a TaskCreate from session `28ec1a74`. Compare what's in the cached blocks. If the Task tool injects state that mutates between calls, the cache prefix breaks every time and the cost is structural.
2. **Compare with TodoWrite-style tools** if any old sessions used them — does the older pattern have the same cache-create profile, or is this specific to the new Task* tool family?
3. **Decide:** is this a Claude Code harness issue (file with Anthropic / claude-code repo), a usage-pattern issue (we call TaskCreate too eagerly), or expected?
4. **If usage-pattern:** add a rule — "batch task creates into one TaskCreate call when possible; don't fragment into N single-task creates."
5. **If harness:** open an upstream issue with the data from this analyzer + a minimal repro.
6. **Verify fix:** re-run `analyze.py tools` after change. The cache_create / call number on TaskCreate should drop into the Bash range (<5K/call).

## Why P3 not higher

11 TaskCreate calls × 48K cache_create ≈ 530K tokens ≈ **$10 list** total. Not breaking the budget. But the analyzer noticed it because the pattern is anomalous, and anomalies that scale poorly bite later — flagging while it's still cheap to investigate.
