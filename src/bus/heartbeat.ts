import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 *
 * Path B watchdog (watchdog-threshold-tuning spec): also maintains
 * `task_started_at` independent of `last_heartbeat`. Set to `now` on every
 * current_task transition (empty→non-empty, or non-empty→different
 * non-empty); cleared to null when current_task is empty; preserved when
 * current_task is unchanged. The task-stuck watcher reads this to measure
 * "how long has this task been held" without being fooled by side-channel
 * heartbeat refreshes (send-telegram, send-message).
 */
export function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: { org?: string; timezone?: string; loopInterval?: string; currentTask?: string; displayName?: string },
): void {
  ensureDir(paths.stateDir);

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mode = options?.timezone ? detectDayNightMode(options.timezone) : detectDayNightMode('UTC');
  const newCurrentTask = options?.currentTask ?? '';

  // Path B: compute task_started_at by reading the prior heartbeat (best-
  // effort; on read failure we treat it as a transition, which is safe — at
  // worst we re-stamp once on an existing task and the watcher resets its
  // clock once).
  const taskStartedAt = computeTaskStartedAt(paths, newCurrentTask, ts);

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: newCurrentTask,
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? '',
    task_started_at: taskStartedAt,
  };

  atomicWriteSync(
    join(paths.stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat),
  );
}

/**
 * Path B helper — derive task_started_at for the new heartbeat write.
 *
 * Rules:
 *   - newCurrentTask === ''           → null (no active task)
 *   - prior unreadable / first write  → `now` (treat as a transition)
 *   - prior.current_task !== new      → `now` (transition)
 *   - prior.current_task === new      → prior.task_started_at (preserve;
 *                                       fall back to `now` if prior didn't
 *                                       carry the field, e.g. older write)
 */
function computeTaskStartedAt(paths: BusPaths, newCurrentTask: string, now: string): string | null {
  if (newCurrentTask === '') return null;
  const hbPath = join(paths.stateDir, 'heartbeat.json');
  if (!existsSync(hbPath)) return now;
  try {
    const prior = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    if (prior.current_task !== newCurrentTask) return now;
    return prior.task_started_at ?? now;
  } catch {
    return now;
  }
}

/**
 * Detect day/night mode based on timezone.
 * Day: 8:00 - 22:00, Night: 22:00 - 8:00
 */
export function detectDayNightMode(timezone: string): 'day' | 'night' {
  try {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', { timeZone: timezone, hour12: false, hour: '2-digit' });
    const hour = parseInt(formatted, 10);
    return (hour >= 8 && hour < 22) ? 'day' : 'night';
  } catch {
    // Fallback to UTC
    const hour = new Date().getUTCHours();
    return (hour >= 8 && hour < 22) ? 'day' : 'night';
  }
}

/**
 * Read all agent heartbeats.
 * Scans state/ directory for agent subdirs containing heartbeat.json.
 * Matches dashboard heartbeat path: state/{agent}/heartbeat.json
 */
export function readAllHeartbeats(paths: BusPaths): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  const stateDir = join(paths.ctxRoot, 'state');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const agent of agentDirs) {
    const hbPath = join(stateDir, agent, 'heartbeat.json');
    try {
      const content = readFileSync(hbPath, 'utf-8');
      heartbeats.push(JSON.parse(content));
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}
