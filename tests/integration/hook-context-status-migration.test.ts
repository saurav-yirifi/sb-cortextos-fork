/**
 * tests/integration/hook-context-status-migration.test.ts
 *
 * BL-2026-05-08-004 Phase 2c — drives the actual hook subprocess to assert:
 *  1. Phase 2 schema (`context-pct.json`) is written with severity.
 *  2. Legacy schema (`context_status.json`) is DELETED if present.
 *
 * The two-layer-context-cooperation test inlines the migration unlinkSync to
 * avoid subprocess overhead — but that leaves the hook's actual delete code
 * path (`src/hooks/hook-context-status.ts` lines 80-86) uncovered. This test
 * exercises that exact code path so the delete cannot silently regress.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'dist', 'cli.js');

interface RunResult { stdout: string; stderr: string; code: number; }

function runHook(stdinPayload: string, env: NodeJS.ProcessEnv): RunResult {
  const r = spawnSync('node', [CLI_ENTRY, 'bus', 'hook-context-status'], {
    input: stdinPayload,
    env,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status ?? 1 };
}

describe('hook-context-status (subprocess) migration coverage', () => {
  let tmpRoot: string;
  let fakeHome: string;
  let stateDir: string;

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`CLI entry missing at ${CLI_ENTRY}; run \`npm run build\` first.`);
    }
  });

  let ctxRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hook-ctx-mig-'));
    fakeHome = join(tmpRoot, 'home');
    // The hook prefers `process.env.CTX_ROOT` over `homedir()`, so we override
    // CTX_ROOT explicitly. Without this, an agent's pre-set CTX_ROOT in the
    // test runner's environment leaks through and the hook writes to the real
    // ~/.cortextos instead of the tmp dir.
    ctxRoot = join(fakeHome, '.cortextos', 'default');
    stateDir = join(ctxRoot, 'state', 'fullstack');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function hookEnv(extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: fakeHome,
      CTX_ROOT: ctxRoot,
      CTX_AGENT_NAME: 'fullstack',
      CTX_ORG: 'sb-personal',
      CTX_INSTANCE_ID: 'default',
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  function statusLinePayload(pct: number, limit = 1_000_000): string {
    return JSON.stringify({
      context_window: {
        used_percentage: pct,
        context_window_size: limit,
        current_usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: Math.floor((pct / 100) * limit) - 1 },
      },
      session_id: 'sess-mig',
      model: 'claude-opus-4-7',
    });
  }

  it('writes context-pct.json with Phase 2 schema fields', () => {
    const r = runHook(statusLinePayload(13), hookEnv());
    expect(r.code).toBe(0);

    const pctPath = join(stateDir, 'context-pct.json');
    expect(existsSync(pctPath)).toBe(true);
    const data = JSON.parse(readFileSync(pctPath, 'utf-8'));
    expect(data.agent).toBe('fullstack');
    expect(data.severity).toBe('green');
    expect(data.pct).toBeCloseTo(13, 1);
    expect(data.context_limit).toBe(1_000_000);
    expect(data.session_id).toBe('sess-mig');
    expect(data.transcript_path).toBe('statusline://current-session');
    expect(data.updated_at).toBeTruthy();
  });

  it('DELETES legacy context_status.json on hook fire (covers src/hooks/hook-context-status.ts:80-86)', () => {
    // Pre-condition: legacy file from a pre-Phase-2 deploy.
    const legacyPath = join(stateDir, 'context_status.json');
    writeFileSync(legacyPath, JSON.stringify({
      used_percentage: 73,
      exceeds_200k_tokens: false,
      written_at: new Date().toISOString(),
    }));
    expect(existsSync(legacyPath)).toBe(true);

    const r = runHook(statusLinePayload(30), hookEnv());
    expect(r.code).toBe(0);

    // Post-condition: legacy file gone, new schema file written.
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(stateDir, 'context-pct.json'))).toBe(true);
  });

  it('migration is idempotent — second hook fire still finds no legacy file and exits cleanly', () => {
    const legacyPath = join(stateDir, 'context_status.json');
    writeFileSync(legacyPath, JSON.stringify({ used_percentage: 50, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));

    // First fire: deletes legacy.
    const r1 = runHook(statusLinePayload(15), hookEnv());
    expect(r1.code).toBe(0);
    expect(existsSync(legacyPath)).toBe(false);

    // Second fire: no legacy to delete; should still exit 0 cleanly.
    const r2 = runHook(statusLinePayload(20), hookEnv());
    expect(r2.code).toBe(0);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(stateDir, 'context-pct.json'))).toBe(true);
  });

  it('hook exits 0 even when context_window block missing (fail-closed)', () => {
    const r = runHook(JSON.stringify({ session_id: 'sess', model: 'opus' }), hookEnv());
    expect(r.code).toBe(0);
    // No file written on missing data.
    expect(existsSync(join(stateDir, 'context-pct.json'))).toBe(false);
  });
});
