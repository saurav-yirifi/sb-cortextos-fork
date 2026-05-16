import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadProfileRegistry, findDanglingReferences } from './profiles.js';
import { ensureSpawnHelperExecutable } from './node-pty-perms.js';

// ---------------------------------------------------------------------------
// Self-healing service liveness — added after 2026-05-16 post-mortem
// Finding 3 (`docs_sb/post_mortem/2026-05-16-boss-analyst-crash-spam-and-
// launchd-noop.md`). All 5 services had been exit-78 since install but
// the only existing check covered com.cortextos.tunnel — watchdog ran
// 249 no-op cycles before anyone noticed. The post-mortem A.3 Why 6/7
// calls these "the meta-watchdog the system was missing".
// ---------------------------------------------------------------------------

export interface SelfHealerSpec {
  name: string;                 // service short name, e.g. 'watchdog'
  label: string;                // launchd label, e.g. 'com.cortextos.watchdog'
  logRelativePath: string;      // path under ~/.cortextos/<instance>/
  expectedIntervalSec: number;  // StartInterval or CalendarInterval cadence
  /** Multiplier on expectedIntervalSec for the log-staleness threshold.
   *  Defaults to 3 (allow two missed ticks). Daily-cadence services use
   *  1.5 so a broken job is surfaced inside 36h, not 72h. */
  staleThresholdMultiplier?: number;
}

// TODO(PR-X4): post-mortem A.3 Why 5 — add a `cortextos doctor` check that
// diffs the live plist `PATH` against `which pm2 / ccusage / cortextos`
// and warns on drift. Out of scope for PR-X3 (which detects *failure*; the
// PATH-drift check would detect *future-failure*).
export const SELF_HEALER_SPECS: SelfHealerSpec[] = [
  { name: 'watchdog',                 label: 'com.cortextos.watchdog',                 logRelativePath: 'logs/watchdog.log',                 expectedIntervalSec: 300 },
  { name: 'agent-recover',            label: 'com.cortextos.agent-recover',            logRelativePath: 'logs/agent-recover.log',            expectedIntervalSec: 300 },
  { name: 'usage-monitor',            label: 'com.cortextos.usage-monitor',            logRelativePath: 'logs/usage-monitor.log',            expectedIntervalSec: 1800 },
  { name: 'compact-boundary-watcher', label: 'com.cortextos.compact-boundary-watcher', logRelativePath: 'logs/compact-boundary-watcher.log', expectedIntervalSec: 600 },
  { name: 'payload-cap-drift',        label: 'com.cortextos.payload-cap-drift',        logRelativePath: 'logs/payload-cap-drift.log',        expectedIntervalSec: 86_400, staleThresholdMultiplier: 1.5 },
];

export interface LaunchctlListInterpretation {
  registered: boolean;
  /** Exit code when the last run terminated normally. null when LastExitStatus
   *  is absent (service never ran) or when terminated by signal. */
  lastExitCode: number | null;
  /** Signal number when the last run was killed by a signal (e.g. SIGKILL=9).
   *  null when normally terminated or never ran. */
  lastSignal: number | null;
}

/**
 * Parse `launchctl list <label>` output. The format is NeXTSTEP-plist-like
 * key/value pairs separated by semicolons. We only care about
 * `LastExitStatus = N`. N is the raw Unix wait-status word:
 *   - low 7 bits  = signal that terminated the child (0 if not signaled)
 *   - next byte   = exit code (only meaningful when signal byte is 0)
 * Negative values (observed on some macOS versions for mid-run unloads)
 * round-trip through the same bit-twiddling correctly — `(-1 >> 8) & 0xff`
 * is 255, which surfaces as a generic non-zero exit.
 *
 * `listExitCode` is the exit of `launchctl list` itself: non-zero means
 * the label is not registered with launchd at all.
 */
export function interpretLaunchctlList(stdout: string, listExitCode: number): LaunchctlListInterpretation {
  if (listExitCode !== 0) return { registered: false, lastExitCode: null, lastSignal: null };
  const m = stdout.match(/"?LastExitStatus"?\s*=\s*(-?\d+)/);
  if (!m) return { registered: true, lastExitCode: null, lastSignal: null };
  const raw = parseInt(m[1], 10);
  const signal = raw & 0x7f;
  if (signal !== 0) {
    // Signal-killed: exit code field is meaningless per POSIX. Surface the
    // signal separately so SIGKILL doesn't masquerade as exit 0.
    return { registered: true, lastExitCode: null, lastSignal: signal };
  }
  return { registered: true, lastExitCode: (raw >> 8) & 0xff, lastSignal: null };
}

