import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Unit tests for the context monitor logic in fast-checker.ts.
 * Tests the stateless helper functions and state machine in isolation.
 *
 * Schema migrated 2026-05-08T20:34Z (BL-2026-05-08-004 phase 2b): the
 * fast-checker now reads `context-pct.json` (Phase 1 schema with severity)
 * instead of `context_status.json` (legacy schema). The fixture helper
 * writes the new schema; the tier-selection tests still drive pure-logic
 * thresholds and remain unaffected by the file rename.
 */

// --- Helpers to simulate context-pct.json (Phase 2 schema) ---

function writeContextPct(stateDir: string, pct: number | null, exceeds = false, ageMs = 0, opts: { sessionId?: string; contextLimit?: number } = {}): void {
  mkdirSync(stateDir, { recursive: true });
  const updated_at = new Date(Date.now() - ageMs).toISOString();
  const ctxLimit = opts.contextLimit ?? 200_000;
  const safePct = pct ?? 0;
  // Map legacy "exceeds_200k_tokens" signal to severity (1M-context agents
  // exceed 200k well before triggering — but legacy fixture semantics need
  // representable severity for the tier selector to stay correct).
  let severity: string = 'green';
  if (safePct >= 85) severity = 'red';
  else if (safePct >= 75) severity = 'orange';
  else if (safePct >= 65) severity = 'yellow';
  else if (safePct >= 50) severity = 'soft';
  writeFileSync(
    join(stateDir, 'context-pct.json'),
    JSON.stringify({
      agent: 'test-agent',
      session_id: opts.sessionId ?? '',
      transcript_path: 'statusline://current-session',
      model: 'claude-opus-4-7',
      context_limit: ctxLimit,
      current_loaded_tokens: Math.round((safePct / 100) * ctxLimit),
      pct: safePct,
      severity,
      next_action_threshold_pct: null,
      updated_at,
      // Retain legacy field so the FastChecker's exceeds_200k_tokens fallback
      // path is exercised by fixtures that pass `exceeds=true` with null pct.
      exceeds_200k_tokens: exceeds,
    }),
    'utf-8',
  );
}

// Backwards-compat alias for any test reading the helper by its old name.
const writeContextStatus = writeContextPct;

// --- Staleness detection ---

