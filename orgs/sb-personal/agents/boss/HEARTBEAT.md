# Heartbeat Checklist — Orchestrator (boss). EXECUTE EVERY STEP. SKIP NOTHING.

Runs every 4h. Full step references: `.claude/skills/heartbeat/SKILL.md`.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary>"
```

`update-heartbeat` refreshes the dashboard status field; `log-event heartbeat agent_heartbeat` (Step 4) appends to activity. Both required, not interchangeable.

## Step 2: Sweep inbox

```bash
cortextos bus check-inbox
# for each: process, then cortextos bus ack-inbox "<id>"
```

Un-ACK'd messages re-deliver after 5 min. Target: 0 after the sweep.

## Step 3: Fleet health (orchestrator — before your own tasks)

```bash
cortextos bus read-all-heartbeats
cortextos bus list-approvals --format json
cortextos bus list-tasks --project human-tasks --status pending
```

- Heartbeat >5h old → alert that agent, flag in memory
- Approval pending >4h → ping user via Telegram
- [HUMAN] task pending >4h → ping user

Full references: `.claude/skills/agent-management/SKILL.md`, `approvals/SKILL.md`, `human-tasks/SKILL.md`.

## Step 3a: Disk pressure check (quarterly)

A full data volume silently kills every Bash call. Spot-check disk pressure quarterly (Mar / Jun / Sep / Dec); page Saurav at ≥98% so a backlog of caches doesn't take the fleet down.

```bash
DISK_PCT=$(df -h /System/Volumes/Data | awk 'NR==2 {gsub("%","",$5); print $5}')
[ "$DISK_PCT" -ge 98 ] && cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "URGENT — disk at ${DISK_PCT}%. Bash will start failing — clear ~5Gi NOW."
```

## Step 3c: Fleet-wide context relay sweep (Protocol D2 safety net)

Real-time path propagates within 60s of receipt; this sweep catches missed ones (long tool runs, race conditions, mid-restart receipts).

```bash
SINCE=$(date -u -v-4H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '4 hours ago' +%Y-%m-%dT%H:%M:%SZ)
INBOUND=$CTX_ROOT/logs/$CTX_AGENT_NAME/inbound-messages.jsonl
TRIGGER_RE='based in|flying|flight|landed?|back online|offline|afk|in meeting|out for|vacation|OOO|timezone|work hours|focus|priority|goal|travel|schedule|urgent'

jq -c --arg since "$SINCE" 'select(.timestamp > $since and (.text | test("'"$TRIGGER_RE"'"; "i")))' "$INBOUND" | while read -r MSG; do
  MSG_ID=$(echo "$MSG" | jq -r '.message_id')
  # Check propagation: if no fleet_context_propagated event with this msg_id, broadcast per Protocol D2 (see CLAUDE.md).
done
```

Targeted-not-fleet-wide messages: log `fleet_context_propagated` with `propagated_to: []` and a `targeted_not_fleet_wide` reason — analyst's watch accepts that.

## Step 3d: Context-discipline check

```bash
cortextos bus context-update
cat "$CTX_ROOT/state/$CTX_AGENT_NAME/context-pct.json" | jq '{pct, severity}'
```

Severity → action:

- `green` / `soft` — log a note, no autonomous action
- `yellow` / `orange` — log a note **and** run the compact-nudge block below; agents cannot invoke `/compact` themselves
- `red` — `cortextos bus hard-restart --reason "context-red"`

At yellow/orange, run:

```bash
PCT=$(jq -r .pct "$CTX_ROOT/state/$CTX_AGENT_NAME/context-pct.json")
bash $CTX_FRAMEWORK_ROOT/scripts/comms/send-telegram-guarded.sh "$CTX_TELEGRAM_CHAT_ID" \
  "context ${PCT}% — safe-boundary /compact recommended. Paste: /compact preserve: current branch, last 5 commits, in-flight TODO/blockers, spec paths. drop: completed evaluator transcripts, deep-eval on merged PRs, resolved exploration chains."
```

Guarded-send dedupes identical text within 30 min — re-fires on next heartbeat are no-ops until operator acts. Full canned-prompt library: `docs_archive/code-quality/compact-instructions.md`.

## Step 3b: Own task queue

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

Pick highest pending. in_progress >2h → complete or update. No tasks → re-read GOALS.md, generate tasks for specialist agents.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Daily memory

Append heartbeat checkpoint to `memory/$(date -u +%Y-%m-%d).md`. Template: `.claude/skills/memory-discipline/SKILL.md`.

## Step 6: Org goals state

```bash
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

- `daily_focus_set_at` ≠ today AND before 10 AM → trigger morning review (`.claude/skills/morning-review/SKILL.md`)
- `north_star` empty → ping user
- Any agent with empty `goals.json` → write theirs, regenerate GOALS.md

## Step 7: Resume work

Pick highest-priority task. `update-task in_progress` → do the work → `complete-task --result`.

## Step 8: Guardrail self-check

Did I skip any procedures? Log:

```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
```

## Step 9: Memory + KB refresh

If you learned something durable, append to MEMORY.md. Then:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
```

Skip if `GEMINI_API_KEY` not configured.

---

A heartbeat with 0 events and 0 memory updates = invisible work. Target: ≥2 events and ≥1 memory update per cycle.
