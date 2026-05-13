# Comms discipline — verification handoff

**Status:** rollout shipped 2026-05-13. This document is for the **next person who picks this up** (boss daemon next heartbeat, Saurav tomorrow morning, another operator next week). Run the checks in the order below; each block is self-contained and copy-pasteable.

**Obsolete when:** all targets in Stage 4 (24h volume regression) are hit, OR a full week passes without a regression. Then delete this file or move it to `docs_sb/archive/`.

---

## Context — what shipped and why this needs verification

Three PRs merged on 2026-05-13 between 17:22–17:42 UTC:

| PR | Title | What it changes |
|---|---|---|
| [#32](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/32) | `feat(comms): pull-model fleet comms discipline` | New rule + CLI + Telegram wrapper. Agents stop pushing routine status, log JSONL events instead. Boss queries on demand. |
| [#34](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/34) | `chore(gitignore): ignore .cortextOS/` | Local state spillover dir |
| [#35](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/35) | `fix(env): replace process.cwd() CTX_ROOT fallback with canonical resolver` | Fixed the silent shadow-write bug where `cortextos bus add-cron` from a repo dir wrote to `./.cortextOS/` instead of `~/.cortextos/<instance>/.cortextOS/`. |

A **post-rollout gap** was also patched (in operator-local `orgs/sb-personal/agents/*/CLAUDE.md`, gitignored — see `boss/memory/2026-05-13.md` `[OPERATOR-ACTING]` entry):

- Each agent's CLAUDE.md had the new "use the wrapper" rule near the top AND the OLD `cortextos bus send-telegram "online — ready"` direct call in the Session Start block further down. The literal command in Session Start won. Patched in boss / engineer / devops / fullstack to use `scripts/comms/send-telegram-guarded.sh`. **Not patched yet: devops-c** (custom multi-message boot Telegrams; deferred to avoid perturbing the codex-runtime A/B trial).

**Why verification is needed:** the discipline is a behavioural contract enforced by agent prompts. Three failure modes are possible:

1. **Behaviour gap** — agent reads the rule but doesn't follow it (LLM compliance failure)
2. **Coverage gap** — there's another bypass we missed (e.g. devops-c)
3. **Tooling gap** — wrapper or CLI has a subtle bug that surfaces only in a specific code path

The checks below catch each of these.

---

## Stage 1 — First heartbeat tick (≤ 4h after rollout)

**When to run:** as soon as the first running agent fires its post-restart heartbeat. Schedule per PR-merge time:

| Agent | Expected first post-restart heartbeat | Cron |
|---|---|---|
| boss | **2026-05-13 19:54 UTC** | 4h |
| token-auditor | **2026-05-13 20:05 UTC** | 4h |
| analyst | **2026-05-13 20:19 UTC** | 8h (intentional HALT bump) |
| devops-c | **2026-05-13 20:43 UTC** | 4h |

### Check 1.1 — Cycle events appearing

```bash
# Fleet view — should show one row per agent post-heartbeat
cortextos bus read-cycle-summary --since 4h
```

**Expected:** at least one `heartbeat` (or `audit` for token-auditor, `standby` for devops-c) row per agent whose heartbeat has fired since the rollout. The `Δ` column should be ` ` (state_delta=false) for routine ticks where nothing changed.

**If empty:** agent fired heartbeat but didn't emit a cycle event → behavioural gap. Check the agent's own daily memory for the heartbeat entry; look for `log-event action *_cycle_complete` in its stdout log:

```bash
grep -E "_cycle_complete|log-event action heartbeat" ~/.cortextos/default/logs/<agent>/stdout.log | tail -10
```

If the agent updated heartbeat but didn't emit a cycle event, the discipline reference in CLAUDE.md was either not read or not followed. Re-check `orgs/sb-personal/agents/<agent>/CLAUDE.md` for the `## Comms discipline` section near the top.

### Check 1.2 — Bus message volume during the same window

```bash
# Count messages each running agent sent to boss in the last 4h
SINCE_EPOCH=$(date -u -j -v-4H +%s)
for agent in boss analyst devops-c token-auditor; do
  count=$(find ~/.cortextos/default/processed/boss -type f 2>/dev/null | while read f; do
    m=$(stat -f "%m" "$f" 2>/dev/null)
    if [ "$m" -ge "$SINCE_EPOCH" ]; then
      jq -r --arg a "$agent" 'select(.from == $a) | .id' "$f" 2>/dev/null
    fi
  done | wc -l | tr -d ' ')
  echo "$agent → boss messages (last 4h): $count"
done
```

**Expected:** drastically reduced compared to baseline. Pre-rollout baseline (2026-05-13 24h): boss inbound from `devops-c` = 14, from `token-auditor` = 12. Post-rollout target for the **next 4h window only** is roughly 1/6 of that: devops-c ≤ 3, token-auditor ≤ 3. (Full 24h target is in Stage 4.)

**If volume is still high:** discipline isn't biting. Read the actual message text — agents may be sending state-delta messages legitimately, or they may be repeating the old "still on standby" pattern. The latter requires re-tightening the rule wording.

---

## Stage 2 — First scheduled session-refresh (~5–6h after rollout)

Boss's `session-refresh` cron fires every 6h. The first one post-rollout is at approximately **22:43 UTC** on 2026-05-13. This is the **only deployed exercise** of the Telegram wrapper's restart-reason gate — boss restarts itself with reason `session-refresh`, then runs Session Start, which now calls the wrapper.

### Check 2.1 — Wrapper suppressed the `online — ready` ping

```bash
# Outbound Telegram from boss in the 10 min after the session-refresh restart
jq -r --arg s "2026-05-13T22:40:00Z" --arg u "2026-05-13T22:55:00Z" \
  'select(.timestamp >= $s and .timestamp <= $u) | "\(.timestamp) | \(.text // "")"' \
  ~/.cortextos/default/logs/boss/outbound-messages.jsonl

# Corresponding suppression event
cortextos bus read-agent-events boss --since 1h --event telegram_dedup_skipped
```

**Expected:**
- `outbound-messages.jsonl` shows ZERO `online — ready` lines in the 22:40–22:55 window.
- `read-agent-events ... --event telegram_dedup_skipped` shows ONE entry with `meta.reason: "restart_routine"`.

**If the Telegram DID fire:** wrapper is broken or wasn't called. Check:

1. The Session Start block in `orgs/sb-personal/agents/boss/CLAUDE.md` line ~57 — should reference `scripts/comms/send-telegram-guarded.sh`, NOT bare `cortextos bus send-telegram`.
2. The wrapper itself — manually invoke with a test-safe chat_id:
   ```bash
   CTX_AGENT_NAME=boss bash scripts/comms/send-telegram-guarded.sh 99999 "online — ready test"
   # Expected output if gate trips: nothing on stdout, but a new telegram_dedup_skipped event
   # Expected output if gate misses: the actual bus send-telegram error for chat 99999
   ```
3. The restarts log — most recent line should mention `session-refresh`:
   ```bash
   tail -1 ~/.cortextos/default/logs/boss/restarts.log
   # Should look like: [<ts>] HARD-RESTART: proactive session refresh — 6h cycle
   ```

If the restart reason text in `restarts.log` doesn't match the wrapper's regex (`session[ -]refresh|user[ -](restart|stop|disable)|proactive|cron|routine[ -]restart`), the gate won't trip. Adjust the regex in `scripts/comms/send-telegram-guarded.sh:62-63` accordingly.

---

## Stage 3 — Second heartbeat tick (~8h after rollout, ≈ 2026-05-14 01:54 UTC for boss)

By this point each running agent should have at least one cycle event, and boss should have responded silently (via `inbox_archived`) rather than sending ACK-the-ACK messages.

### Check 3.1 — Boss silent receipt is working

```bash
# Any inbox_archived events from boss?
cortextos bus read-agent-events boss --since 8h --event inbox_archived

# Counter: any boss outbound replies that look like ACKs?
jq -r --arg s "$(date -u -v-8H +%Y-%m-%dT%H:%M:%SZ)" \
  'select(.timestamp >= $s and (.text // "" | test("^ACK\\.|^Copy\\.|^Good\\. Proceed"; "i"))) | "\(.timestamp) | \(.text // "" | .[0:80])"' \
  ~/.cortextos/default/logs/boss/outbound-messages.jsonl
```

**Expected:** 1+ `inbox_archived` events per cycle from each agent, ZERO short-ACK replies from boss.

**If boss is still ACKing routine status:** the `## Comms discipline` section in `orgs/sb-personal/agents/boss/CLAUDE.md` has the boss-specific rule "silent receipt for routine status — log `action/inbox_archived`". If boss is reading this but not following it, the rule may need a more prominent or imperative form. Look at the agent's recent heartbeat memory entries to see whether it acknowledged the rule.

### Check 3.2 — devops-c standby chatter eliminated

```bash
# Devops-c bus messages to boss in last 8h
find ~/.cortextos/default/processed/boss -type f -newer /tmp/.notexist 2>/dev/null | while read f; do
  jq -r 'select(.from == "devops-c") | "\(.timestamp) | \(.text // "" | .[0:100])"' "$f" 2>/dev/null
done | tail -10
```

**Expected:** 0–1 messages. Baseline was ~5 per 8h. Replaced by `standby_cycle_complete` events queryable via `cortextos bus read-cycle-summary devops-c`.

**If devops-c is still chatting:** its `orgs/sb-personal/agents/devops-c/AGENTS.md` line 38 has the discipline reference. Look at the devops-c stdout log for what it's actually doing on heartbeat. Codex-runtime agents have a different cron-fire path than claude agents; the discipline may need a devops-c-specific adaptation. **This is the agent we deferred** during the rollout-gap fix — known higher-risk surface.

---

## Stage 4 — Full 24h volume regression (run ~2026-05-14 17:30 UTC)

The decisive test. Compare a fresh 24h window's volume against the baseline from the original audit.

### Check 4.1 — Run the same audit script

```bash
SINCE_EPOCH=$(date -u -j -v-24H +%s)
for agent in boss analyst engineer devops fullstack devops-c token-auditor; do
  recent=$(find ~/.cortextos/default/processed/$agent -type f 2>/dev/null | while read f; do
    m=$(stat -f "%m" "$f" 2>/dev/null)
    [ "$m" -ge "$SINCE_EPOCH" ] && echo "$f"
  done | wc -l | tr -d ' ')
  echo "$agent | processed_24h=$recent"
done
```

### Check 4.2 — Compare to baseline + targets

| Agent | Baseline (24h pre-rollout) | Target (24h post-rollout) | Action if missed |
|---|---|---|---|
| boss inbound | 39 | ≤ 12 | Investigate which agent is over-chatting; likely root cause is a missing CLAUDE.md edit |
| from devops-c | 14 | ≤ 2 | Re-check devops-c AGENTS.md cycle-event instruction; this was the deferred-fix agent |
| from token-auditor | 12 | ≤ 4 | Check token-auditor heartbeat output; should emit `audit_run_complete` event instead of sending |
| Saurav Telegram restart-noise | 3 (in 24h) | 0 | Wrapper gate broken — debug per Stage 2.1 |

### Check 4.3 — Cycle events should rise as messages fall

```bash
# Count cycle events fleet-wide in same window
cortextos bus read-cycle-summary --since 24h --format json | jq 'length'
```

**Expected:** at least 4 × (24h / heartbeat-interval) cycle events = roughly 28+ events for the 4 running agents (boss 6× + analyst 3× + devops-c 6× + token-auditor 6× ≈ 21 at minimum; more once analyst is back to 4h post-HALT).

---

## Stage 5 — Sign-off (when all checks pass)

Once Stage 4 targets are hit AND no rollback was needed:

1. Update `docs_sb/comms-discipline.md` "Before / after" section with the actual measured 24h numbers.
2. Move this file to `docs_sb/archive/comms-discipline-verification-handoff-2026-05-13.md` so future operators can see it ran cleanly without it being in the active doc set.
3. Delete the `[OPERATOR-ACTING] Comms-discipline rollout gap closed` entry from `orgs/sb-personal/agents/boss/memory/2026-05-13.md` (or leave — it's a daily memory, will rot naturally).
4. Patch devops-c per the deferred fix: route its boot/restart Telegrams through the wrapper. New mini-PR or commit on top of main; see `boss/memory/2026-05-13.md` for the deferred fix description.

---

## Rollback procedure (if Stage 4 shows targets missed badly)

If the discipline is materially worse than expected (e.g. boss inbox volume INCREASED, or new errors surfaced):

```bash
# Revert the 3 merged PRs
git checkout main
git revert -m 1 0291dd0  # PR #35 — ctx-root fix
git revert -m 1 8c62012  # PR #34 — gitignore
git revert -m 1 904e8f3  # PR #32 — comms-discipline
git push origin main
# Restart all running agents to drop the new rule
for a in boss analyst devops-c token-auditor; do cortextos restart $a; done
```

The fork-only operator overlays (per-agent CLAUDE.md edits, config.json cron-prompt appends, `.claude/rules/comms-discipline.md`) need to be reverted manually — they're gitignored, so `git revert` won't touch them. Easiest is to `git checkout 3cc9c1a -- orgs/sb-personal/agents/*/CLAUDE.md orgs/sb-personal/agents/*/config.json` (the commit before the rollout).

---

## Key file pointers (for the next operator)

| Concern | Where to look |
|---|---|
| The rule itself | `community/skills/comms-discipline/RULE.md` |
| Event-action vocabulary | `community/skills/comms-discipline/event-actions.md` |
| Telegram wrapper | `scripts/comms/send-telegram-guarded.sh` |
| Pull-model CLI | `src/cli/agent-events.ts` — `read-agent-events`, `read-cycle-summary` |
| CTX_ROOT resolver | `src/utils/env.ts` `resolveCtxRoot()` |
| Per-agent overlay | `orgs/sb-personal/agents/<agent>/CLAUDE.md` (or `AGENTS.md` for devops-c) — search for `## Comms discipline` |
| Rollout-gap fix notes | `orgs/sb-personal/agents/boss/memory/2026-05-13.md` — `[OPERATOR-ACTING]` entries |
| Original audit data | `2026-05-13` review of `~/.cortextos/default/processed/<agent>/` — 39 boss-inbound / 25 zero-info loops; see `docs_sb/comms-discipline.md` "Before / after example" section |

## Open question for Saurav

- **devops-c migration to wrapper** — not done yet. Has custom multi-message boot Telegrams ("Booting up... one moment", "Restarting now — will be back in a moment.", "Context window full. Hard-restarting...") that don't match the simple `online — ready` shape. Three options for migration:
  1. Route every `cortextos bus send-telegram` in AGENTS.md through the wrapper. Highest coverage, most invasive.
  2. Route only the boot-time message (line 46 + line 65). Closes the `online — ready` analogue; leaves restart-related messages unchanged.
  3. Defer permanently — accept that codex agents have a different comms pattern.

  Pick after the codex-runtime A/B trial concludes (~2026-05-18 per the 7-day trial that started 2026-05-11).