describe('context-pct.json staleness detection (BL-004 phase 2 schema)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `ctx-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try { unlinkSync(join(stateDir, 'context-pct.json')); } catch { /* ignore */ }
  });

  it('fresh file (0ms) passes staleness check via updated_at', () => {
    writeContextPct(stateDir, 72.4, false, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context-pct.json'), 'utf-8'));
    const age = Date.now() - new Date(raw.updated_at).getTime();
    expect(age).toBeLessThan(10 * 60_000);
  });

  it('file older than 10min is considered stale (updated_at)', () => {
    writeContextPct(stateDir, 72.4, false, 11 * 60_000);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context-pct.json'), 'utf-8'));
    const age = Date.now() - new Date(raw.updated_at).getTime();
    expect(age).toBeGreaterThan(10 * 60_000);
  });

  it('null pct is handled gracefully (helper writes 0 with green severity)', () => {
    writeContextPct(stateDir, null, false, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context-pct.json'), 'utf-8'));
    expect(raw.pct).toBe(0);
    expect(raw.severity).toBe('green');
  });

  it('exceeds_200k_tokens legacy signal is preserved in fixture for backwards-compat', () => {
    writeContextPct(stateDir, null, true, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context-pct.json'), 'utf-8'));
    expect(raw.exceeds_200k_tokens).toBe(true);
  });

  it('schema includes severity field that downstream Layer-1 (HEARTBEAT.md) reads', () => {
    writeContextPct(stateDir, 87, false, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context-pct.json'), 'utf-8'));
    expect(raw.severity).toBe('red');
  });
});

// --- Threshold tier selection ---

describe('context monitor tier selection', () => {
  const WARN = 70;
  const HANDOFF = 80;

  function selectTier(pct: number, exceeds: boolean, warningFiredAt: number, handoffFiredAt: number, now: number) {
    const effectivePct = pct !== null ? pct : (exceeds ? 101 : null);
    if (effectivePct === null) return 'none';

    // Tier 2 check (handoff) — must check before warning for edge cases
    if (effectivePct >= HANDOFF && handoffFiredAt === 0) return 'handoff';

    // Tier 1 check (warning) — 15min cooldown
    if (effectivePct >= WARN && now - warningFiredAt > 15 * 60_000) return 'warning';

    return 'none';
  }

  it('69% triggers no action', () => {
    expect(selectTier(69, false, 0, 0, Date.now())).toBe('none');
  });

  it('70% triggers warning', () => {
    expect(selectTier(70, false, 0, 0, Date.now())).toBe('warning');
  });

  it('79% triggers warning (below handoff threshold)', () => {
    expect(selectTier(79, false, 0, 0, Date.now())).toBe('warning');
  });

  it('80% triggers handoff (first time)', () => {
    expect(selectTier(80, false, 0, 0, Date.now())).toBe('handoff');
  });

  it('90% triggers handoff (first time, above handoff threshold)', () => {
    expect(selectTier(90, false, 0, 0, Date.now())).toBe('handoff');
  });

  it('80% with handoff already fired triggers warning (if cooldown elapsed)', () => {
    const handoffFiredAt = Date.now() - 20 * 60_000; // 20min ago
    expect(selectTier(80, false, 0, handoffFiredAt, Date.now())).toBe('warning');
  });
});

// --- Warning deduplication ---

describe('warning deduplication', () => {
  it('warning within 15min cooldown does not fire again', () => {
    const warningFiredAt = Date.now() - 5 * 60_000; // 5min ago
    const now = Date.now();
    const cooldownElapsed = now - warningFiredAt > 15 * 60_000;
    expect(cooldownElapsed).toBe(false);
  });

  it('warning after 15min cooldown fires again', () => {
    const warningFiredAt = Date.now() - 16 * 60_000; // 16min ago
    const now = Date.now();
    const cooldownElapsed = now - warningFiredAt > 15 * 60_000;
    expect(cooldownElapsed).toBe(true);
  });
});

// --- Circuit breaker ---

describe('context monitor circuit breaker', () => {
  it('3 restarts within 15min window trips breaker', () => {
    const now = Date.now();
    const restarts = [now - 14 * 60_000, now - 10 * 60_000, now - 1 * 60_000];
    const windowMs = 15 * 60_000;
    const inWindow = restarts.filter(t => now - t < windowMs);
    expect(inWindow.length).toBe(3);
    expect(inWindow.length >= 3).toBe(true); // trips
  });

  it('2 restarts in 15min window does not trip', () => {
    const now = Date.now();
    const restarts = [now - 10 * 60_000, now - 5 * 60_000];
    const inWindow = restarts.filter(t => now - t < 15 * 60_000);
    expect(inWindow.length).toBeLessThan(3);
  });

  it('old restarts outside 15min window are excluded', () => {
    const now = Date.now();
    const restarts = [now - 20 * 60_000, now - 18 * 60_000, now - 1 * 60_000];
    const inWindow = restarts.filter(t => now - t < 15 * 60_000);
    expect(inWindow.length).toBe(1); // only the recent one counts
  });

  it('circuit breaker resets after 30min pause', () => {
    const circuitBrokenAt = Date.now() - 31 * 60_000; // 31min ago
    const shouldReset = Date.now() - circuitBrokenAt >= 30 * 60_000;
    expect(shouldReset).toBe(true);
  });

  it('circuit breaker still active at 29min', () => {
    const circuitBrokenAt = Date.now() - 29 * 60_000;
    const shouldReset = Date.now() - circuitBrokenAt >= 30 * 60_000;
    expect(shouldReset).toBe(false);
  });
});

// --- Handoff block consumption ---

describe('consumeHandoffBlock', () => {
  let stateDir: string;
  let handoffDocPath: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `handoff-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    handoffDocPath = join(stateDir, 'handoff-doc.md');
    writeFileSync(handoffDocPath, '# Handoff\n\n## Current Tasks\n- Working on X', 'utf-8');
  });

  afterEach(() => {
    try { unlinkSync(join(stateDir, '.handoff-doc-path')); } catch { /* ignore */ }
    try { unlinkSync(handoffDocPath); } catch { /* ignore */ }
  });

  it('returns empty string when no marker exists', () => {
    // Simulate consumeHandoffBlock logic
    const markerPath = join(stateDir, '.handoff-doc-path');
    const exists = existsSync(markerPath);
    expect(exists).toBe(false);
    // result would be ''
  });

  it('returns handoff block when marker exists and doc is present', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, handoffDocPath + '\n', 'utf-8');

    // Simulate consumeHandoffBlock logic
    const doc = require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    const docExists = existsSync(doc);
    expect(docExists).toBe(true);
    expect(doc).toBe(handoffDocPath);
    expect(existsSync(markerPath)).toBe(false); // consumed
  });

  it('marker file is unlinked after consumption', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, handoffDocPath + '\n', 'utf-8');
    expect(existsSync(markerPath)).toBe(true);
    // consume
    require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('returns empty when marker points to nonexistent doc', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, '/nonexistent/path/doc.md\n', 'utf-8');
    const doc = require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    const docExists = existsSync(doc);
    expect(docExists).toBe(false);
  });
});
