/**
 * SessionEnd hook - crash alert via Telegram.
 * Categorizes session end type and sends notification.
 *
 * Behavior:
 *   - Detects Anthropic weekly/5h rate-limit messages in stdout.log and
 *     classifies the exit as "rate-limited" so it is suppressed rather than
 *     spamming a 🚨 CRASH alert every 30 minutes while the daemon respawn
 *     loop continues hitting the wall.
 *   - Applies quiet hours (22:00-07:00 America/Los_Angeles) for routine end
 *     types (planned-restart, session-refresh, daemon-stop, user-*,
 *     rate-limited). A real unexpected crash still pages at night.
 *   - Deduplicates identical alerts for the same agent within 10 minutes so a
 *     broken watchdog loop results in at most one notification, not a buzz
 *     storm.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';

const DEDUP_WINDOW_MS = 10 * 60 * 1000;         // 10 minutes
const QUIET_HOUR_START_LA = 22;                 // 22:00 America/Los_Angeles
const QUIET_HOUR_END_LA = 7;                    // 07:00 America/Los_Angeles

// End types that are routine and should be suppressed during quiet hours.
// "crash" is deliberately NOT in this list — a genuine unexpected crash at
// 3am is worth waking up for.
const QUIET_SUPPRESSED_TYPES = new Set([
  'planned-restart',
  'session-refresh',
  'daemon-stop',
  'user-restart',
  'user-disable',
  'user-stop',
  'rate-limited',
]);

function isQuietHoursLA(now: Date): boolean {
  const laString = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
  });
  const m = laString.match(/\d+\/\d+\/\d+,?\s+(\d+):/);
  if (!m) return false;
  const hour = parseInt(m[1], 10);
  // Window wraps midnight: 22:00-23:59 OR 00:00-06:59
  return hour >= QUIET_HOUR_START_LA || hour < QUIET_HOUR_END_LA;
}

/**
 * Profile-quota patterns for BL-003 phase 2.
 *
 * Distinct from `detectRateLimitInLog` below: these are the structured
 * Anthropic API / HTTP error signatures that map to "this profile's
 * billing/quota is exhausted, switch to its fallback". The
 * rate-limit detector is a UX-level classifier (broader: includes
 * "weekly limit", "5h limit", "used 80% of your" — used to suppress
 * Telegram crash alerts during pause windows). Quota detection is
 * narrower (regex-only, structured) and emits a bus event boss
 * subscribes to in phase 3.
 *
 * The two intentionally remain separate functions: merging them
 * would require a single return shape that serves both audiences,
 * which loses the clean "did we hit a known quota error" check
 * (boss needs the pattern name; the rate-limit classifier just
 * needs a boolean).
 *
 * Pattern source: spec
 *   docs/roadmap/v0.4-cortexos-retrofit/... → BL-2026-05-08-003 §"Quota detection".
 * Validate against any new Anthropic error semantics before adding
 * patterns — false positives here cascade into spurious failovers.
 */
const QUOTA_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'rate_limit_exceeded', regex: /rate_limit_exceeded/i },
  { name: 'credit_balance_too_low', regex: /credit_balance_too_low/i },
  { name: 'quota_exceeded', regex: /quota.{0,10}exceeded/i },
  { name: 'http_429', regex: /HTTP\s+429/ },
  { name: 'usage_limit_reached', regex: /usage_limit_reached/i },
];

/**
 * Scan the tail of `logPath` for any QUOTA_PATTERNS match. Returns the
 * first match's name (deterministic — array order = priority) so the
 * emitted `profile_quota_exhausted` event includes a stable
 * `error_pattern` field rather than the full matched substring (which
 * could carry secrets / stack frames / megabytes of context).
 *
 * Returns `{ matched: false, pattern: null }` on missing log, read
 * error, or no match. Never throws — this runs on the SessionEnd hook
 * path and a hook crash would silently lose the alert window.
 */
