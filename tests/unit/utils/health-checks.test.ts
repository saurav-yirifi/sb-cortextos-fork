/**
 * Fleet-resilience plan #4 — health-check registry.
 *
 * Verifies the extraction from src/cli/doctor.ts preserves the contract:
 *   - runAllChecks returns a non-empty Check[] array
 *   - every check has a name, status (pass|warn|fail), and message
 *   - canonical check names from the pre-extraction inline list still appear
 *
 * We deliberately do NOT snapshot the full array because system-state-dependent
 * checks (PM2 installed? Claude auth? cloudflared cert present?) vary
 * across CI hosts. Instead we assert the *names* of the checks that should
 * always be present and validate the schema of every returned entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runAllChecks,
  interpretLaunchctlList,
  assessSelfHealer,
  SELF_HEALER_SPECS,
  type SelfHealerSpec,
} from '../../../src/utils/health-checks';

let frameworkRoot: string;

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-health-checks-'));
});

afterEach(() => {
  rmSync(frameworkRoot, { recursive: true, force: true });
});

describe('runAllChecks (fleet-resilience #4 extraction)', () => {
  it('returns a non-empty array of Check entries', async () => {
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    expect(checks.length).toBeGreaterThan(0);
  });

  it('every returned Check satisfies the schema', async () => {
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    for (const c of checks) {
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
      expect(['pass', 'warn', 'fail']).toContain(c.status);
      expect(typeof c.message).toBe('string');
      if (c.fix !== undefined) expect(typeof c.fix).toBe('string');
    }
  });

  it('includes the canonical foundation checks (Node, node-pty, state dir)', async () => {
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const names = checks.map((c) => c.name);
    expect(names).toContain('Node.js version');
    expect(names).toContain('node-pty');
    expect(names).toContain('State directory');
    // Claude Code CLI is always probed (pass or fail).
    expect(names).toContain('Claude Code CLI');
  });

  it('Node.js version check reports pass on a supported runtime', async () => {
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const nodeCheck = checks.find((c) => c.name === 'Node.js version');
    expect(nodeCheck).toBeDefined();
    // This test runs on the project's own Node which is ≥20 (enforced in CI).
    expect(nodeCheck!.status).toBe('pass');
  });

  it('detects a malformed orgs/<org>/profiles.json and emits a warn', async () => {
    const orgDir = join(frameworkRoot, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'profiles.json'), '{not valid json');
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const profCheck = checks.find((c) => c.name === 'Profiles registry (acme)');
    expect(profCheck).toBeDefined();
    expect(profCheck!.status).toBe('warn');
    expect(profCheck!.message.toLowerCase()).toContain('malformed');
  });

  it('finds .claude/docs/code-quality.md at the post-PR-#25 path (not the stale .claude/rules/)', async () => {
    const docsDir = join(frameworkRoot, '.claude', 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'code-quality.md'), '# code-quality');
    // Also populate the stale location to confirm the check ignores it.
    const stale = join(frameworkRoot, '.claude', 'rules');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'code-quality.md'), '# stale');

    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const cq = checks.find((c) => c.name === '.claude/docs/code-quality.md');
    expect(cq).toBeDefined();
    expect(cq!.status).toBe('pass');
    // Stale name must NOT appear — would carry forward as undefined in the
    // doctor-cron snapshot and confuse operators reading the alert.
    expect(checks.find((c) => c.name === '.claude/rules/code-quality.md')).toBeUndefined();
  });

  it('warns on .claude/docs/code-quality.md absence (even if stale .claude/rules/ path is populated)', async () => {
    const stale = join(frameworkRoot, '.claude', 'rules');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'code-quality.md'), '# stale');

    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const cq = checks.find((c) => c.name === '.claude/docs/code-quality.md');
    expect(cq).toBeDefined();
    expect(cq!.status).toBe('warn');
    expect(cq!.message).toContain('Not found');
  });

  // ── 2026-05-16 post-mortem Finding 3 follow-up — meta-watchdog tests ──
  // These exercise the assessSelfHealer helper directly via injection so the
  // test does not need real launchctl / filesystem state. The runAllChecks
  // integration that pushes these checks is exercised by the smoke test
  // above (every Check satisfies the schema).

  it('flags analyst doc drift when templates/<file>.md is newer than active', async () => {
    const tpl = join(frameworkRoot, 'templates', 'analyst');
    const active = join(frameworkRoot, 'orgs', 'acme', 'agents', 'analyst');
    mkdirSync(tpl, { recursive: true });
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, 'HEARTBEAT.md'), 'old');
    writeFileSync(join(active, 'GUARDRAILS.md'), 'old');
    // Sleep-equivalent: write template files after the active ones so mtimes differ.
    // statSync resolution is millisecond, so this is reliable.
    const future = Date.now() + 5000;
    writeFileSync(join(tpl, 'HEARTBEAT.md'), 'new');
    writeFileSync(join(tpl, 'GUARDRAILS.md'), 'new');
    // Set mtime explicitly to guarantee ordering across fast filesystems.
    const { utimesSync } = await import('fs');
    utimesSync(join(tpl, 'HEARTBEAT.md'), new Date(future), new Date(future));
    utimesSync(join(tpl, 'GUARDRAILS.md'), new Date(future), new Date(future));
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const drift = checks.find((c) => c.name === 'Analyst doc drift (acme)');
    expect(drift).toBeDefined();
    expect(drift!.status).toBe('warn');
    expect(drift!.message).toContain('HEARTBEAT.md');
    expect(drift!.message).toContain('GUARDRAILS.md');
  });
});

describe('interpretLaunchctlList', () => {
  it('returns registered=false when launchctl list itself failed', () => {
    expect(interpretLaunchctlList('', 1))
      .toEqual({ registered: false, lastExitCode: null, lastSignal: null });
  });

  it('returns registered=true + lastExitCode=null when LastExitStatus is absent (never ran)', () => {
    const stdout = `{
\t"Label" = "com.cortextos.watchdog";
\t"OnDemand" = true;
};`;
    expect(interpretLaunchctlList(stdout, 0))
      .toEqual({ registered: true, lastExitCode: null, lastSignal: null });
  });

  it('decodes EX_CONFIG (78) from the wait-status word 19968', () => {
    // 19968 = 78 << 8. This is the exact signature observed on Saurav's
    // machine in the 2026-05-16 post-mortem.
    const stdout = `{\n\t"LastExitStatus" = 19968;\n};`;
    expect(interpretLaunchctlList(stdout, 0))
      .toEqual({ registered: true, lastExitCode: 78, lastSignal: null });
  });

  it('decodes a clean exit (0) when wait-status word is 0', () => {
    expect(interpretLaunchctlList(`{ "LastExitStatus" = 0; };`, 0))
      .toEqual({ registered: true, lastExitCode: 0, lastSignal: null });
  });

  it('decodes exit code 1 from raw wait-status 256', () => {
    expect(interpretLaunchctlList(`{ "LastExitStatus" = 256; };`, 0))
      .toEqual({ registered: true, lastExitCode: 1, lastSignal: null });
  });

  it('surfaces signal kill (SIGKILL=9) as lastSignal, NOT as exit 0', () => {
    // Regression: an earlier decoder did (raw >> 8) & 0xff unconditionally,
    // so SIGKILL (raw=9) decoded to exit code 0 and the assessor returned
    // pass — a killed self-healer silently appeared healthy. The split
    // signal/exit-code surface prevents that.
    expect(interpretLaunchctlList(`{ "LastExitStatus" = 9; };`, 0))
      .toEqual({ registered: true, lastExitCode: null, lastSignal: 9 });
  });
});

describe('assessSelfHealer', () => {
  const watchdog: SelfHealerSpec = SELF_HEALER_SPECS[0];
  const fakeCtxRoot = '/tmp/fake-ctxroot';

  it('returns warn when service is not registered with launchd', () => {
    const result = assessSelfHealer({
      spec: watchdog,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: '', status: 1 }),
    });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Not registered');
    expect(result.fix).toContain('cortextos install');
  });

  it('returns fail with explicit EX_CONFIG message on exit 78 (the post-mortem signature)', () => {
    const result = assessSelfHealer({
      spec: watchdog,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: `{ "LastExitStatus" = 19968; };`, status: 0 }),
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('78');
    expect(result.message).toContain('EX_CONFIG');
    expect(result.fix).toContain('PR-X2');
  });

  it('returns fail on any other non-zero last exit code', () => {
    const result = assessSelfHealer({
      spec: watchdog,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: `{ "LastExitStatus" = 256; };`, status: 0 }),
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('1');
  });

  it('returns warn when registered + clean exit but log file does not exist', () => {
    const result = assessSelfHealer({
      spec: watchdog,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: `{ "LastExitStatus" = 0; };`, status: 0 }),
      statSyncOverride: () => null,
    });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('does not exist');
  });

  it('returns warn when log is older than expectedIntervalSec × 3', () => {
    const nowMs = 1_700_000_000_000;
    // watchdog expectedIntervalSec=300 → threshold 900s. 1000s old = stale.
    const result = assessSelfHealer({
      spec: watchdog,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: `{ "LastExitStatus" = 0; };`, status: 0 }),
      statSyncOverride: () => ({ mtimeMs: nowMs - 1000 * 1000 }),
      nowMsOverride: nowMs,
    });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('stale');
  });

  it('returns pass when registered + clean exit + fresh log', () => {
    const nowMs = 1_700_000_000_000;
    const result = assessSelfHealer({
      spec: watchdog,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: `{ "LastExitStatus" = 0; };`, status: 0 }),
      statSyncOverride: () => ({ mtimeMs: nowMs - 60 * 1000 }),
      nowMsOverride: nowMs,
    });
    expect(result.status).toBe('pass');
    expect(result.message).toContain('Last cycle');
  });

  it('returns warn (does-not-exist branch) when service registered but never ran AND no log file', () => {
    // Realistic "never ran" state: no LastExitStatus + no log file. The
    // assessor falls through the non-zero-exit checks and hits the log
    // staleness branch, which sees null from statSyncOverride.
    const result = assessSelfHealer({
      spec: watchdog,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: `{ "Label" = "x"; };`, status: 0 }),
      statSyncOverride: () => null,
    });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('does not exist');
  });

  it('returns fail when last run was killed by signal (SIGKILL)', () => {
    const result = assessSelfHealer({
      spec: watchdog,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: `{ "LastExitStatus" = 9; };`, status: 0 }),
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('signal 9');
  });

  it('payload-cap-drift uses the 1.5× multiplier so a broken daily job surfaces inside 36h', () => {
    const dailyDrift = SELF_HEALER_SPECS.find((s) => s.name === 'payload-cap-drift')!;
    expect(dailyDrift.staleThresholdMultiplier).toBe(1.5);
    const nowMs = 1_700_000_000_000;
    // 86400 × 1.5 = 129600s = 36h threshold. 48h old should warn.
    const result = assessSelfHealer({
      spec: dailyDrift,
      ctxRoot: fakeCtxRoot,
      launchctlListOverride: () => ({ stdout: `{ "LastExitStatus" = 0; };`, status: 0 }),
      statSyncOverride: () => ({ mtimeMs: nowMs - 48 * 3600 * 1000 }),
      nowMsOverride: nowMs,
    });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('stale');
  });
});

describe('SELF_HEALER_SPECS', () => {
  it('contains exactly the 5 services from scripts/self-healing/', () => {
    expect(SELF_HEALER_SPECS.map((s) => s.name).sort()).toEqual([
      'agent-recover',
      'compact-boundary-watcher',
      'payload-cap-drift',
      'usage-monitor',
      'watchdog',
    ]);
  });

  it('every spec has a launchd label matching the com.cortextos.<name> convention', () => {
    for (const spec of SELF_HEALER_SPECS) {
      expect(spec.label).toBe(`com.cortextos.${spec.name}`);
    }
  });

  it('every spec has a positive expectedIntervalSec', () => {
    for (const spec of SELF_HEALER_SPECS) {
      expect(spec.expectedIntervalSec).toBeGreaterThan(0);
    }
  });
});