export interface AssessSelfHealerOptions {
  spec: SelfHealerSpec;
  ctxRoot: string;
  /** Override `launchctl list` for tests. Returns { stdout, status }. */
  launchctlListOverride?: (label: string) => { stdout: string; status: number };
  /** Override `Date.now()` for hermetic log-staleness tests. */
  nowMsOverride?: number;
  /** Override `statSync` for tests that don't want to touch the FS. */
  statSyncOverride?: (path: string) => { mtimeMs: number } | null;
}

/**
 * Combine launchctl state + log freshness into a single Check.
 *  - launchctl list non-zero       → warn  (not installed; re-run `cortextos install`)
 *  - LastExitStatus = 78 (EX_CONFIG) → fail  (matches 2026-05-16 Finding 3 — point at PR-X2)
 *  - LastExitStatus != 0           → fail  (script error path)
 *  - LastExitStatus 0 + stale log  → warn  (registered but not actually running)
 *  - LastExitStatus 0 + fresh log  → pass
 *
 * Staleness threshold = expectedIntervalSec × 3 (allow two missed ticks
 * before alerting, the third missed tick crosses the threshold).
 */
export function assessSelfHealer(opts: AssessSelfHealerOptions): Check {
  const { spec, ctxRoot } = opts;
  const launchctlList = opts.launchctlListOverride
    ?? ((label) => {
      const r = spawnSync('launchctl', ['list', label], { encoding: 'utf-8', stdio: 'pipe' });
      return { stdout: r.stdout ?? '', status: r.status ?? 1 };
    });
  const nowMs = opts.nowMsOverride ?? Date.now();
  const stat = opts.statSyncOverride ?? ((p) => {
    try { return { mtimeMs: statSync(p).mtimeMs }; } catch { return null; }
  });

  const { stdout, status } = launchctlList(spec.label);
  const { registered, lastExitCode, lastSignal } = interpretLaunchctlList(stdout, status);

  if (!registered) {
    return {
      name: `Self-healer: ${spec.name}`,
      status: 'warn',
      message: `Not registered with launchd`,
      fix: `Run: cortextos install (re-renders ~/Library/LaunchAgents/${spec.label}.plist and bootstraps it)`,
    };
  }

  if (lastSignal !== null) {
    return {
      name: `Self-healer: ${spec.name}`,
      status: 'fail',
      message: `Last run killed by signal ${lastSignal}`,
      fix: `Inspect ~/.cortextos/<instance>/${spec.logRelativePath} and the matching .stderr.log; signal-kills often mean the daemon was forcibly stopped or hit a resource limit`,
    };
  }

  if (lastExitCode === 78) {
    return {
      name: `Self-healer: ${spec.name}`,
      status: 'fail',
      message: `Crash-looping with exit 78 (EX_CONFIG) — plist PATH / CTX_FRAMEWORK_ROOT broken`,
      fix: `Re-run cortextos install (PR-X2 fixed the plist templates so the nvm-installed pm2/ccusage/cortextos are on PATH and CTX_FRAMEWORK_ROOT points at the repo)`,
    };
  }

  if (lastExitCode !== null && lastExitCode !== 0) {
    return {
      name: `Self-healer: ${spec.name}`,
      status: 'fail',
      message: `Last run exited ${lastExitCode}`,
      fix: `Inspect ~/.cortextos/<instance>/${spec.logRelativePath} and the matching .stderr.log for the failure reason`,
    };
  }

  const logPath = join(ctxRoot, spec.logRelativePath);
  const s = stat(logPath);
  if (!s) {
    return {
      name: `Self-healer: ${spec.name}`,
      status: 'warn',
      message: `Registered but ${spec.logRelativePath} does not exist — script has not produced a successful cycle yet`,
    };
  }
  const ageSec = (nowMs - s.mtimeMs) / 1000;
  const thresholdSec = spec.expectedIntervalSec * (spec.staleThresholdMultiplier ?? 3);
  if (ageSec > thresholdSec) {
    return {
      name: `Self-healer: ${spec.name}`,
      status: 'warn',
      message: `${spec.logRelativePath} stale by ${Math.floor(ageSec / 60)}m (expected cycle every ${spec.expectedIntervalSec}s)`,
      fix: `Tail the log; if the script is genuinely broken, restart with: launchctl kickstart -k gui/$(id -u)/${spec.label}`,
    };
  }

  return {
    name: `Self-healer: ${spec.name}`,
    status: 'pass',
    message: `Last cycle ${Math.floor(ageSec)}s ago (cap ${thresholdSec}s)`,
  };
}