export function detectProfileQuotaExhaustion(logPath: string): {
  matched: boolean;
  pattern: string | null;
} {
  try {
    const size = statSync(logPath).size;
    const readBytes = Math.min(size, 200 * 1024); // last 200 KB
    const fd = readFileSync(logPath);
    const slice = fd.slice(Math.max(0, fd.length - readBytes)).toString('utf-8');
    // Strip ANSI color codes — Anthropic error messages render with them.
    const text = slice.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    for (const { name, regex } of QUOTA_PATTERNS) {
      if (regex.test(text)) {
        return { matched: true, pattern: name };
      }
    }
    return { matched: false, pattern: null };
  } catch {
    return { matched: false, pattern: null };
  }
}

/**
 * Read `claude_profile` from the agent's config.json. Returns null
 * when absent, malformed, or non-string. Caller treats null as
 * "agent uses default profile" for event metadata — boss's failover
 * skill (phase 3) checks the registry to find the agent's actual
 * resolved profile.
 */
export function readClaudeProfile(agentDir: string | undefined): string | null {
  if (!agentDir) return null;
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    return typeof cfg.claude_profile === 'string' && cfg.claude_profile ? cfg.claude_profile : null;
  } catch {
    return null;
  }
}

/**
 * Emit a `profile_quota_exhausted` bus event. Best-effort, fire-and-
 * forget — a failure here must not block the SessionEnd hook (which
 * still needs to fire crash alerts, dedup, etc.). Boss subscribes
 * to this event name in phase 3 and uses the metadata to decide
 * whether to fail over the agent to its `fallback_profile`.
 */
export function emitProfileQuotaExhausted(meta: {
  agent: string;
  profile: string | null;
  error_pattern: string;
  observed_at: string;
}): void {
  try {
    execFile(
      'cortextos',
      ['bus', 'log-event', 'action', 'profile_quota_exhausted', 'warning', '--meta', JSON.stringify(meta)],
      { timeout: 5_000 },
      () => { /* fire-and-forget */ },
    );
  } catch { /* never throw out of the SessionEnd hook */ }
}

/**
 * Scan the tail of stdout.log for Anthropic rate-limit or weekly-limit
 * signatures. Mirrors OutputBuffer.hasRateLimitSignature so the hook and the
 * daemon use the same detection logic.
 */
function detectRateLimitInLog(logPath: string): boolean {
  try {
    const size = statSync(logPath).size;
    const readBytes = Math.min(size, 200 * 1024); // last 200 KB
    const fd = readFileSync(logPath);
    const slice = fd.slice(Math.max(0, fd.length - readBytes)).toString('utf-8');
    const text = slice.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    return (
      text.includes('overloaded_error') ||
      text.includes('rate_limit_error') ||
      text.includes('rate limit') ||
      text.includes('rate-limit') ||
      text.includes('too many requests') ||
      text.includes('quota exceeded') ||
      text.includes('usage limit') ||
      text.includes('weekly limit') ||
      text.includes('5-hour limit') ||
      text.includes('5h limit') ||
      /used \d+% of your/.test(text)
    );
  } catch {
    return false;
  }
}

/**
 * Read max_crashes_per_day from the agent's config.json. Returns null if the
 * file is missing, malformed, or the field is not a number — caller treats
 * null as "no limit configured" so a missing config never blocks the alert.
 */
export function readMaxCrashesPerDay(agentDir: string | undefined): number | null {
  if (!agentDir) return null;
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    return typeof cfg.max_crashes_per_day === 'number' ? cfg.max_crashes_per_day : null;
  } catch {
    return null;
  }
}

/**
 * Send a crash notification via `cortextos bus send-message` to the listed
 * recipient agents. Best-effort: failures are swallowed so an alert miss never
 * cascades into a hook crash.
 */
export function notifyAgents(opts: {
  agentName: string;
  endType: string;
  reason: string;
  lastTask: string;
  crashCount: number;
  restartAttempted: boolean;
  recipients: string[];
}): void {
  const body = [
    `agent=${opts.agentName} crashed (type=${opts.endType})`,
    `reason: ${opts.reason || 'none'}`,
    `last status: ${opts.lastTask || 'unknown'}`,
    `crashes today: ${opts.crashCount}`,
    `restart attempted: ${opts.restartAttempted ? 'yes' : 'no (max_crashes_per_day reached)'}`,
  ].join('\n');
  for (const target of opts.recipients) {
    try {
      execFile(
        'cortextos',
        ['bus', 'send-message', target, 'high', body],
        { timeout: 10_000 },
        () => { /* fire-and-forget */ },
      );
    } catch { /* best-effort, never throw */ }
  }
}

