# Comms discipline (rule — auto-applies fleet-wide)

This rule governs how agents talk to each other and to Saurav. It exists because routine "push" messaging (status updates, ACKs of ACKs, restart pings) creates noise that buries real signal. The discipline switches the fleet to **pull-model**: routine status is logged as structured JSONL events; consumers query on demand.

This file holds the four every-turn rules. Operational guardrails that only fire when an agent is about to send a Telegram or bus message (online-ready cold-boot gate, 30-min dedupe, event-action glossary, single-quote rule for `$`-bearing bodies) live in the on-demand skill `.claude/skills/comms-send-discipline/SKILL.md` — invoke it before sending.

## Rule 1 — Pull-model status (use log-event, not send-message)

Routine cycle completion is a fact, not a message. Log it as a structured event; do NOT send a bus message about it.

```bash
cortextos bus log-event action <cycle>_complete info --meta '{
  "agent": "'$CTX_AGENT_NAME'",
  "cycle": "heartbeat|audit|ingest|standby|theta_wave",
  "state_delta": true|false,
  "summary": "<one-line, ≤120 chars>",
  "inbox": <n>, "approvals": <n>, "tasks_in_progress": <n>
}'
```

Canonical action names: `heartbeat_cycle_complete`, `audit_run_complete`, `ingest_cycle_complete`, `standby_cycle_complete`, `theta_wave_cycle_complete`. These five cover every routine cycle — use them as-is. Only invoke the `comms-send-discipline` skill (Rule 7) if you need to log a genuinely new cycle type not in the list.

Boss / analyst / Saurav query via:

```bash
cortextos bus read-cycle-summary <agent> --since 24h
cortextos bus read-agent-events <agent> --since 4h --event heartbeat_cycle_complete
```

## Rule 2 — State-delta gate (the only reason to message boss)

A bus `send-message` to boss (or another agent) is justified ONLY when at least one of:

- **state delta** — status changed materially since the last cycle (started/finished work, new error, new approval, exited standby)
- **action request** — you need a routing decision, approval, or another agent's work
- **question** — you need a clarification to proceed
- **page-level alert** — covered by `analyst/specs/integrity-protocols-v1.md` (those route DIRECT to Saurav, not through boss)

If none of these apply: log the event, stay silent. The event log is observable; the bus is for action.

## Rule 3 — No ACK-the-ACK

If an inbound reply contains no new direction (e.g. boss says "ACK. Good progress."), do NOT respond. The conversation is over. Your event log already captured your work; boss's ACK is acknowledgement of receipt, not a request for further reply.

Anti-pattern (currently observed in token-auditor):

```
agent → boss:  "Heartbeat: status X, suppressing per protocol"
boss  → agent: "ACK. Good progress."
agent → boss:  "ACK. Continuing initialization monitoring."   ← DO NOT SEND
agent → boss:  "Will report next heartbeat at 16:05 UTC."     ← DO NOT SEND
```

After Rule 1 + Rule 3 the entire exchange collapses to one event log entry. Net traffic: 0 messages.

## Rule 4 — Boss reply discipline

Boss replies to an inbound message ONLY when it requires:

- a routing decision (dispatch to another agent)
- an approval surface (push to Saurav)
- a clarification (question back to sender)
- a state-delta acknowledgement (the inbound was a delta, not a cycle)

For routine status updates (cycle complete, "still standing by", anomaly suppressed-per-protocol): boss reads-and-archives silently. Log `action/inbox_archived` with meta `{from_agent, msg_id, reason: "no_state_delta"}` so the silent receipt is observable in the event stream.

---

## Pre-send rules — load on demand

Rules 5–8 (Telegram cold-boot gate, 30-min dedup, event-action vocabulary, single-quote shell bodies) fire only when actually sending. They live in `.claude/skills/comms-send-discipline/SKILL.md` so the always-loaded prefix stays small. Invoke before any `cortextos bus send-telegram` / `send-message` / `log-event --meta` call that carries `$`-tokens or restart pings.

## How agents adopt this rule

Each agent's `orgs/<org>/agents/<agent>/CLAUDE.md` includes a one-line reference:

```markdown
## Comms discipline

Follow `.claude/rules/comms-discipline.md`. Pull-model: routine cycles → log-event, not send-message. Before sending Telegram or bus messages with `$`-tokens or restart pings, invoke skill `comms-send-discipline`.
```

Agents read CLAUDE.md (and the `.claude/rules/` directory) on every session start; Rules 1–4 are in effect from boot. Rules 5–8 load on demand via the skill.