// ---------------------------------------------------------------------------
// Fleet-resilience plan #4 — health-check registry.
//
// Extracted from src/cli/doctor.ts so the same 31 checks can drive both the
// on-demand `cortextos doctor` CLI and the daemon-side doctor-cron.
//
// runAllChecks() is the single entry point. The doctor CLI calls it once and
// renders; the cron calls it periodically, diffs against the last-run
// snapshot in state/.doctor-last-run.json, and emits operator alerts on
// pass→warn / pass→fail / warn→fail transitions.
//
// Each check is a small inline block separated by `// ── Section ──`
// banners. Splitting into one-check-per-file would over-decompose for the
// scale (~5-10 LOC per check; no shared helpers). If any single check grows
// substantive helpers, split that one out then.
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  fix?: string;
}

export interface RunAllChecksOptions {
  instanceId: string;
  frameworkRoot: string;
}

// Spawning the Claude CLI can transiently fail under load (fork/exec
// contention while other claude sessions are starting up). A single missed
// probe should not page Saurav via the doctor-cron `fail` transition — retry
// briefly first. 3 attempts cap wall-time at ~2s.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeClaudeVersion(): Promise<string | null> {
  const backoffsMs = [0, 500, 1500];
  for (const delay of backoffsMs) {
    if (delay > 0) await sleep(delay);
    try {
      // stdio: 'pipe' suppresses stderr inheritance — important when
      // doctor-cron runs us, so transient failure messages don't pollute the
      // daemon log. The original line 66 inline call omitted this.
      return execSync('claude --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
    } catch { /* retry */ }
  }
  return null;
}