/**
 * Return true if an identical (agent, type) alert was already sent within
 * the dedup window. Side effect: records this attempt when it is the first.
 */
function shouldSuppressDedup(stateDir: string, endType: string): boolean {
  const dedupFile = join(stateDir, '.crash_alert_dedup.json');
  const now = Date.now();
  let last: Record<string, number> = {};
  try {
    last = JSON.parse(readFileSync(dedupFile, 'utf-8')) as Record<string, number>;
  } catch { /* missing or corrupt — start fresh */ }
  const prev = last[endType] ?? 0;
  if (now - prev < DEDUP_WINDOW_MS) {
    return true;
  }
  last[endType] = now;
  try {
    writeFileSync(dedupFile, JSON.stringify(last), 'utf-8');
  } catch { /* ignore */ }
  return false;
}

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  const stateDir = join(ctxRoot, 'state', agentName);
  const logDir = join(ctxRoot, 'logs', agentName);

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // Determine end type from state markers (written by other parts of the system
  // before the Claude Code session exits).
  let endType = 'crash';
  let reason = '';

  const markers = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-disable', type: 'user-disable' },
    { file: '.user-stop', type: 'user-stop' },
    // .daemon-crashed wins over .daemon-stop when both are present — a crash
    // during shutdown is the more important signal. Written by the daemon's
    // uncaughtException handler in src/daemon/index.ts.
    { file: '.daemon-crashed', type: 'daemon-crashed' },
    { file: '.daemon-stop', type: 'daemon-stop' },
  ];

  for (const marker of markers) {
    const markerPath = join(stateDir, marker.file);
    if (existsSync(markerPath)) {
      endType = marker.type;
      try {
        reason = readFileSync(markerPath, 'utf-8').trim();
        unlinkSync(markerPath);
      } catch { /* ignore */ }
      break;
    }
  }

  // If no marker matched but the stdout tail shows a rate-limit signature,
  // reclassify as rate-limited. Prevents the 30-minute 🚨 CRASH buzz storm
  // when the weekly limit is exhausted.
  if (endType === 'crash') {
    const stdoutPath = join(logDir, 'stdout.log');
    if (existsSync(stdoutPath) && detectRateLimitInLog(stdoutPath)) {
      endType = 'rate-limited';
      reason = 'anthropic rate limit detected in stdout.log';
    }
  }

  // BL-003 phase 2: structured quota detection → profile_quota_exhausted bus event.
  // Independent of the rate-limited reclassification above: an exit
  // can be classified as 'crash' (no UX rate-limit string) but still
  // trip a quota pattern in stderr.log (structured Anthropic API
  // error). Both detectors run; either firing emits the bus event.
  // Boss's phase-3 failover skill subscribes to this event and uses
  // the metadata to swap agents to their fallback_profile.
  //
  // The event fires even during quiet hours and even if Telegram is
  // muted — crash alerts are operator-comfort gated, but failover
  // signal is reliability-gated and must always reach the bus.
  {
    const stdoutPath = join(logDir, 'stdout.log');
    const stderrPath = join(logDir, 'stderr.log');
    let quotaMatch: { matched: boolean; pattern: string | null } = { matched: false, pattern: null };
    for (const path of [stderrPath, stdoutPath]) {
      if (existsSync(path)) {
        const result = detectProfileQuotaExhaustion(path);
        if (result.matched) {
          quotaMatch = result;
          break;
        }
      }
    }
    if (quotaMatch.matched && quotaMatch.pattern) {
      const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
      emitProfileQuotaExhausted({
        agent: agentName,
        profile: readClaudeProfile(agentDir),
        error_pattern: quotaMatch.pattern,
        observed_at: new Date().toISOString(),
      });
    }
  }

  // Track crash count (real crashes only).
  const today = new Date().toISOString().split('T')[0];
  const countFile = join(stateDir, '.crash_count_today');
  let crashCount = 0;
  if (endType === 'crash') {
    try {
      const data = readFileSync(countFile, 'utf-8').trim();
      const [date, count] = data.split(':');
      crashCount = date === today ? parseInt(count, 10) + 1 : 1;
    } catch {
      crashCount = 1;
    }
    try {
      writeFileSync(countFile, `${today}:${crashCount}`, 'utf-8');
    } catch { /* ignore */ }
  } else if (endType === 'daemon-crashed') {
    // Read-only: surface today's count to chief/analyst without mutating it.
    try {
      const data = readFileSync(countFile, 'utf-8').trim();
      const [date, count] = data.split(':');
      crashCount = date === today ? parseInt(count, 10) : 0;
    } catch {
      crashCount = 0;
    }
  }

  // Read last heartbeat for context
  let lastTask = '';
  try {
    const hb = JSON.parse(readFileSync(join(stateDir, 'heartbeat.json'), 'utf-8'));
    lastTask = hb.status || '';
  } catch { /* ignore */ }

  // Always log to crashes.log — we want visibility even when alerts are muted.
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} type=${endType} reason=${reason || 'none'} last_task=${lastTask}\n`;
  try {
    appendFileSync(join(logDir, 'crashes.log'), logLine);
  } catch { /* ignore */ }

  // Decide whether to actually send to Telegram.
  const now = new Date();
  const quiet = isQuietHoursLA(now);
  if (quiet && QUIET_SUPPRESSED_TYPES.has(endType)) {
    return;
  }
  if (shouldSuppressDedup(stateDir, endType)) {
    return;
  }

  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
  if (!botToken || !chatId) return;

  let message = '';
  switch (endType) {
    case 'planned-restart':
      message = reason?.startsWith('CONTEXT-FORCE-RESTART')
        ? `🔄 ${agentName} restarting with memory`
        : `🔄 ${agentName} restarted (planned): ${reason || 'no reason given'}`;
      break;
    case 'session-refresh':
      message = `♻️ ${agentName} session refresh (context exhaustion). Restarting with fresh session.`;
      break;
    case 'user-restart':
      message = `🔄 ${agentName} restarted by user: ${reason || 'no reason given'}`;
      break;
    case 'user-disable':
      message = `⏸️ ${agentName} disabled by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case 'user-stop':
      message = `⏹️ ${agentName} stopped by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case 'daemon-stop':
      message = `🛑 ${agentName} stopped (daemon shutdown).`;
      if (reason) message += ` (${reason})`;
      break;
    case 'daemon-crashed':
      // Deliberately NOT suppressed during quiet hours — a daemon crash at
      // 3am is genuinely worth waking for (historically it has preceded
      // fleet-wide restart storms). Crash-loop alerts from the daemon
      // itself add operator-level urgency; this is the per-agent variant
      // that replaces the misleading "🚨 agent crashed" message users
      // were getting on every daemon respawn.
      message = `🚨 ${agentName} — daemon crashed, session was interrupted. Resuming.`;
      if (reason) message += `\nCrash time: ${reason}`;
      break;
    case 'rate-limited':
      message = `⏳ ${agentName} paused — Anthropic rate limit hit. Will resume when the window resets.`;
      break;
    case 'crash':
      message = `🚨 CRASH: ${agentName} died unexpectedly.`;
      if (crashCount > 0) message += ` Crashes today: ${crashCount}.`;
      if (lastTask) message += `\nLast status: ${lastTask}`;
      break;
  }

  if (message) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
    } catch { /* ignore send failures */ }
  }

  // Real-crash agent alerts: notify chief + analyst on crash and daemon-crashed
  // so silent failures get visibility on the bus, not just on Telegram. Gated
  // by the same dedup window as the Telegram send (handled above), and skipped
  // for clean exits / planned restarts / rate-limit pauses.
  if (endType === 'crash' || endType === 'daemon-crashed') {
    const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
    const maxCrashes = readMaxCrashesPerDay(agentDir);
    const restartAttempted = maxCrashes === null || crashCount < maxCrashes;
    notifyAgents({
      agentName,
      endType,
      reason,
      lastTask,
      crashCount,
      restartAttempted,
      recipients: ['chief', 'analyst'],
    });
  }
}

main().catch(() => process.exit(0));
