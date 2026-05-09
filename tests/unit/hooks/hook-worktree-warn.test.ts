import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { isUnderCanonical, buildWarningMessage } from '../../../src/hooks/hook-worktree-warn';

const CANONICAL = '/Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork';
const CANONICAL_JARVIS = '/Volumes/MacStorage/UserData/0devprojects/sb-claude-jarvis';

describe('isUnderCanonical', () => {
  it('matches exact canonical cortextos-fork path', () => {
    expect(isUnderCanonical(CANONICAL)).toBe(true);
  });

  it('matches exact canonical jarvis path', () => {
    expect(isUnderCanonical(CANONICAL_JARVIS)).toBe(true);
  });

  it('matches a subdirectory of canonical', () => {
    expect(isUnderCanonical(`${CANONICAL}/orgs/sb-personal/agents/fullstack`)).toBe(true);
    expect(isUnderCanonical(`${CANONICAL}/src/hooks`)).toBe(true);
  });

  it('matches deep subdirectory', () => {
    expect(isUnderCanonical(`${CANONICAL}/templates/agent/.claude/skills/onboarding`)).toBe(true);
  });

  it('does NOT match a worktree path', () => {
    expect(isUnderCanonical('/Users/sauravb/cortextos-worktrees/fullstack/feat-x')).toBe(false);
    expect(isUnderCanonical('/Users/sauravb/jarvis-worktrees/engineer/feat-y')).toBe(false);
  });

  it('does NOT match a sibling path that shares a prefix', () => {
    // The trailing-slash discipline prevents `sb-cortextos-fork-other` from
    // matching `sb-cortextos-fork`. Critical for canonical-path detection.
    expect(isUnderCanonical(`${CANONICAL}-other`)).toBe(false);
    expect(isUnderCanonical(`${CANONICAL}-fork`)).toBe(false);
  });

  it('does NOT match an unrelated path', () => {
    expect(isUnderCanonical('/tmp/somewhere')).toBe(false);
    expect(isUnderCanonical('/Users/sauravb')).toBe(false);
    expect(isUnderCanonical('/')).toBe(false);
  });

  it('honors a custom canonical-paths list', () => {
    expect(isUnderCanonical('/foo/bar', ['/foo'])).toBe(true);
    expect(isUnderCanonical('/baz', ['/foo'])).toBe(false);
  });
});

describe('buildWarningMessage', () => {
  it('includes the agent name in the worktree-add command', () => {
    const msg = buildWarningMessage('engineer', `${CANONICAL}/orgs`);
    expect(msg).toContain('git worktree add ~/cortextos-worktrees/engineer/<branch>');
  });

  it('includes the cwd that triggered the warning', () => {
    const cwd = `${CANONICAL}/src/hooks`;
    const msg = buildWarningMessage('fullstack', cwd);
    expect(msg).toContain(cwd);
  });

  it('mentions the canonical path so the agent knows where to fetch from', () => {
    const msg = buildWarningMessage('analyst', CANONICAL);
    expect(msg).toContain(`cd ${CANONICAL}`);
  });

  it('points at the CLAUDE.md section so the agent can find the full workflow', () => {
    const msg = buildWarningMessage('boss', CANONICAL);
    expect(msg).toContain('Working tree (shared-repo discipline)');
  });
});

/**
 * End-to-end subprocess tests — drive the compiled CLI via
 * `cortextos bus hook-worktree-warn` exactly as Claude Code would.
 * Per the integration-artifact-tests discipline we read what the consumer
 * reads (stdout JSON for Claude Code; events JSONL for the activity feed).
 *
 * Pattern lifted from tests/integration/hook-context-status-migration.test.ts:
 * we override HOME so resolvePaths() reroutes its homedir()-derived paths
 * into a tmp dir. That's the only clean way to redirect logEvent's writes.
 */
describe('hook-worktree-warn end-to-end (CLI subprocess)', () => {
  const REPO_ROOT = resolve(__dirname, '..', '..', '..');
  const CLI_ENTRY = join(REPO_ROOT, 'dist', 'cli.js');

  let tmpRoot: string;
  let fakeHome: string;
  let ctxRoot: string;
  const agentName = 'test-agent';
  const org = 'test-org';
  const instanceId = 'default';

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`CLI entry missing at ${CLI_ENTRY}; run \`npm run build\` first.`);
    }
  });

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'worktree-warn-'));
    fakeHome = join(tmpRoot, 'home');
    ctxRoot = join(fakeHome, '.cortextos', instanceId);
    mkdirSync(join(ctxRoot, 'state', agentName), { recursive: true });
    mkdirSync(join(ctxRoot, 'orgs', org, 'analytics', 'events', agentName), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function runHook(opts: { cwd: string; setAgentName?: boolean }): {
    stdout: string;
    stderr: string;
    status: number | null;
  } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fakeHome,
      CTX_ROOT: ctxRoot,
      CTX_INSTANCE_ID: instanceId,
      CTX_ORG: org,
    };
    if (opts.setAgentName !== false) env.CTX_AGENT_NAME = agentName;
    else delete env.CTX_AGENT_NAME;
    const r = spawnSync('node', [CLI_ENTRY, 'bus', 'hook-worktree-warn'], {
      cwd: opts.cwd,
      env,
      input: '{}',
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      status: r.status,
    };
  }

  function readEventsLog(): string {
    const today = new Date().toISOString().split('T')[0];
    const p = join(ctxRoot, 'orgs', org, 'analytics', 'events', agentName, `${today}.jsonl`);
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  }

  it('emits hookSpecificOutput with additionalContext when cwd is canonical', () => {
    const result = runHook({ cwd: CANONICAL });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput?.additionalContext).toContain('BL-005 worktree warning');
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(
      `git worktree add ~/cortextos-worktrees/${agentName}/<branch>`,
    );
  });

  it('writes a worktree_canonical_boot_warning event on canonical match', () => {
    runHook({ cwd: CANONICAL });
    const log = readEventsLog();
    expect(log).toContain('worktree_canonical_boot_warning');
    const lines = log.split('\n').filter(Boolean);
    const event = lines.map((l) => JSON.parse(l)).find((e) => e.event === 'worktree_canonical_boot_warning');
    expect(event).toBeDefined();
    expect(event.severity).toBe('warning');
    expect(event.metadata?.cwd).toBeDefined();
    expect(event.metadata?.agent).toBe(agentName);
  });

  it('writes empty {} and no event when cwd is NOT canonical', () => {
    const result = runHook({ cwd: tmpRoot });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(readEventsLog()).toBe('');
  });

  it('exits 0 silently as a no-op when CTX_AGENT_NAME is unset', () => {
    const result = runHook({ cwd: CANONICAL, setAgentName: false });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(readEventsLog()).toBe('');
  });

  it('matches a deep canonical subdirectory', () => {
    // Use the framework root itself so the path is guaranteed to exist.
    // Any subdir of CANONICAL exercises the startsWith branch in
    // isUnderCanonical without depending on the test runner's cwd.
    const subdir = join(CANONICAL, 'src');
    const result = runHook({ cwd: subdir });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(subdir);
  });
});
