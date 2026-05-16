---
name: comms-send-discipline
description: "Operational guardrails fired only when an agent is about to send Telegram or bus messages — `online — ready` cold-boot gating, 30-min Telegram dedup window, canonical event-action vocabulary, and the single-quote rule for `$`-bearing message bodies. Loads on demand so the always-loaded prefix stays small. Invoke before calling `cortextos bus send-telegram`, `cortextos bus send-message`, or `cortextos bus log-event --meta` from a shell where the body contains `$`-tokens or dollar amounts."
triggers: ["send-telegram", "send-message", "online — ready", "telegram dedup", "log-event meta"]
---

# Comms send discipline — pre-send rules for Telegram + bus

These four rules are operational guardrails — they only matter when you're about to push a message. Keep them out of every-turn loaded context; invoke this skill at the moment of send.

The every-turn pull-model discipline (log-event vs send-message, state-delta gate, no-ACK-the-ACK, boss reply discipline) lives in `.claude/rules/comms-discipline.md` as Rules 1–4.

## Rule 5 — `online — ready` Telegram only on cold-boot or crash-recovery

Session-start `cortextos bus send-telegram "online — ready"` is gated on restart reason. Skip it when:

- restart reason is `session-refresh` (proactive 6h cron — Saurav doesn't need a ping)
- restart reason is `user-restart` (Saurav initiated; he knows)
- restart reason is `hard-restart` initiated by the agent itself (operational, not noteworthy)

Send it ONLY when reason is `cold-boot` (first start) or `crash-recovery` (previous exit was abnormal). These are the cases Saurav needs to know about.

Discover the reason by reading the most recent line of:

```bash
~/.cortextos/default/logs/$CTX_AGENT_NAME/restarts.log
```

That file is already populated by `src/bus/system.ts` on every restart with the line format `[<ts>] SELF-RESTART: <reason>` or `[<ts>] HARD-RESTART: <reason>`. Zero new infrastructure.

The wrapper script `scripts/comms/send-telegram-guarded.sh` enforces this gate automatically — agents should use it instead of bare `cortextos bus send-telegram` for any "online — ready" style ping.

## Rule 6 — Telegram dedupe (30-minute window per chat)

Use `scripts/comms/send-telegram-guarded.sh` for all Telegram pings to Saurav. The wrapper checks the last-sent cache (`~/.cortextos/default/logs/<agent>/last-telegram-<chatId>.txt`) and the recent `outbound-messages.jsonl`. If identical text was sent to the same chat in the last 30 minutes, the wrapper drops the call and logs `action/telegram_dedup_skipped` so suppression is observable.

This is a belt-and-suspenders defence — Rule 5 should prevent most duplicates already, but the dedupe catches anything Rule 5 misses (e.g. distinct agents restarting in parallel and all firing `online — ready` in the same window).

## Rule 7 — Canonical event-action vocabulary

All cycle-complete events use the suffix `_cycle_complete` so `read-cycle-summary` can find them. All Telegram-skip events use `telegram_dedup_skipped`. All silent boss-archives use `inbox_archived`. Full glossary with required meta keys lives at `community/skills/comms-discipline/event-actions.md`. New cycle types extend the glossary; do not invent ad-hoc event names.

## Rule 8 — Single-quote bus message bodies to prevent caller-side `$`-expansion

When invoking `cortextos bus send-message` / `send-telegram` / `log-event --meta` from a shell (Bash tool, script, terminal), **single-quote** the message body. Double-quotes allow the caller's shell to expand `$var` tokens before `cortextos` ever sees the args — `$0` becomes the shell name (`/bin/zsh`), `$500` becomes empty (unset positional param), and dollar amounts get silently truncated.

Bad (double-quoted — `$500/day` and `$0` get eaten):

```bash
cortextos bus send-message boss normal "budget overshoot: $500/day, $0/sample"
```

Good (single-quoted — `$` survives intact):

```bash
cortextos bus send-message boss normal 'budget overshoot: $500/day, $0/sample'
```

When the body contains a single-quote, end the single-quoted string, escape the quote, restart: `'it'\''s done'`. Or use a heredoc-fed variable:

```bash
body=$(cat <<'EOF'
budget is $500/day; ARGV0=$0
EOF
)
cortextos bus send-message boss normal "$body"   # double-quote a variable is safe; no second-pass expansion
```

The trap is at the **caller side** — `cortextos` itself does not re-shell message bodies (audit 2026-05-16 confirmed `src/bus/`, `src/cli/bus.ts`, `scripts/comms/*` are all clean). Full background: memory `project_bus_message_shell_interpolation`.

If you see an inbound message containing `/bin/zsh`, `/bin/bash`, "USD /day" with no number, or truncation around a `$`, the sender violated this rule — do not file a cortextos bug.

---

## Migration guide for new agents

When spawning a new agent (via `cortextos add-agent` or any future onboarding flow):

1. The agent's CLAUDE.md gets a one-line reference to `.claude/rules/comms-discipline.md` (verbatim — no per-agent customisation needed). Rules 1–4 fire every turn from there.
2. The agent's `config.json` heartbeat cron prompt appends: `"Follow .claude/rules/comms-discipline.md."` — belt-and-suspenders.
3. Restart the agent. On next heartbeat it emits `heartbeat_cycle_complete` events instead of bus messages to boss.

Rules 5–8 (this skill) load on demand when the agent is about to send a Telegram or bus message — no per-agent config needed; the skill's `triggers:` list catches the relevant verbs.

## How operators verify discipline

```bash
# Per-agent cycle summary (replaces 14 chat messages with one CLI call)
cortextos bus read-cycle-summary devops-c --since 24h

# Fleet-wide
cortextos bus read-cycle-summary --since 24h

# Detail for a specific event
cortextos bus read-agent-events token-auditor --since 4h --event audit_run_complete --format json
```
