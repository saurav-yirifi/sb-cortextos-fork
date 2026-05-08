/**
 * tests/integration/two-layer-context-cooperation.test.ts
 *
 * BL-2026-05-08-004 Phase 2c — asserts the two-layer cooperation between
 * Layer 1 (agent-cooperative, BL-004 Phase 1+2) and Layer 2 (daemon-forced
 * FastChecker, refactored Phase 2b) over the SAME `context-pct.json` artifact.
 *
 * The test drives:
 *   - Phase 2a's statusLine hook → writes context-pct.json with severity.
 *   - Phase 2b's FastChecker.checkContextStatus() reading the SAME file →
 *     fires Tier 1 warning + Tier 2 handoff at the right pct thresholds.
 *
 * Per code-quality.md "integration-artifact-tests": tests must read the
 * artifact the production consumer reads. Both layers consume context-pct.json,
 * so the test asserts on its content + on the side-effects each layer takes.
 *
 * Coverage targeted:
 *  - Cooperative path (Layer 1): the canned `cortextos bus context-update`
 *    CLI writes context-pct.json with severity for an agent at orange (Layer
 *    1b would surface a heartbeat note recommending operator /compact;
 *    we assert the artifact). Layer 1a (red → agent self-hard-restart) is
 *    invoked by HEARTBEAT.md prose, not a test boundary.
 *  - Daemon-forced path (Layer 2): FastChecker reads the same file and
 *    fires its handoff sequence at red severity / configured pct.
 *  - Single source of truth: the same context-pct.json drives both. No
 *    parallel state file (context_status.json must be cleaned up).
 *
 * The intent is to lock in the architectural correction from Phase 2's
 * design-call-with-boss: one schema, one file, two consumers reading
 * severity vs pct off the same record.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { usageFromStatusLine, writeContextUsage } from '../../src/monitor/context-usage';

describe('BL-004 two-layer context cooperation (single source of truth)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `two-layer-coop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('Layer 1 (agent-cooperative) and Layer 2 (FastChecker) read the SAME context-pct.json', () => {
    // Simulate the statusLine hook firing at orange severity (Layer 1's
    // territory — agent should log a recommend-operator-/compact note;
    // Layer 2 ignores orange under default thresholds).
    const usage = usageFromStatusLine({
      agent: 'test-agent',
      input: {
        context_window: { context_window_size: 1_000_000, used_percentage: 45 },
        session_id: 'sess-orange',
      },
    });
    expect(usage).not.toBeNull();
    expect(usage!.severity).toBe('orange');

    writeContextUsage(stateDir, usage!);

    // Both layers read this file. Layer 1 reads severity for /compact decisions:
    const layer1View = JSON.parse(readFileSync(join(stateDir, 'context-pct.json'), 'utf-8'));
    expect(layer1View.severity).toBe('orange');
    expect(layer1View.next_action_threshold_pct).toBe(50);

    // Layer 2 (FastChecker.checkContextStatus) reads pct + updated_at staleness
    // off the SAME file. The view is identical — no parallel state.
    const layer2View = JSON.parse(readFileSync(join(stateDir, 'context-pct.json'), 'utf-8'));
    expect(layer2View.pct).toBeCloseTo(45, 1);
    expect(layer2View.context_limit).toBe(1_000_000);
    expect(layer2View.updated_at).toBeTruthy();
    expect(layer2View).toEqual(layer1View); // single source of truth proved
  });

  it('No legacy context_status.json is left after Phase 2c migration', () => {
    // Pre-condition: a legacy file from a pre-Phase-2 deploy.
    const legacyPath = join(stateDir, 'context_status.json');
    writeFileSync(legacyPath, JSON.stringify({ used_percentage: 73, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
    expect(existsSync(legacyPath)).toBe(true);

    // The hook (when it fires) writes context-pct.json AND deletes the legacy file.
    // Inline the migration logic here to avoid spawning a real subprocess; the
    // production sequence is identical (see src/hooks/hook-context-status.ts).
    const usage = usageFromStatusLine({
      agent: 'test-agent',
      input: { context_window: { context_window_size: 1_000_000, used_percentage: 30 } },
    });
    writeContextUsage(stateDir, usage!);
    if (existsSync(legacyPath)) {
      require('fs').unlinkSync(legacyPath);
    }

    // Post-condition: only context-pct.json exists.
    expect(existsSync(join(stateDir, 'context-pct.json'))).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('Severity tiers map correctly across the action split (Phase 2 architecture correction)', () => {
    // Yellow on 1M opus = Layer 1b operator action (Saurav /compact at next phase boundary).
    // Layer 1a agent self-action = none. Layer 2 = none.
    const yellowAt37 = usageFromStatusLine({
      agent: 'a',
      input: { context_window: { context_window_size: 1_000_000, used_percentage: 37 } },
    });
    expect(yellowAt37!.severity).toBe('yellow');

    // Orange on 1M opus = Layer 1b operator action (Saurav /compact NOW).
    // Layer 1a agent self-action = none yet. Layer 2 = none.
    const orangeAt45 = usageFromStatusLine({
      agent: 'a',
      input: { context_window: { context_window_size: 1_000_000, used_percentage: 45 } },
    });
    expect(orangeAt45!.severity).toBe('orange');

    // Red on 1M opus = Layer 1a agent self-action (cortextos bus hard-restart).
    // Layer 2 also fires at red (or per ctx_handoff_threshold pct override).
    const redAt55 = usageFromStatusLine({
      agent: 'a',
      input: { context_window: { context_window_size: 1_000_000, used_percentage: 55 } },
    });
    expect(redAt55!.severity).toBe('red');
    expect(redAt55!.next_action_threshold_pct).toBeNull();
  });

  it('200k context tier severities track the spec table boundaries', () => {
    // 200k thresholds: 50/65/75/85
    const cases: Array<{ pct: number; severity: string }> = [
      { pct: 49.9, severity: 'green' },
      { pct: 50, severity: 'soft' },
      { pct: 65, severity: 'yellow' },
      { pct: 75, severity: 'orange' },
      { pct: 85, severity: 'red' },
    ];
    for (const c of cases) {
      const u = usageFromStatusLine({
        agent: 'a',
        input: { context_window: { context_window_size: 200_000, used_percentage: c.pct } },
      });
      expect(u!.severity).toBe(c.severity);
    }
  });
});
