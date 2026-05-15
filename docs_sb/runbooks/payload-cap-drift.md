# Runbook — payload-cap-drift alert

A daily check that watches each agent's "read on every boot" files from drifting huge. Pings Telegram once when any agent crosses the cap.

## When you see the alert

```
payload-cap drift: agent=<name> tokens≈<N> (cap=15000). Audit ...
```

Means: that agent's combined `CLAUDE.md + MEMORY.md + HEARTBEAT.md` has grown past the cap. Every session-start of that agent pays the bloat in tokens.

## What it actually checks

For each agent under `orgs/*/agents/*/`, sums bytes in three files:

| File | What's in it |
|---|---|
| `CLAUDE.md` | Operating norms, role, comms discipline, tool reference |
| `MEMORY.md` | Long-term learnings persisted across sessions |
| `HEARTBEAT.md` | Cycle checklist (Steps 1–9) |

Divides by 4 to approximate tokens (rule-of-thumb, fine for drift). Alerts when > `PAYLOAD_CAP_TOKENS` (default 15,000).

## Why 15,000

Issue 08 traced boss's pre-instruction context burn to **67k tokens** — agent files had drifted huge over months. After this session's prune (code-quality archive → Tier 0; MEMORY trim → Tier 1.4), boss is back at ~5.8k. 15k leaves ~2× growth headroom before alerting, which is enough breathing room for legitimate learning accumulation without letting the next 67k creep go unnoticed.

## What to do when it fires

1. **Open the named file(s).** `orgs/sb-personal/agents/<agent>/{CLAUDE,MEMORY,HEARTBEAT}.md`
2. **Apply the Anthropic test to each section:** *"Would removing this cause Claude to make mistakes?"* If no → cut it.
3. **Prune candidates** (this is where the bloat usually lives):
   - `MEMORY.md` entries about closed BLs, expired bake periods, one-shot incidents that became permanent practice
   - `CLAUDE.md` skills-index sections that name skills the agent already discovers via filesystem
   - `HEARTBEAT.md` step descriptions that duplicate what `.claude/skills/*` files cover
4. **Verify under cap.** Re-run the check manually:
   ```bash
   CTX_INSTANCE_ID=default CTX_FRAMEWORK_ROOT="$(pwd)" \
     bash scripts/self-healing/payload-cap-drift.sh
   ```
   Exit 0 = all under; exit 1 = still over.
5. **Restart the agent.** `cortextos hard-restart <agent> --reason "post payload prune"`. New session boots into the smaller prefix.

## Idempotency — won't spam you

State at `~/.cortextos/<instance>/payload-cap-state.tsv`. Each agent has one row: `agent  tokens  cap_state  ts`. Alert fires exactly once per breach episode — re-fires only after the agent drops back under (cap_state="under") and then crosses again.

If you want to re-arm the alert before fixing: `rm ~/.cortextos/default/payload-cap-state.tsv`.

## Tuning

| Variable | Default | When to change |
|---|---|---|
| `PAYLOAD_CAP_TOKENS` | `15000` | Raise to 20k if you start tolerating bigger MEMORY.md after one-off context. Lower to 10k for stricter hygiene. |
| Schedule | daily 09:00 local | Edit `~/Library/LaunchAgents/com.cortextos.payload-cap-drift.plist` to switch to weekly. Add a `Weekday` key (0–6, Sun=0) inside `StartCalendarInterval` alongside `Hour` and `Minute`. |

## False-positive cases

- **Agent just absorbed a major lesson.** If you intentionally added 5k of learnings to MEMORY.md after a sev-1 incident and the entry is load-bearing, it's not bloat — bump `PAYLOAD_CAP_TOKENS` rather than prune the lesson.
- **One-time onboarding fixture.** USER.md / SYSTEM.md aren't counted; only the three files above. If something belongs in a one-time fixture rather than every-session reload, move it to USER.md or SYSTEM.md (out of scope of this monitor).

## Related

- Script: `scripts/self-healing/payload-cap-drift.sh`
- Plist: `scripts/self-healing/com.cortextos.payload-cap-drift.plist.template`
- Family README: `scripts/self-healing/README.md`
- Original incident: `docs_sb/issues/08-boss-bootstrap-context-bloat.md`
- Strategy: `docs_sb/plans/02-context-fix-plan.md` (Tier 5.3)
- PRs: #64 (script) + #65 (installer wiring)
