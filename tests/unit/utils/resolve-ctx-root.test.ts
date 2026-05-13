/**
 * tests/unit/utils/resolve-ctx-root.test.ts
 *
 * Regression coverage for `resolveCtxRoot()` — the helper that replaced the
 * silent `process.env.CTX_ROOT ?? process.cwd()` fallback that caused state
 * files (crons.json, cron-execution.log, hooks.log) to leak into the user's
 * current working directory when CLI commands were run from a repo dir
 * without CTX_ROOT in the environment.
 *
 * The leak surfaced 2026-05-14 when `cortextos bus add-cron analyst session-refresh`
 * silently wrote to `./.cortextOS/state/agents/analyst/crons.json` (a useless
 * shadow no daemon reads from) instead of `~/.cortextos/default/.cortextOS/...`
 * (where the daemon actually reads from).
 *
 * The test verifies:
 *   1. CTX_ROOT env var wins when present
 *   2. CTX_INSTANCE_ID changes the homedir fallback subdir
 *   3. Fallback ignores cwd entirely — this is the regression guard
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { resolveCtxRoot } from '../../../src/utils/env';

describe('resolveCtxRoot', () => {
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalInstance = process.env.CTX_INSTANCE_ID;
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.CTX_ROOT;
    delete process.env.CTX_INSTANCE_ID;
  });

  afterEach(() => {
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;
    if (originalInstance === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalInstance;
    // Best-effort: restore cwd even if a test changed it (none do here)
    try { process.chdir(originalCwd); } catch { /* ignore */ }
  });

  it('honours CTX_ROOT env var when set', () => {
    process.env.CTX_ROOT = '/tmp/some-explicit-root';
    expect(resolveCtxRoot()).toBe('/tmp/some-explicit-root');
  });

  it('falls back to ~/.cortextos/default when nothing is set', () => {
    expect(resolveCtxRoot()).toBe(join(homedir(), '.cortextos', 'default'));
  });

  it('honours CTX_INSTANCE_ID for the homedir fallback subdir', () => {
    process.env.CTX_INSTANCE_ID = 'staging';
    expect(resolveCtxRoot()).toBe(join(homedir(), '.cortextos', 'staging'));
  });

  it('NEVER falls back to process.cwd() — regression guard for the shadow-write bug', () => {
    // This is the load-bearing assertion. If anyone reintroduces a
    // `process.cwd()` fallback in env.ts, this test fails and prevents the
    // silent state-file leak described in the file header.
    const resolved = resolveCtxRoot();
    expect(resolved).not.toBe(process.cwd());
    expect(resolved.startsWith(process.cwd())).toBe(false);
  });

  it('CTX_ROOT takes priority over CTX_INSTANCE_ID', () => {
    process.env.CTX_ROOT = '/explicit/wins';
    process.env.CTX_INSTANCE_ID = 'ignored-when-ctx-root-set';
    expect(resolveCtxRoot()).toBe('/explicit/wins');
  });
});
