# cortextOS — What It Is and How It Works

## Layer 1 — What it is

A persistent multi-agent operating system. Each agent is a Claude Code session running 24/7 in its own PTY, supervised by a Node.js daemon. You command the fleet from Telegram. Output is events, files, code, and Telegram messages back to you.

## Layer 2 — The moving parts

```
Telegram  ──►  fast-checker  ──►  agent PTYs  ──►  bus + events
   ▲                                  │
   │                                  ▼
   └────────  bus send-telegram  ──  daemon (cron + crash mgmt)
                                      │
                                      ▼
                                  dashboard (Next.js, :3000)
```

- **Daemon** — owns lifecycle: starts/stops agents, runs persistent crons from each agent's `crons.json`, restarts on crash, rotates context every ~71h.
- **Fast-checker** — long-polls Telegram, drops incoming messages into the right agent's PTY in real time.
- **Bus** — every agent action (`send-telegram`, `send-message`, `log-event`, `create-task`, `heartbeat`, `kb-ingest`, `add-cron`, etc.) goes through CLI scripts in `bus/`. If an action does not go through the bus, it is invisible to the rest of the system.
- **Dashboard** — Next.js app at http://localhost:3000. Pages: Agents, Tasks, Approvals, Analytics, Experiments.
- **Agents** — markdown-defined personalities (`SOUL.md`, `IDENTITY.md`) + skills (`.claude/skills/`) + bootstrap files (`GOALS.md`, `MEMORY.md`, `SYSTEM.md`, `USER.md`, `HEARTBEAT.md`, `TOOLS.md`).

## Layer 3 — How work flows

1. The user messages the orchestrator (Boss) on Telegram.
2. Boss creates tasks and dispatches to specialists via `bus send-message`.
3. Specialists do the work, log events (`task_completed`, `error`, `metrics_collected`, etc.), update memory.
4. The Analyst (Banner) watches the event stream + heartbeats. Anomalies become a ping or a page back to the user.
5. Daily at 08:00 IST: Analyst pushes an exec brief. Sunday 08:00 IST: one improvement suggestion with evidence.
6. Approvals (external comms, deploys, financial actions, data deletion) gate-stop until the user clicks yes/no on the dashboard.

## Layer 4 — Memory and learning

Three layers per agent:

- **Long-term** — `MEMORY.md` at the agent root. Read every session start.
- **Daily** — `memory/YYYY-MM-DD.md`. WORKING ON / COMPLETED entries. Survives session crashes.
- **Knowledge base** — vector store (Gemini-backed). Auto-indexed from `MEMORY.md` every heartbeat. Used to correlate past incidents and search runbooks.

## Layer 5 — Improvement loop (theta wave)

Once a day (analyst runs it at 02:00 UTC) the analyst scans the entire system: every agent's experiments, system health, goal progress. It pulls external research. Output is one or more proposed changes — skill installs, cron tweaks, prompt fixes. Proposals route through Boss for sanity-check, then to the user for approval. Nothing applies without explicit yes.

## Layer 6 — How the user controls the system

- **Telegram** is the primary control surface. Reply to any agent directly.
- **Dashboard** at http://localhost:3000 for at-a-glance health and approval queue.
- **Terminal**:
  - `cortextos status` — quick health overview
  - `cortextos start <name>` / `cortextos stop <name>` — agent lifecycle
  - `cortextos bus list-agents` — live roster
  - `cortextos bus list-crons <agent>` — see scheduled work
- **Adding specialists** — tell Boss what role you need; he walks you through bot creation, env setup, and onboarding.

## Layer 7 — Approval categories (gated by default)

- `external-comms` — emails, public posts, anything that leaves the system
- `financial` — payments, subscription changes, anything that costs money
- `deployment` — pushing to main, production deploys
- `data-deletion` — destructive operations on user data

Configured per-org in `orgs/<org>/context.json` under `default_approval_categories`.

## Layer 8 — Key directories

| Path | Purpose |
|------|---------|
| `src/` | TypeScript source — bus, cli, daemon, hooks, types, utils |
| `bus/` | Shell wrappers (delegate to `dist/cli.js bus`) |
| `dashboard/` | Next.js 14 web dashboard |
| `templates/` | Agent templates (agent, orchestrator, analyst) |
| `community/` | Community skills and agent catalog |
| `orgs/<org>/agents/<agent>/` | Per-agent bootstrap files, config, memory |
| `~/.cortextos/<instance>/state/<agent>/` | Runtime state, including `.onboarded` marker, `crons.json` |
| `~/.cortextos/<instance>/logs/<agent>/` | Stdout, stderr, fast-checker log, inbound/outbound message logs |
| `~/.cortextos/<instance>/analytics/` | Event logs (`events/<agent>/<date>.jsonl`), metrics reports |

## TL;DR

cortextOS is a Telegram-driven, daemon-supervised fleet of Claude Code agents that ship real work, log everything as events, gate destructive actions behind approvals, and improve themselves through a daily theta-wave cycle. The user stays on Telegram; the system stays alive on the daemon.