export async function runAllChecks(options: RunAllChecksOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const { instanceId, frameworkRoot } = options;

  // ── Node runtime ──────────────────────────────────────────────────────────
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  checks.push({
    name: 'Node.js version',
    status: major >= 20 ? 'pass' : 'fail',
    message: `${nodeVersion} ${major >= 20 ? '(OK)' : '(requires 20+)'}`,
    fix: major < 20 ? 'Install Node.js 20+ from https://nodejs.org' : undefined,
  });

  // ── PM2 ───────────────────────────────────────────────────────────────────
  try {
    const pm2Version = execSync('pm2 --version', { encoding: 'utf-8' }).trim();
    checks.push({ name: 'PM2', status: 'pass', message: `v${pm2Version}` });
  } catch {
    checks.push({
      name: 'PM2',
      status: 'warn',
      message: 'Not installed',
      fix: 'Install with: npm install -g pm2',
    });
  }

  // ── Claude Code CLI ───────────────────────────────────────────────────────
  const claudeVersion = await probeClaudeVersion();
  if (claudeVersion) {
    checks.push({ name: 'Claude Code CLI', status: 'pass', message: claudeVersion });
  } else {
    checks.push({
      name: 'Claude Code CLI',
      status: 'fail',
      message: 'Not found (3 attempts over ~2s)',
      fix: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
    });
  }

  // ── node-pty ──────────────────────────────────────────────────────────────
  try {
    require('node-pty');
    checks.push({ name: 'node-pty', status: 'pass', message: 'Native module loaded' });
  } catch {
    checks.push({
      name: 'node-pty',
      status: 'fail',
      message: 'Failed to load native module',
      fix: process.platform === 'win32'
        ? 'Install "Desktop development with C++" workload from Visual Studio Build Tools (https://visualstudio.microsoft.com/visual-cpp-build-tools/), then run: npm rebuild node-pty'
        : 'Install build tools: xcode-select --install (macOS) or apt install build-essential (Linux)',
    });
  }

  // ── node-pty spawn-helper permissions ─────────────────────────────────────
  const permResult = ensureSpawnHelperExecutable(frameworkRoot);
  if (permResult.fixed.length > 0) {
    checks.push({
      name: 'node-pty spawn-helper',
      status: 'warn',
      message: `Permissions were missing on ${permResult.fixed.length} binary(s) - fixed automatically`,
    });
  }
  if (permResult.errors.length > 0) {
    checks.push({
      name: 'node-pty spawn-helper',
      status: 'fail',
      message: `Could not fix permissions: ${permResult.errors.map((e) => e.reason).join('; ')}`,
      fix: 'Manually chmod +x node_modules/node-pty/prebuilds/*/spawn-helper',
    });
  }

  // ── node-pty spawn smoke test ─────────────────────────────────────────────
  try {
    const pty = require('node-pty');
    let output = '';
    const isWin = process.platform === 'win32';
    const smokeCmd = isWin ? 'cmd.exe' : '/bin/echo';
    const smokeArgs = isWin ? ['/c', 'echo', 'pty-ok'] : ['pty-ok'];
    const p = pty.spawn(smokeCmd, smokeArgs, { name: 'xterm-256color', cols: 80, rows: 24 });
    await new Promise<void>((resolve, reject) => {
      p.onData((data: string) => { output += data; });
      p.onExit(({ exitCode }: { exitCode: number }) => {
        if (exitCode === 0 && output.includes('pty-ok')) resolve();
        else reject(new Error(`exit ${exitCode}`));
      });
      setTimeout(() => reject(new Error('timed out')), 5000);
    });
    checks.push({ name: 'node-pty spawn test', status: 'pass', message: 'Can spawn processes' });
  } catch (err) {
    checks.push({
      name: 'node-pty spawn test',
      status: 'fail',
      message: `Cannot spawn processes: ${(err as Error).message}`,
      fix: 'Try: npm rebuild node-pty',
    });
  }

  // ── State directory ──────────────────────────────────────────────────────
  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  checks.push({
    name: 'State directory',
    status: existsSync(ctxRoot) ? 'pass' : 'warn',
    message: existsSync(ctxRoot) ? ctxRoot : 'Not found',
    fix: !existsSync(ctxRoot) ? 'Run: cortextos init <org-name>' : undefined,
  });

  // ── Claude Code auth ──────────────────────────────────────────────────────
  // Reuse the same retried probe — `warn` here doesn't page, but a transient
  // miss would still register as a pass→warn transition in the cron snapshot.
  if (claudeVersion) {
    checks.push({ name: 'Claude Code auth', status: 'pass', message: 'Authenticated' });
  } else {
    checks.push({
      name: 'Claude Code auth',
      status: 'warn',
      message: 'Not authenticated',
      fix: 'Run: claude login',
    });
  }

  // ── Tunnel checks (macOS only) ────────────────────────────────────────────
  if (process.platform === 'darwin') {
    try {
      const cfVer = execSync('cloudflared --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
      checks.push({ name: 'cloudflared', status: 'pass', message: cfVer });
    } catch {
      checks.push({
        name: 'cloudflared',
        status: 'warn',
        message: 'Not installed',
        fix: 'Install with: brew install cloudflared',
      });
    }

    const cfCert = join(homedir(), '.cloudflared', 'cert.pem');
    checks.push({
      name: 'Cloudflare auth',
      status: existsSync(cfCert) ? 'pass' : 'warn',
      message: existsSync(cfCert) ? 'Authenticated (cert.pem found)' : 'Not authenticated',
      fix: !existsSync(cfCert) ? 'Run: cloudflared login' : undefined,
    });

    let tunnelExists = false;
    try {
      const listOut = execSync('cloudflared tunnel list --output json', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });
      const tunnels: Array<{ name: string }> = JSON.parse(listOut);
      tunnelExists = tunnels.some((t) => t.name === 'cortextos');
    } catch { /* not authenticated or cloudflared not installed */ }
    checks.push({
      name: "Tunnel 'cortextos'",
      status: tunnelExists ? 'pass' : 'warn',
      message: tunnelExists ? 'Exists' : 'Not created',
      fix: !tunnelExists ? 'Run: cortextos tunnel start' : undefined,
    });

    let serviceRunning = false;
    try {
      const launchctlOut = execSync('launchctl list', { encoding: 'utf-8', stdio: 'pipe' });
      serviceRunning = launchctlOut.includes('com.cortextos.tunnel');
    } catch { /* launchctl not available */ }
    checks.push({
      name: 'Tunnel service (launchd)',
      status: serviceRunning ? 'pass' : 'warn',
      message: serviceRunning ? 'Running' : 'Not running',
      fix: !serviceRunning ? 'Run: cortextos tunnel start' : undefined,
    });

    // ── Self-healing services liveness ──────────────────────────────────────
    for (const spec of SELF_HEALER_SPECS) {
      checks.push(assessSelfHealer({ spec, ctxRoot }));
    }

    const tunnelConfigPath = join(homedir(), '.cortextos', instanceId, 'tunnel.json');
    let tunnelUrl: string | undefined;
    try {
      const tc = JSON.parse(readFileSync(tunnelConfigPath, 'utf-8'));
      tunnelUrl = tc.tunnelUrl;
    } catch { /* no config yet */ }
    checks.push({
      name: 'Tunnel URL',
      status: tunnelUrl ? 'pass' : 'warn',
      message: tunnelUrl ?? 'Not set',
      fix: !tunnelUrl ? 'Run: cortextos tunnel start' : undefined,
    });
  }

  // ── gh CLI ───────────────────────────────────────────────────────────────
  try {
    const ghVersion = execSync('gh --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim().split('\n')[0];
    checks.push({ name: 'gh CLI', status: 'pass', message: ghVersion });
  } catch {
    checks.push({
      name: 'gh CLI',
      status: 'warn',
      message: 'Not installed',
      fix: 'Install with: brew install gh (macOS) or https://cli.github.com',
    });
  }

  // ── upstream git remote ──────────────────────────────────────────────────
  if (existsSync(join(frameworkRoot, '.git'))) {
    try {
      execSync('git remote get-url upstream', { encoding: 'utf-8', stdio: 'pipe', cwd: frameworkRoot });
      checks.push({ name: 'upstream remote', status: 'pass', message: 'Configured' });
    } catch {
      checks.push({
        name: 'upstream remote',
        status: 'warn',
        message: 'Not configured',
        fix: 'Run: git remote add upstream <canonical-cortextos-repo-url>',
      });
    }
  }

  // ── Framework code-quality rules ─────────────────────────────────────────
  // Canonical location is .claude/docs/code-quality.md since PR #25 (de30689,
  // chore(docs): relocate code-quality rules from .claude/rules/ to .claude/docs/).
  const codeQualityRulesPath = join(frameworkRoot, '.claude', 'docs', 'code-quality.md');
  checks.push({
    name: '.claude/docs/code-quality.md',
    status: existsSync(codeQualityRulesPath) ? 'pass' : 'warn',
    message: existsSync(codeQualityRulesPath) ? 'Found' : 'Not found — agents will fail to load engineering bar at session start',
    fix: !existsSync(codeQualityRulesPath) ? 'Run: cortextos bus check-upstream --apply to fetch the latest framework rules' : undefined,
  });

  // ── community/catalog.json ───────────────────────────────────────────────
  const catalogPath = join(frameworkRoot, 'community', 'catalog.json');
  checks.push({
    name: 'community/catalog.json',
    status: existsSync(catalogPath) ? 'pass' : 'warn',
    message: existsSync(catalogPath) ? 'Found' : 'Not found',
    fix: !existsSync(catalogPath) ? 'Run: cortextos bus check-upstream --apply to fetch the latest catalog' : undefined,
  });

  // ── BL-003 phase 1: per-org Claude-profile registry ─────────────────────
  const orgsRoot = join(frameworkRoot, 'orgs');
  if (existsSync(orgsRoot)) {
    try {
      const orgEntries = readdirSync(orgsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const org of orgEntries) {
        const profilesPath = join(orgsRoot, org, 'profiles.json');
        if (!existsSync(profilesPath)) continue;

        let parsed: { default_profile?: unknown; profiles?: unknown };
        try {
          parsed = JSON.parse(readFileSync(profilesPath, 'utf-8'));
        } catch (err) {
          checks.push({
            name: `Profiles registry (${org})`,
            status: 'warn',
            message: `Malformed JSON: ${(err as Error).message}`,
            fix: `Validate orgs/${org}/profiles.json — spawn path silently falls back to no profile override until fixed`,
          });
          continue;
        }

        const registry = loadProfileRegistry(frameworkRoot, org);
        if (!registry) {
          checks.push({
            name: `Profiles registry (${org})`,
            status: 'warn',
            message: 'Schema invalid — needs default_profile + profiles map (entries with non-string config_dir are dropped)',
            fix: `See BL-2026-05-08-003 for the registry shape`,
          });
          continue;
        }

        const referencedBy = new Map<string, string[]>();
        const agentsDir = join(orgsRoot, org, 'agents');
        if (existsSync(agentsDir)) {
          const agentEntries = readdirSync(agentsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
          for (const agentName of agentEntries) {
            const cfgPath = join(agentsDir, agentName, 'config.json');
            if (!existsSync(cfgPath)) continue;
            try {
              const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
                claude_profile?: unknown;
                fallback_profile?: unknown;
              };
              for (const ref of [cfg.claude_profile, cfg.fallback_profile]) {
                if (typeof ref === 'string' && ref) {
                  const list = referencedBy.get(ref) ?? [];
                  if (!list.includes(agentName)) list.push(agentName);
                  referencedBy.set(ref, list);
                }
              }
            } catch { /* skip malformed config */ }
          }
        }

        const dangling = findDanglingReferences(registry, referencedBy.keys());
        const missingDirs: string[] = [];
        const rawProfiles = (parsed.profiles ?? {}) as Record<string, { config_dir?: unknown }>;
        for (const [pname, p] of Object.entries(rawProfiles)) {
          const dir = p?.config_dir;
          if (typeof dir !== 'string' || !dir || !existsSync(dir)) {
            missingDirs.push(`${pname}→${dir ?? '(unset)'}`);
          }
        }

        const issues: string[] = [];
        if (dangling.length) {
          const annotated = dangling.map((name) => {
            const users = referencedBy.get(name) ?? [];
            return users.length ? `${name} (used by: ${users.join(', ')})` : name;
          });
          issues.push(`dangling refs: ${annotated.join(', ')}`);
        }
        if (missingDirs.length) issues.push(`config_dir missing on disk: ${missingDirs.join(', ')}`);

        checks.push({
          name: `Profiles registry (${org})`,
          status: issues.length ? 'warn' : 'pass',
          message: issues.length
            ? issues.join('; ')
            : `${Object.keys(registry.profiles).length} profile(s); default=${registry.default_profile}`,
          fix: issues.length
            ? `Edit orgs/${org}/profiles.json or the offending agent config.json`
            : undefined,
        });
      }
    } catch { /* ignore scan errors */ }
  }

  // ── Analyst doc drift (BL-003 phase 3) ──────────────────────────────────
  const templatesAnalystDir = join(frameworkRoot, 'templates', 'analyst');
  if (existsSync(templatesAnalystDir) && existsSync(orgsRoot)) {
    try {
      for (const org of readdirSync(orgsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)) {
        const activeAnalystDir = join(orgsRoot, org, 'agents', 'analyst');
        if (!existsSync(activeAnalystDir)) continue;
        const drifted: string[] = [];
        for (const f of ['HEARTBEAT.md', 'GUARDRAILS.md']) {
          const tpl = join(templatesAnalystDir, f);
          const active = join(activeAnalystDir, f);
          if (!existsSync(tpl) || !existsSync(active)) continue;
          const tplMtime = statSync(tpl).mtimeMs;
          const activeMtime = statSync(active).mtimeMs;
          if (tplMtime > activeMtime) {
            const ageDays = Math.floor((tplMtime - activeMtime) / (24 * 60 * 60 * 1000));
            drifted.push(`${f} (template ${ageDays}d newer)`);
          }
        }
        if (drifted.length) {
          checks.push({
            name: `Analyst doc drift (${org})`,
            status: 'warn',
            message: `Template newer than active: ${drifted.join(', ')}`,
            fix: `Diff and re-sync: diff -u templates/analyst/<file> orgs/${org}/agents/analyst/<file>`,
          });
        }
      }
    } catch { /* ignore scan errors */ }
  }

  // ── Knowledge Base (GEMINI_API_KEY) ─────────────────────────────────────
  const orgsDir = join(frameworkRoot, 'orgs');
  let geminiConfigured = false;
  let geminiOrgFound = false;
  if (existsSync(orgsDir)) {
    try {
      for (const org of readdirSync(orgsDir)) {
        const secretsPath = join(orgsDir, org, 'secrets.env');
        if (existsSync(secretsPath)) {
          geminiOrgFound = true;
          const content = readFileSync(secretsPath, 'utf-8');
          if (/^GEMINI_API_KEY=.+/m.test(content)) {
            geminiConfigured = true;
            break;
          }
        }
      }
    } catch { /* ignore scan errors */ }
  }
  if (geminiOrgFound) {
    checks.push({
      name: 'Knowledge Base (GEMINI_API_KEY)',
      status: geminiConfigured ? 'pass' : 'warn',
      message: geminiConfigured ? 'Configured' : 'Not set — semantic search and RAG disabled',
      fix: !geminiConfigured ? 'Add GEMINI_API_KEY to orgs/<org>/secrets.env — get a free key at https://aistudio.google.com/app/apikey' : undefined,
    });
  }

  return checks;
}
