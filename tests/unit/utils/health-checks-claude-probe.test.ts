/**
 * Doctor-cron false-positive fix — Claude CLI retry+backoff.
 *
 * Spawning `claude --version` can transiently fail under load (fork/exec
 * contention while parallel claude sessions are starting up). A single missed
 * probe should NOT page Saurav via the pass→fail doctor-cron transition.
 *
 * runAllChecks must retry the probe a few times before declaring `fail`.
 * Each test mocks child_process.execSync at the file level (vi.mock is
 * hoisted, so we cannot share this file with the broader health-checks tests
 * which need the real execSync for PM2 / cloudflared / gh probes).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

import { runAllChecks } from '../../../src/utils/health-checks';

let frameworkRoot: string;

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-claude-probe-'));
  execSyncMock.mockReset();
});

afterEach(() => {
  rmSync(frameworkRoot, { recursive: true, force: true });
});

function isClaudeVersionCall(args: unknown[]): boolean {
  return typeof args[0] === 'string' && args[0] === 'claude --version';
}

describe('runAllChecks — Claude CLI retry (doctor-cron false-positive fix)', () => {
  it('passes when the first probe attempt succeeds', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'claude --version') return '1.2.3\n';
      throw new Error('not mocked');
    });

    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const cli = checks.find((c) => c.name === 'Claude Code CLI');
    expect(cli).toBeDefined();
    expect(cli!.status).toBe('pass');
    expect(cli!.message).toBe('1.2.3');
  });

  it('passes when the probe fails twice then succeeds (transient load)', async () => {
    let claudeCalls = 0;
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'claude --version') {
        claudeCalls++;
        if (claudeCalls < 3) throw new Error('EAGAIN: resource temporarily unavailable');
        return '1.2.3\n';
      }
      throw new Error('not mocked');
    });

    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const cli = checks.find((c) => c.name === 'Claude Code CLI');
    expect(cli).toBeDefined();
    expect(cli!.status).toBe('pass');
    expect(claudeCalls).toBe(3);
  });

  it('fails after all 3 attempts exhaust', async () => {
    let claudeCalls = 0;
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'claude --version') {
        claudeCalls++;
        throw new Error('ENOENT: claude not found');
      }
      throw new Error('not mocked');
    });

    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const cli = checks.find((c) => c.name === 'Claude Code CLI');
    expect(cli).toBeDefined();
    expect(cli!.status).toBe('fail');
    expect(claudeCalls).toBe(3);
    // Auth check shares the same probe — should not call claude --version again.
    const auth = checks.find((c) => c.name === 'Claude Code auth');
    expect(auth).toBeDefined();
    expect(auth!.status).toBe('warn');
  });
});
