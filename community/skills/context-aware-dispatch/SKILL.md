---
name: context-aware-dispatch
effort: low
description: "When orchestrators dispatch work to a specialist agent via cortextos bus send-message, decide whether to set --fresh-start so the receiver hard-restarts before processing. Use this when the new task is meaningfully unrelated to the receiver's last work — fresh conversation context is safer than carrying stale context across an unrelated transition."
triggers: ["dispatch", "send-message", "fresh-start", "task transition", "switch task", "unrelated work", "boss dispatch"]
---

# Context-aware dispatch

> Reference when you (orchestrator / boss) are about to dispatch a new task to a specialist via `cortextos bus send-message`. Decide BEFORE sending: should the receiver hard-restart its session before processing this dispatch?

Source: BL-2026-05-08-004 (engineer context discipline) Phase 3 — Component 4.

## Why this matters

A specialist agent's session conversation accumulates context as it works. When you dispatch an UNRELATED new task into the same session, the agent enters the new task with stale context (the prior task's mental model, recent files read, debugging chains) that doesn't apply — and may even conflict. The agent might:

- Try to relate the new dispatch to the wrong code area
- Carry over assumptions from the previous task
- Hit context-limit pressure faster (the prior task's tokens are still in-window)

Hard-restart-before-processing solves this by giving the receiver a fresh session for the new task. Durable memory (MEMORY.md, daily memory, git log) carries forward; the live conversation drops. The receiver loses nothing irreplaceable; it gains a clean mental slate.

## When to set `--fresh-start`

Set `--fresh-start` when **at least one** of these is true:

| Trigger | Examples |
|---|---|
| Different target repo | last work was cortextos framework, dispatch is a yirifi product feature |
| Different working surface | last work was backend Python, dispatch is React UI |
| Different code area, low overlap | last work was schema migrations in `/api/`, dispatch is `/auth/` middleware |
| Different problem class | last was a debugging session, dispatch is greenfield design |
| Receiver has been on the same conversation for many hours | accumulated noise outweighs continuity value |

**Don't** set `--fresh-start` when:

- Continuation of the same feature/spec/branch (same task, next phase)
- Quick clarification round-trip (adding info to an in-flight discussion)
- Bug-fix on work the receiver just completed (continuation)
- Receiver's session was just spawned (already fresh)

When in doubt → don't set the flag. The receiver will run its own self-detection heuristic when no flag is present (see receiver's `CLAUDE.md` "On dispatch receipt"). Your hint augments the receiver's judgment; absent your hint the receiver decides.

## How to set the flag

```bash
# Unrelated dispatch — receiver should hard-restart before processing
cortextos bus send-message <agent> normal '<dispatch text>' --fresh-start

# Explicit override: even if the dispatch text looks unrelated, tell the receiver NOT to restart
# (use this when context continuity outweighs the freshness benefit)
cortextos bus send-message <agent> normal '<dispatch text>' --no-fresh-start

# No flag — receiver runs its own heuristic
cortextos bus send-message <agent> normal '<dispatch text>'
```

## What the receiver does

Receivers (specialist agents — `engineer`, `fullstack`, `devops`, etc.) read the `[FRESH-START: ...]` annotation on the formatted message and follow their `CLAUDE.md` "On dispatch receipt" rule:

1. Read annotation (true / false / absent)
2. Check cooldown via `cortextos bus check-fresh-restart-cooldown` (skip on the explicit-no branch)
3. Apply 6-row decision matrix (hint × heuristic × cooldown → action)
4. Execute (commit safety-wip + `cortextos bus hard-restart --fresh-start --reason "..."`) OR log-and-skip

The cooldown (default 30 minutes) protects against thrash on rapid back-to-back unrelated dispatches BUT explicit `--fresh-start` from you BYPASSES the cooldown — your intent overrides the heuristic guard. Use `--fresh-start` deliberately, not as a default.

## Anti-patterns

- **Don't set `--fresh-start` on every dispatch.** Most dispatches are continuations or related; the flag's value is in the genuine task-transition case. Setting it indiscriminately churns through receivers' sessions and loses useful context.
- **Don't set `--fresh-start` for clarification messages.** A clarification is by definition continuation of an existing thread — no transition to mark.
- **Don't combine `--fresh-start` with `--reply-to`.** A reply is by definition continuation; the flags conflict semantically. The CLI doesn't enforce this today (TODO if it becomes an issue), but it's a sender-side anti-pattern.
- **Don't use `--fresh-start` to "force a restart" when the real intent is context-overflow recovery.** That path goes through FastChecker (Layer 2) at the daemon level, not through dispatch hints.
- **Don't second-guess the receiver's heuristic by always setting `--no-fresh-start`.** The override exists for the rare case where the dispatch text LOOKS unrelated but actually depends on the receiver's current state. Use it surgically.

## Examples

**Boss dispatching engineer from jarvis retrofit phase 2 to a wholly different cortextos framework feature:**

```bash
# UNRELATED — different repo, different code area, different spec
cortextos bus send-message engineer high 'Pick up BL-2026-05-09-XYZ — the cortextos hook refactor. Spec at orgs/sb-personal/backlog/...' --fresh-start
```

**Boss dispatching engineer from BL-003 phase 2 to BL-003 phase 3:**

```bash
# RELATED — same backlog item, sequential phases, same branch family
cortextos bus send-message engineer normal 'BL-003 phase 2 merged. Phase 3 next per spec § Component 4.'
# (no --fresh-start; receiver heuristic will see same-spec-name and treat as related)
```

**Saurav-direct dispatch with override (rare):**

```bash
# Saurav knows the dispatch text references a different repo BUT the engineer's current
# session has loaded context that's directly applicable (e.g. engineer just researched the
# pattern Saurav now wants applied to a sibling repo)
cortextos bus send-message engineer normal 'Apply the dedup pattern from cortextos to jarvis at this path...' --no-fresh-start
```
