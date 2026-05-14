# 01 — Fleet resilience follow-ups

**Owner:** Saurav
**Origin:** Issue #07 (`docs_sb/issues/07-posix-spawnp-after-pnpm-reinstall.md`) — May 14 9h silent outage post-mortem
**Status:** Tier-1 trio + #3 + #5 **SHIPPED 2026-05-15** (PRs #42–#48). Tier-2 (#6–#8) + Tier-3 (#9–#11) still planned.
**Created:** 2026-05-15
**Last validated against code:** 2026-05-15 (file:line refs throughout the spec sections were verified against `main`; re-check before picking up a phase that hasn't been touched in a few weeks)

## Progress (2026-05-15)

| Item | Status | PR | Notes |
|---|---|---|---|
| docs: expanded plan v2 | ✅ shipped | [#42](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/42) | This document (Goal-state + dep graph + per-item specs). |
| #3 dashboard EADDRINUSE | ✅ shipped | [#43](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/43) | `src/utils/port-probe.ts` + pre-bind probe with `3010→3020→3030` fallback, `--no-port-probe` escape hatch. |
| #5 status `--json` foundation | ✅ shipped | [#44](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/44) | 9 deep-health fields added to `AgentStatus`; cheap `getStatus()` / deep `getStatusDeep()` split on `AgentProcess`. |
| #1 cron-dispatch storm + `operator-alert.ts` extract | ✅ shipped | [#45](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/45) | Cross-cutting `operator-alert.ts` lifted; ≥3 distinct crons / 30 min → CRITICAL; `cron-scheduler.ts` `onDispatchFailed` hook. |
| #2 heartbeat-staleness watchdog | ✅ shipped | [#46](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/46) | Per-agent `HeartbeatStalenessWatcher`; cold-boot safe (arms after first read), 2-consecutive-miss tolerance. Required promoting `AgentProcess.onStatusChanged` to multi-subscriber. |
| #4 doctor cron + 31-check extraction | ✅ shipped | [#47](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/47) | New `src/utils/health-checks.ts` (flat module); new `DoctorCron`; new `src/utils/daemon-config.ts` lazy loader for `~/.cortextos/<instance>/config/daemon.json`. `cortextos doctor` output unchanged. |
| deep-eval cross-phase fixes | ✅ shipped | [#48](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/48) | Wired the previously-dead `cron_dispatch_storm_threshold` daemon-config knob; honest stderr-vs-JSONL transport section in the comms-discipline glossary. |
| #6 self-healing launchd install | ⏸ planned | — | Tier 2. Next-up if operator capacity allows. |
| #7 crash-budget reset on planned restart | ✅ shipped | [#49](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/49) | Tier 2. `AgentProcess.markPlannedRestart()` flag set on the freshly-constructed process inside `startAgent`. CRASH-RESET audit annotation + queryable `crash_budget_reset` event. |
| #8 `node_modules` mtime warning | ⏸ planned | — | Tier 2. `daemonStartedAt` already exposed in PR #47 as forward-compat. |
| #9 agent-supervisor IPC heartbeat | ⏸ deferred | — | Tier 3. Only if #2 proves insufficient in practice; spec is still TBD. |
| #10 macOS quarantine xattr | ⏸ deferred | — | Tier 3. Low real-world incidence. |
| #11 fleet-health dashboard widget | ⏸ deferred | — | Tier 3. PR #44's `--json` payload is the data source when this lands. |

### Test footprint

`npm test` count: **2054 → 2162** (+108 across 8 new test files / 1 modified). Zero regressions across the trajectory.

### Goal-state delivery

The four alert tiers from the original Goal-state section all have wired code paths on `main`:

1. ✅ Sustained dispatch failure → `cron_dispatch_storm_detected` via `src/daemon/cron-dispatch-tracker.ts` (PR #45, hooked from `agent-manager.ts:startAgentCronScheduler`).
2. ✅ Wedged-but-alive agent → `heartbeat_stale_detected` via `src/daemon/heartbeat-staleness-watcher.ts` (PR #46, one watcher per agent owned by `AgentManager`).
3. ✅ New `warn`/`fail` from `doctor` → `doctor_delta_detected` via `src/daemon/doctor-cron.ts` (PR #47, wired in `src/daemon/index.ts` after agent discovery).
4. ✅ Dashboard EADDRINUSE thrash → `port_collision_recovered` via `src/utils/port-probe.ts` (PR #43, called from `src/cli/dashboard.ts` before bind).

**What's still missing for "verified done":** the live-fire staging smoke described in the Verification section below has not yet been run. The code paths exist on `main`, the unit tests pin them, but no operator has confirmed an end-to-end alert lands inside the SLA on a real fleet.

## Next steps

In priority order. Pick from the top.

### Step 1 — Live-fire staging smoke (operator action, ~1 hour)

Source: this doc's "Verification of done" section (below). Run all three on a staging instance with the operator Telegram chat wired (`CTX_OPERATOR_CHAT_ID` + `CTX_OPERATOR_BOT_TOKEN` in env, or one agent's `.env` with `BOT_TOKEN` + `CHAT_ID`).

1. Force a cron dispatch storm — temporarily make `injectAgent()` return false for 3+ different crons within 30 min. Confirm a single CRITICAL Telegram inside SLA.
2. Freeze an agent's heartbeat — `truncate -s 0 ~/.cortextos/default/state/<agent>/heartbeat.json` or pause its heartbeat cron. Confirm alert at threshold + 1 min and re-alert at +31 min.
3. Break a doctor check — `chmod -x` the spawn-helper. Wait up to 30 min. Confirm `doctor_delta_detected` alert with `new_failures: ["node-pty spawn-helper"]`.

If any of the three doesn't fire, that's a wiring bug to root-cause before moving to Tier 2.

### Step 2 — Tier 2, in this order

- **#6 self-healing scripts installed by default** — closes "great scripts that nobody uses" gap. Touches `cortextos install` / `cortextos uninstall`; macOS-only (launchd). Spec section below is current.
- **#7 crash-budget reset on planned restart** — small (~50 LOC), high-utility for operators routinely doing `cortextos restart <agent>`. Spec section below is current.
- **#8 `node_modules` mtime warning** — one extra stat in `AgentProcess.start()`. PR #47 already exposed `Daemon.daemonStartedAt`; consume it from `agent-process.ts`. Spec section below is current.

### Step 3 — Tier 3, only if needed

- **#9 agent-supervisor IPC heartbeat** — explicit do-not-build unless #2's file-poll surface proves insufficient in practice. After 4+ weeks of #2 in production, revisit.
- **#10 macOS quarantine xattr** — add when there's a real-world incidence. PR #47's `src/utils/health-checks.ts` already has the natural insertion point (`node-pty spawn-helper` section).
- **#11 fleet-health dashboard widget** — Telegram covers the urgent case. Build when control-panel ergonomics rise above other dashboard work. PR #44's `cortextos status --json` is the data source — no IPC plumbing to invent.

### Step 4 — Follow-up cleanup (small, can pick anytime)

- **Daemon pseudo-agent identity for `logEvent`** — PR #48's glossary update acknowledges the watchers (`heartbeat-watcher`, `doctor-cron`, etc.) emit stderr structured lines, not JSONL. When operators want `cortextos bus read-agent-events --event heartbeat_stale_detected` to actually return rows, plumb a synthetic "daemon" agent identity into `logEvent` and migrate the three watchers' emissions. Not blocking — grep on the daemon log file covers the immediate query need.
- **`ecosystem.config.js` dashboard supervision** — PR #43 fixed the EADDRINUSE thrash *symptom* on the dashboard. The root cause (327 PM2 restarts) was traced to a launchd plist / external supervisor outside this repo. Track that down and add `max_restarts: 3` so the supervisor fails fast instead of hammering forever.

## Goal state

After this plan ships, a May-14-shape incident produces an operator-visible alert within **5 minutes** instead of 9 hours. Specifically:

1. **Sustained dispatch failure** (cron can't deliver to an agent for >30 min across multiple crons) → CRITICAL Telegram to operator chat.
2. **Wedged-but-alive agent** (PTY healthy, Claude stuck inside a tool call, heartbeat ts older than threshold) → CRITICAL Telegram.
3. **New `warn`/`fail` from `cortextos doctor`** that didn't exist on the last run → operator alert with diff.
4. **Live crash loops on auxiliary processes** (dashboard EADDRINUSE thrash) → fail-fast with a clear message instead of silent thrash.

Tiers 2 and 3 close residual gaps (crash-budget reset, mtime check, dashboard widget) once the alerting trio is in place.

## Non-goals

- **Replacing the existing self-healing scripts.** They keep working; we just install them by default (#6) and add daemon-native equivalents that don't depend on launchd being loaded (#2, #4).
- **A general-purpose monitoring framework.** Each watcher is small and purpose-built. We don't need Prometheus.
- **Cross-machine fleet supervision.** Scope is the single-host daemon. Multi-host is out.
- **Fixing the underlying `posix_spawnp` failure class.** PRs #37 and #40 already did. This plan is about *catching* the next category of latent gap, not closing this one again.

## Dependency graph

```
                   ┌────────────────┐
                   │ #5 status JSON │ ◄── foundation
                   └───┬────────┬───┘
                       │        │
              ┌────────┘        └──────────┐
              ▼                            ▼
        ┌───────────┐               ┌────────────┐
        │ #2 hb-stale │             │ #11 widget  │
        └───────────┘               └────────────┘

   ┌──────────────────┐
   │ doctor extraction │ ◄── sub-task inside #4
   └────────┬──────────┘
            ▼
        ┌──────────────┐
        │ #4 doctor cron│
        └──────────────┘

   #1, #3, #6, #7, #8, #10 → independent (no deps)
   #9 → supersedes #2 long-term; not parallel work
```

**Day-1 monitoring trio:** #1 + #2 + #4. These three alone close the May-14 detection gap. If you can only ship three things off this plan, ship these. #5 first if you intend to do #2 or #4 in production-grade form.

**Crash-loop killer:** #3. Live ongoing fire today — pick this any time, 30-min job.

## Cross-cutting conventions

These apply to every phase that touches them.

### Operator-alert helper (new shared module)

Today `spawn-failure-tracker.ts:186-213` (`sendStormAlertBestEffort()`) implements alert delivery inline: env-var creds, 3s timeout, best-effort fire-and-forget. Items #1, #2, and #4 all need the same shape. Extract before building the third caller, not before the first.

**File:** `src/daemon/operator-alert.ts` (new)

```ts
export interface OperatorAlert {
  kind: 'spawn_storm' | 'cron_dispatch_storm' | 'heartbeat_stale' | 'doctor_delta' | 'port_collision';
  severity: 'WARN' | 'CRITICAL';
  agent?: string;           // optional — alerts can be fleet-wide
  text: string;             // user-facing body, ≤500 chars
  cooldownKey: string;      // dedupe key for the alert's cooldown bucket
  cooldownMs?: number;      // default 30 min
}

export async function emitOperatorAlert(a: OperatorAlert): Promise<{ sent: boolean; reason?: string }>;
```

Cooldown state is per `cooldownKey`, persisted to `state/.operator-alert-state.json` so a daemon restart doesn't re-flood. Internally: reads Telegram creds via the same env-or-`.env` lookup `spawn-failure-tracker.ts` already does (don't duplicate that — move it into a shared helper if needed).

**Migration:** When extracting, `spawn-failure-tracker.ts:186-213` becomes a thin call into `emitOperatorAlert({ kind: 'spawn_storm', ... })`. Keep the existing behavior identical; tests should pass unchanged.

### Telemetry / event-action vocabulary

Per `.claude/rules/comms-discipline.md`: every state change is logged as a structured JSONL event via `cortextos bus log-event`. The watchers in this plan must emit:

| Phase | Action | Required meta |
|---|---|---|
| #1 | `cron_dispatch_storm_detected` | `agent`, `crons` (array), `window_minutes` |
| #2 | `heartbeat_stale_detected` | `agent`, `age_seconds`, `threshold_seconds` |
| #2 | `heartbeat_recovered` | `agent`, `was_stale_for_seconds` |
| #3 | `port_collision_recovered` | `port`, `fallback_port`, `holder_pid` |
| #4 | `doctor_delta_detected` | `new_failures` (array), `new_warnings` (array), `resolved` (array) |
| #7 | `crash_budget_reset` | `agent`, `from_count`, `reason` |
| #8 | `node_modules_mtime_warning` | `agent`, `node_modules_mtime`, `session_start` |

Boss / analyst / Saurav can then `read-agent-events ... --event <action>` instead of grepping logs. Add to `community/skills/comms-discipline/event-actions.md` glossary when each phase ships.

### Config schema additions

These extend `AgentConfig` (`src/types/index.ts:173-232`):

```ts
heartbeat_stale_threshold_minutes?: number;  // #2 — default 10
heartbeat_stale_realert_minutes?: number;    // #2 — default 30
```

Daemon-global config (lives in `~/.cortextos/<instance>/config/daemon.json` — verify exact path against `src/cli/install.ts` when picking up #4):

```ts
doctor_cron_interval_minutes?: number;       // #4 — default 30
cron_dispatch_storm_threshold?: number;      // #1 — default 3 distinct crons / 30 min
```

All new fields are optional with sensible defaults; never required, no migration step.

### IPC contract additions

Today's `{ type: 'status' }` returns `AgentStatus[]` from `agent-process.ts:319-331`:

```ts
{ name, status, pid, uptime, sessionStart, crashCount, model }
```

Phase #5 extends this — see the spec for the additive-only field list. New IPC message types only when an extension to existing types won't work.

### Test patterns

Tests live in `tests/`. Before writing tests for a new phase, run `git ls-files tests/ | head` and read one nearby test to confirm the framework (likely `node:test` or `vitest`) and assertion style — don't introduce a new test runner.

Each phase below names tests but doesn't prescribe the framework — match what's there.

---

## Tier 1 — Same-week, high-impact, low-scope

### #1 — Cron-dispatch-failure escalation

**Status:** ✅ Shipped 2026-05-15 in [PR #45](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/45). Code at `src/daemon/cron-dispatch-tracker.ts`, wired from `src/daemon/agent-manager.ts:startAgentCronScheduler` via `CronScheduler.onDispatchFailed`. Threshold override wired through `daemon.json:cron_dispatch_storm_threshold` in [PR #48](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/48).

**Problem.** Post-mortem section "Contributing factors #2": when `injectAgent()` returns false, `cron-scheduler.ts:523-540` logs WARN and advances the slot. Right for one-off misses; silent over hours when the same agent stays down. May 14 had 8+ different crons fire-and-fail every 30 min for 9h with zero escalation.

**Spec.** Mirror `spawn-failure-tracker.ts` semantics but scoped to cron dispatch.

**Files:**
- Create `src/daemon/cron-dispatch-tracker.ts` — modelled on `spawn-failure-tracker.ts:267-294`.
- Modify `src/daemon/cron-scheduler.ts:523-540` — call `recordAndMaybeEscalate(agent, cronName)` at the dispatch-failed branch.
- Modify `src/daemon/spawn-failure-tracker.ts:186-213` — refactor through new `operator-alert.ts` (cross-cutting).

**API:**

```ts
// src/daemon/cron-dispatch-tracker.ts
export async function recordAndMaybeEscalate(
  ctxRoot: string,
  frameworkRoot: string,
  agent: string,
  cronName: string,
): Promise<{ escalated: boolean; history: CronDispatchHistory }>;
```

**Persistence:** `state/.cron-dispatch-failure-history.json`. Same shape as spawn-failure-history (`events[]`, `lastAlertAt`).

**Detection rule:**
- ≥3 *distinct* `cronName`s fail dispatch in 30 min for the same `agent` → CRITICAL operator alert.
- Repeated failures of the *same* cron+agent don't count toward distinctness (matches `spawn-failure-tracker.ts` logic — single hook firing in a loop isn't a storm).
- 60-min cooldown per agent.

**Alert text:**
```
⚠️ Cron dispatch failure storm for agent "boss"
3 distinct cron(s) failed to inject in 30 min: heartbeat, morning-review, check-approvals
Boss's last successful spawn: 2026-05-14T04:43Z (9h ago)
Likely fix: `cortextos restart boss` or `pm2 restart cortextos-daemon`
```

**Telemetry:** `cron_dispatch_storm_detected` (see vocab table).

**Acceptance tests:**
- `cron-dispatch-tracker.test.ts > three distinct crons emit one CRITICAL then gates on cooldown`
- `cron-dispatch-tracker.test.ts > same cron repeating does not count toward distinctness`
- `cron-scheduler.integration.test.ts > onFire-failed hook records to tracker`

**Rollback:** Pure additive; remove the single call site in `cron-scheduler.ts` to disable. No data migration.

**Why this is #1.** The exact gap that hid May 14's outage. Highest-signal change in the plan.

---

### #2 — Heartbeat-staleness watchdog

**Status:** ✅ Shipped 2026-05-15 in [PR #46](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/46). Code at `src/daemon/heartbeat-staleness-watcher.ts`, one watcher per agent owned by `AgentManager`. Implementation required promoting `AgentProcess.onStatusChanged` to multi-subscriber so the new halt-stop handler doesn't clobber the existing Telegram crash/halt handler.

**Problem.** Agents write `state/<agent>/heartbeat.json` with `last_heartbeat: ISO8601` and `current_task` (`src/types/index.ts:118-129`). Nothing watches it from the daemon side. PTY-alive-but-Claude-wedged-inside-a-tool-call shows no signal in restarts.log, status stays `running`, no alert.

**Spec.** Daemon polls each agent's heartbeat file every 60s; flags stale when `now - ts > threshold`.

**Files:**
- Create `src/daemon/heartbeat-staleness-watcher.ts`.
- Modify `src/daemon/agent-manager.ts:56-82` (`discoverAndStart()`) — instantiate one watcher per agent at startup; hook `AgentProcess.onStatusChanged()` at line 336 to stop/start the watcher when an agent goes halted/restarted.
- Modify `src/types/index.ts:173-232` — add `heartbeat_stale_threshold_minutes` and `heartbeat_stale_realert_minutes` (see cross-cutting).

**Detection rule:**
- File missing OR `last_heartbeat` ts older than `heartbeat_stale_threshold_minutes` (default 10) → mark stale, emit CRITICAL.
- While stale: re-alert every `heartbeat_stale_realert_minutes` (default 30). Not one-shot — May-14 was a 9h event; one alert at minute 11 followed by silence is not enough.
- File ts updates → emit `heartbeat_recovered`, clear state.
- Robustness: tolerate transient file-read errors (mid-write race). Require two consecutive failed reads before flagging.

**Alert text:**
```
⚠️ Agent "boss" heartbeat stale: 14m (threshold 10m)
Last task: "heartbeat — fleet healthy, awaiting Saurav direction"
Last heartbeat: 2026-05-15T13:42:11Z
Agent status: running (PID 12345)
Suggested: `cortextos bus inject boss "ping?"` to nudge
```

**Telemetry:** `heartbeat_stale_detected`, `heartbeat_recovered`.

**Acceptance tests:**
- `heartbeat-staleness-watcher.test.ts > stale ts triggers CRITICAL at first detection`
- `heartbeat-staleness-watcher.test.ts > fresh ts does not trigger`
- `heartbeat-staleness-watcher.test.ts > re-alert cadence (FakeTimers): no alert at 10m, alert at 11m, re-alert at 41m`
- `heartbeat-staleness-watcher.test.ts > heartbeat update mid-stale clears watcher and logs recovered event`
- `heartbeat-staleness-watcher.test.ts > transient ENOENT does not flag (requires 2 consecutive misses)`

**Rollback:** Per-agent opt-out by setting `heartbeat_stale_threshold_minutes: 0` (treat as "disabled"); otherwise remove watcher construction in `agent-manager.ts`.

**Why this is #2.** Catches the hung-but-alive class that no other recovery surface sees. Daemon-native — ships with the daemon, doesn't depend on launchd plist installation (the gap that left this machine with zero self-healing scripts loaded on May 14).

---

### #3 — Dashboard EADDRINUSE auto-recovery

**Status:** ✅ Shipped 2026-05-15 in [PR #43](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/43). Code at `src/utils/port-probe.ts`, called from `src/cli/dashboard.ts` before `spawn(next, ...)`. `--no-port-probe` escape hatch. Note: the `ecosystem.config.js` `max_restarts: 3` change from the original spec was deferred — there's no dashboard PM2 app in this repo's `ecosystem.config.js`; the 327-restart thrash was coming from a launchd plist / external supervisor outside the repo. Tracked as "Step 4 follow-up cleanup".

**Problem.** `cortextos-dashboard` is at **327 restarts** in PM2 because it keeps hitting `EADDRINUSE :3000` against some other process. The dashboard is CLI-spawned by `src/cli/dashboard.ts:28-34` (default port 3010 per the validated code, though the live process may be running on 3000 — confirm before picking up). PM2 respawns into the same conflict forever. Unrelated to issue #07 but exemplifies "self-restart without diagnosing root cause = thrash".

**Spec.** Pre-bind probe in `dashboardCommand`. If port occupied: log loudly, try next port in a fixed list (3010 → 3020 → 3030), fail fast after N attempts.

**Files:**
- Modify `src/cli/dashboard.ts:28-34` — add `await probePort(port)` before `spawn(next, ...)`.
- Modify `ecosystem.config.js` (root) — currently only defines `cortextos-daemon` (line 17). If dashboard is being managed by PM2 from elsewhere, find that config and reduce `max_restarts: 3` so a true failure surfaces fast instead of thrashing 327 times.
- Optional helper: `src/utils/port-probe.ts` (new) — `lsof -tiTCP:<port> -sTCP:LISTEN` wrapped, returns holder PID or null. Mockable.

**API:**
```ts
export async function probePort(port: number): Promise<{ free: true } | { free: false; holderPid: number }>;
export async function findFreePort(preferred: number, fallbacks: number[]): Promise<number>;
```

**Telemetry:** `port_collision_recovered` (only when fallback succeeds).

**Acceptance tests:**
- Unit: `port-probe.test.ts > free port returns {free: true}` and `occupied port returns holderPid`
- Unit: `dashboard.test.ts > occupied preferred port falls through to first available fallback`
- Manual repro: occupy 3000 with `python3 -m http.server 3000`; run `cortextos dashboard --port 3000`; assert log line `"port 3000 in use by PID X, trying 3010"`.

**Rollback:** Skip probe via `--no-port-probe` flag (or just revert the diff — single call site).

**Why this is #3.** Live ongoing crash loop. 30-min fix. Independently shippable.

---

### #4 — Doctor as a periodic cron

**Status:** ✅ Shipped 2026-05-15 in [PR #47](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/47). 31 checks extracted to flat `src/utils/health-checks.ts` (single file with `// ── Section ──` banners — flat won the over-decompose tradeoff). New `src/daemon/doctor-cron.ts` runs them every 30 min and emits delta-only alerts. New `src/utils/daemon-config.ts` lazy loader reads `~/.cortextos/<instance>/config/daemon.json`. `cortextos doctor` CLI output unchanged (verified by reading the rewritten thin renderer).

**Problem.** `src/cli/doctor.ts` runs ~30 health checks (`Check { name, status, message, fix? }` at line 9-14; inline `Check[]` at line 22+). All on-demand. The trigger for "doctor saw something" is "Saurav noticed the fleet is dead and ran the command", which inverts the desired direction.

**Spec.** Daemon runs the same checks every `doctor_cron_interval_minutes` (default 30), in-process, no shell-out. Compares current `Check[]` to last run. Alerts on delta only.

**Sub-task — doctor extraction:** Today's checks are hardcoded inside the action callback (lines 24-150+). Before #4 can ship, extract them into a reusable shape:

- Create `src/utils/health-checks.ts` exporting `runAllChecks(): Promise<Check[]>` plus individual `checkNodePty()`, `checkSpawnHelperPerms()`, etc.
- Refactor `src/cli/doctor.ts` to call `runAllChecks()` and render the existing table from the result. No user-facing behavior change for `cortextos doctor`.

**Files:**
- Create `src/utils/health-checks.ts`.
- Modify `src/cli/doctor.ts` — gut the inline check logic, call into `health-checks.ts`. Output table unchanged.
- Create `src/daemon/doctor-cron.ts` — 30-min schedule, diff against `state/.doctor-last-run.json`, emit on delta.
- Modify daemon startup (find via `src/daemon/agent-manager.ts:56-82` neighborhood) — wire the cron.

**Detection rule:**
- First run after daemon start: compute baseline; emit one CRITICAL summary of any current `warn`/`fail` (so a daemon restart against a broken host surfaces immediately).
- Subsequent runs: only emit if check `name` transitioned `pass→warn`, `pass→fail`, or `warn→fail`. Also emit `resolved` events when `warn|fail→pass`.
- Suppress unchanged runs (the common case).

**Alert text:**
```
⚠️ Doctor: 2 new issues
  • spawn-helper-perms: FAIL — exec bit missing on .../node-pty/.../spawn-helper
  • node-modules-mtime: WARN — node_modules newer than daemon session (reinstall detected?)
Run `cortextos doctor` for full output.
```

**Telemetry:** `doctor_delta_detected`.

**Acceptance tests:**
- `doctor-cron.test.ts > first run emits baseline summary of existing warn/fail`
- `doctor-cron.test.ts > second run with same state is silent`
- `doctor-cron.test.ts > new fail emits delta alert only for the new fail`
- `doctor-cron.test.ts > resolved check emits "now passing" alert`
- `health-checks.test.ts > runAllChecks returns same Check[] as inline-doctor previously did` (snapshot test, captures the refactor's correctness)

**Rollback:** Set `doctor_cron_interval_minutes: 0` to disable the cron; CLI doctor unchanged. The extraction is permanent (and benign).

**Why this is #4.** Highest leverage per line of code in the plan — turns 30 existing checks into a passive monitor. But needs the extraction sub-task first, which is why it's #4 and not #1.

---

## Tier 2 — Medium impact (within 2-3 weeks)

### #5 — `cortextos status --json` deep-health view

**Status:** ✅ Shipped 2026-05-15 in [PR #44](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/44). All 9 fields land on `AgentStatus` in `src/types/index.ts:849-880`. Population logic lives in pure helpers at `src/utils/agent-status.ts`; `AgentProcess.getStatus()` stays cheap (in-memory only) and `AgentProcess.getStatusDeep()` does the disk reads — used by `AgentManager.getAllStatuses` at IPC-status time, not in the per-mutation notifier path.

**Problem.** Today `cortextos status` is table-only (`src/cli/status.ts:82-107`). Raw IPC `{type:'status'}` returns `AgentStatus` with `{ name, status, pid, uptime, sessionStart, crashCount, model }` (`agent-process.ts:319-331`). Not enough to build #2, #4, or #11 against without each rolling its own state reader.

**Spec.** Additive only — extend the IPC `AgentStatus` payload and add a `--json` flag to the CLI.

**Extended payload (additive):**
```ts
interface AgentStatus {
  // existing
  name: string; status: AgentStatusState; pid?: number; uptime?: number;
  sessionStart?: string; crashCount: number; model?: string;
  // new
  lastHeartbeatAgeSeconds?: number;       // from state/<agent>/heartbeat.json
  lastHeartbeatTask?: string;             // current_task field
  lastInboxMessageAgeSeconds?: number;    // from inbox tail
  crashCountToday: number;                // parsed from logs/<agent>/.crash_count_today
  maxCrashesPerDay: number;               // from AgentConfig
  crashesRemaining: number;               // derived
  lastRestartReason?: string;             // tail of logs/<agent>/restarts.log
  lastRestartKind?: 'CRASH' | 'HALTED' | 'SPAWN-FAIL' | 'SPAWN-FAIL-HALTED' | 'SELF-RESTART' | 'HARD-RESTART';
  lastSpawnFailureAgeSeconds?: number | null;  // null if none in state/.spawn-failure-history.json
}
```

**Files:**
- Modify `src/types/index.ts` — extend `AgentStatus` (line 849-858).
- Modify `src/daemon/agent-process.ts:319-331` — populate new fields. Read once at IPC time, not on every status mutation; keep `getStatus()` cheap.
- Modify `src/daemon/agent-manager.ts` — same.
- Modify `src/cli/status.ts:82-107` — add `--json` flag; existing table format unchanged.

**Acceptance tests:**
- `status-json.test.ts > --json emits AgentStatus[] with all extended fields`
- `status-json.test.ts > existing text-mode output unchanged byte-for-byte`
- `agent-process.test.ts > getStatus() includes lastRestartKind parsed from restarts.log tail`
- `agent-process.test.ts > getStatus() handles missing files gracefully (returns undefined, not throws)`

**Why this matters / sequencing.** Foundation for #2 (heartbeat watcher), #4 (doctor cron), #11 (dashboard widget). Build first if doing more than one of those. Cheap on its own (~half-day).

---

### #6 — Self-healing scripts installed by default

**Status:** ⏸ Planned. Next-up in Tier 2. Foundation pieces from PR #47 (`src/utils/daemon-config.ts`) are available for re-use if any install-time toggles want a per-instance home.

**Problem.** `scripts/self-healing/{watchdog,agent-recover,usage-monitor,compact-boundary-watcher}.sh` plus `.plist.template` files are in the repo but require a manual `launchctl load` step that this machine missed entirely (`launchctl list | grep cortextos` was empty on May 14).

**Spec.** Fold installation into `cortextos install` (`src/cli/install.ts:82-284+`).

**Files:**
- Create `src/cli/install-self-healing.ts` (extract for testability).
- Modify `src/cli/install.ts` — call into the new module; print a summary table at the end.
- Modify `src/cli/uninstall.ts` — corresponding `launchctl unload` step.

**Behavior:**
- Copy `scripts/self-healing/*.sh` to `~/.cortextos/<instance>/scripts/`.
- Render each `*.plist.template` substituting `$USER`, `$HOME`, `$INSTANCE` (and any other tokens the templates use — grep them when picking up).
- `launchctl load -w <plist>` each; capture failures non-fatally.
- Print summary: `4 self-healing daemons installed (watchdog, agent-recover, usage-monitor, compact-boundary-watcher)`.
- Add `--skip-self-healing` flag.
- Idempotent: re-running `install` detects loaded plists via `launchctl list | grep cortextos` and skips re-load.

**Platform scope.** macOS only (launchd). Linux gets a stub message ("self-healing daemons not yet supported on Linux — manual systemd unit setup required") so the flag is present but a no-op.

**Acceptance tests:**
- `install-self-healing.test.ts > fresh install renders all 4 plists with substituted vars`
- `install-self-healing.test.ts > re-run is idempotent (does not double-load)`
- `install-self-healing.test.ts > --skip-self-healing skips entirely`
- Manual: `cortextos uninstall` then `launchctl list | grep cortextos` returns empty.

**Rollback:** `--skip-self-healing` on install; `cortextos uninstall` unloads.

**Why this matters.** Closes the "great scripts that nobody uses" gap. Most operators skip the README step.

---

### #7 — Crash-budget reset on planned-restart

**Status:** ✅ Shipped 2026-05-15 in [PR #49](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/49). The flag is a transient `private pendingPlannedRestart` on `AgentProcess`, set inside `AgentManager.startAgent` on the freshly-constructed process (NOT on the stale registry entry — the latter would be a silent no-op caught by code-evaluator). Consumer side: `readLastRestart` in `src/utils/agent-status.ts` skips trailing `CRASH-RESET:` lines so the user-visible `lastRestartKind` keeps surfacing the real restart kind underneath. `soft-restart-all` resets every agent's budget in one shot by design — every IPC `restart-agent` is treated as planned.

**Problem.** `.crash_count_today` (`logs/<agent>/.crash_count_today`, format `YYYY-MM-DD:count`, written at `agent-process.ts:829-843`) only resets at midnight. An agent that crashed 9 times in the morning is one crash from `halted` for the rest of the day. A successful planned restart should reset to 0 — that's earned trust.

**Spec.** Track the *kind* of the last restart; on a successful `start()` after a `SELF-RESTART`, `HARD-RESTART`, or user-initiated restart, reset the counter.

**Files:**
- Modify `src/daemon/agent-process.ts` — add `private lastRestartKind: 'CRASH' | 'SPAWN-FAIL' | 'PLANNED' | null` (default null).
- The IPC handler that processes `restart-agent` messages (locate via grep for `restart-agent` in `agent-manager.ts`) sets `lastRestartKind = 'PLANNED'` before calling `start()`.
- `handleExit()` and `handleSpawnFailure()` set `lastRestartKind = 'CRASH'` / `'SPAWN-FAIL'` before scheduling auto-restart.
- In `start()` success path (after PTY reports `running`, around `agent-process.ts:176`): if `lastRestartKind === 'PLANNED'` and current `crashCount > 0`, reset `crashCount = 0` and overwrite `.crash_count_today` with `<today>:0`. Append a `CRASH-RESET` line to `restarts.log` for audit.
- Always reset `lastRestartKind = null` after handling.

**Telemetry:** `crash_budget_reset` with `from_count`, `reason: 'planned_restart'`.

**Acceptance tests:**
- `agent-process.test.ts > 9 crashes then planned restart succeeds → next crash counts as #1, not #10`
- `agent-process.test.ts > pure crash → auto-restart cycle does NOT reset (existing budget behavior preserved)`
- `agent-process.test.ts > crash-reset writes audit line to restarts.log`

**Rollback:** Default `lastRestartKind = null` path is the pre-change behavior; adding the field is safe.

---

### #8 — node_modules-mtime warning on agent start

**Status:** ⏸ Planned. Tier 2. `Daemon.daemonStartedAt: Date` was added as a readonly field on the `Daemon` class in [PR #47](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/47) as forward-compat for this item — `src/daemon/agent-process.ts:start()` just needs to read it via dependency injection through `AgentManager`.

**Problem.** PRs #37 and #40 prevent the *failure mode* (spawn-helper invalidated by reinstall) but a future change could introduce a similar staleness. Cheap telemetry, one stat call.

**Spec.** On every `AgentProcess.start()` (`src/daemon/agent-process.ts:85-186`), after the successful spawn at line 176 (where `sessionStart` is set), `statSync(<repoRoot>/node_modules/package.json).mtime`. If newer than the **daemon's** start time (not the per-agent sessionStart — daemon process startup, which would need to be exposed; if not available, use the earliest sessionStart across all agents as a proxy), log a CRITICAL warning. Do not block, do not auto-restart.

**Files:**
- Modify `src/daemon/agent-process.ts:85-186` — add the stat at the top of `start()` (or right after successful spawn — either is fine, just be consistent). Wrap in try/catch (stat failure is silent — disk weirdness shouldn't break agent boot).
- Expose `daemonStartedAt` from wherever the daemon entry point lives (find via grep for `cortextos-daemon` boot; likely `src/daemon/index.ts` or similar).

**Telemetry:** `node_modules_mtime_warning`.

**Acceptance tests:**
- `agent-process.test.ts > newer mtime emits warning log`
- `agent-process.test.ts > older mtime emits no warning`
- `agent-process.test.ts > stat failure is silent (no throw)`

**Why this matters.** Catches the residual case where #40's auto-chmod missed something or where a reinstall happens but doesn't trip the perms helper. One line of value.

---

## Tier 3 — Long-term (1-2 months)

### #9 — Agent-supervisor IPC heartbeat

**Status:** ⏸ Deferred. Tier 3. Explicit do-not-build unless #2's file-poll surface (shipped in PR #46) proves insufficient. Revisit after 4+ weeks of #2 in production.

**Problem.** Today's heartbeat is agent → file → daemon polls. #2 catches file-staleness from the daemon side. A daemon-pushed IPC ping closes the symmetry: daemon expects a `pong` within N seconds.

**Spec.** TBD when scoped. Open question: does each agent's Node host run its own IPC server (heavier — new infrastructure) or piggyback the existing inject/status IPC (lighter — but Claude Code's PTY may not surface socket-level signals)? Decide before writing code.

**Acceptance.** TBD when scoped.

**Why this is here, not in Tier 1.** #2 covers the same ground with much less code. Only build this if #2 turns out insufficient in practice. Most likely we never need it.

---

### #10 — macOS quarantine xattr check

**Status:** ⏸ Deferred. Tier 3. Low real-world incidence. Natural insertion point exists at `src/utils/health-checks.ts` (the `node-pty spawn-helper` section from PR #47's extraction).

**Problem.** Gatekeeper can set `com.apple.quarantine` on downloaded binaries, which can block exec even with the right mode bits. Not seen in production but theoretically possible for the spawn-helper prebuild path.

**Spec.** Add xattr detection + removal alongside the existing chmod in `src/utils/node-pty-perms.ts:47-93`.

**Files:**
- Modify `src/utils/node-pty-perms.ts:47-93` — after the chmod (line 83), check for xattr and remove if present. macOS only (gate on `process.platform === 'darwin'`).
- Modify `src/cli/doctor.ts` (via #4's `src/utils/health-checks.ts`) — surface "spawn-helper-quarantine" as a check.

**API:**
```ts
// inside node-pty-perms.ts
async function clearQuarantineXattr(path: string): Promise<{ cleared: boolean }>;
```

**Acceptance tests:**
- Manual: `xattr -w com.apple.quarantine '0001;...' <spawn-helper-path>`, restart daemon → daemon clears at startup, logs the action.
- Unit only if `xattr` can be reliably set in a CI sandbox (likely no — defer to manual).

**Why this matters.** Belt-and-suspenders for the auto-chmod layer. Real-world incidence is low; deferral is fine.

---

### #11 — Fleet-health dashboard widget

**Status:** ⏸ Deferred. Tier 3. Data source is ready: `cortextos status --json` (shipped in PR #44) returns the full `AgentStatus[]` payload with all 9 deep-health fields. No IPC plumbing to invent.

**Problem.** No glanceable surface for "is the fleet OK right now?". Operator finds out about problems via manual `cortextos status` or Telegram.

**Spec.** Dashboard panel with:
- Per-agent traffic light: green (healthy + fresh heartbeat), yellow (stale heartbeat OR recent restart < 1h), red (`crashed`/`halted`/`crashCount >= maxCrashesPerDay`).
- Last-N restarts.log entries per agent (scrolling, last 20).
- Click-to-restart button per agent.
- Last spawn-failure-history event (if any in last 24h).
- Last cron-dispatch-storm event (#1).
- Refresh every 30s.

**Data source.** `cortextos status --json` (#5) via the existing IPC client at `dashboard/src/lib/ipc-client.ts:99-137`. Add a `dashboard/src/app/api/fleet/health/route.ts` that wraps it.

**Files:**
- Create `dashboard/src/app/api/fleet/health/route.ts`.
- Create `dashboard/src/app/fleet-health/page.tsx`.
- Create `dashboard/src/components/fleet-health/AgentCard.tsx`, `StatusLight.tsx`, `RestartButton.tsx`.

**Acceptance tests:**
- Manual: page loads, shows current state, refreshes every 30s, restart button restarts (verify in `cortextos status` after click).
- Unit: `AgentCard.test.tsx > green/yellow/red logic against fixture statuses`.

**Why this is here, not in Tier 1.** Telegram already covers the urgent case once #1 + #2 + #4 land. This is upgrade-the-control-panel work, not close-the-bug work.

---

## How to use this plan

- **Pick by number, not order** — each item is self-contained.
- **Day-1 trio:** #1 + #2 + #4 close the May-14 detection gap. Ship these three if you ship nothing else.
- **#5 first** if you'll do more than one of #2 / #4 / #11.
- **#3 is a 30-min live-fire fix** — slot it anywhere.
- **Don't try to do all of Tier 3** — pick what solves current pain, defer the rest.

## What's already shipped (cross-references)

- **PR #37** (merged 2026-05-14) — spawn-failure retry symmetry + cross-agent storm detector (`src/daemon/spawn-failure-tracker.ts`).
- **PR #40** (merged 2026-05-15) — auto-chmod spawn-helper at startup + postinstall (`src/utils/node-pty-perms.ts`, `scripts/ensure-node-pty-perms.mjs`).
- **PR #41** (merged 2026-05-15) — original punch-list version of this doc.
- **Post-mortem** — `docs_sb/issues/07-posix-spawnp-after-pnpm-reinstall.md`.

## Risk register

| Risk | Affects | Mitigation |
|---|---|---|
| Alert fatigue from over-firing | #1, #2, #4 | Cooldowns enforced by shared `operator-alert.ts`; default thresholds tuned conservatively (10 min, 30 min, 3-distinct). Tune from telemetry, not guess. |
| Doctor extraction breaks `cortextos doctor` text output | #4 sub-task | Snapshot test on table output before/after refactor. |
| Heartbeat watcher false-positive during cold boot (agent slow to write first heartbeat) | #2 | Watcher waits for first heartbeat write before arming. Don't alert until baseline established. |
| Crash-budget reset hides a real flapping agent | #7 | Reset only on PLANNED restarts, never on CRASH/SPAWN-FAIL cycles. Audit line in restarts.log. |
| `launchctl load` fails silently on locked-down macOS | #6 | Capture exit code; print actionable error in summary table; don't fail-fast on the rest of install. |
| Dashboard widget polls IPC every 30s × many open tabs = daemon load | #11 | Single shared SSE/poll on the API route, fan out client-side. |

## Verification of "done"

After Tier 1 ships, simulate a May-14-shape incident on a staging instance and confirm an operator-chat Telegram alert fires within 5 minutes for each of:

1. Inject a fake `pty.spawn()` failure → cron storm builds → #1 fires within 30 min of first failure (with thresholds at defaults).
2. Freeze an agent's heartbeat write (truncate the file or pause the agent's heartbeat cron) → #2 fires at threshold + 1 minute.
3. Break a doctor check on the live host (e.g. revoke spawn-helper exec bit) → #4 fires at the next 30-min tick.

If all three fire without manual intervention, the Day-1 trio is verified. Tier 2 and 3 don't have a single integration smoke test — verify per-phase.
