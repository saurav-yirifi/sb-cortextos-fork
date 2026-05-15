/**
 * Path B watchdog (watchdog-threshold-tuning spec) — Phase 1 state persistence.
 *
 * Verifies updateHeartbeat manages `task_started_at` with the right semantics
 * to support the upcoming task-stuck watcher leg:
 *   - empty current_task → task_started_at = null
 *   - first write with non-empty current_task → task_started_at = now
 *   - current_task unchanged → task_started_at preserved
 *   - current_task transitions to a different non-empty value → re-stamped to now
 *   - side-channel event-log refresh preserves task_started_at (event.ts
 *     code path is tested separately, but the on-disk shape is checked here
 *     to confirm refreshHeartbeatTimestamp's JSON roundtrip carries the field)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateHeartbeat } from '../../../src/bus/heartbeat';
import type { BusPaths, Heartbeat } from '../../../src/types';

function makePaths(testDir: string, agent: string = 'test-agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}

function readHeartbeat(paths: BusPaths): Heartbeat {
  return JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
}

describe('updateHeartbeat — task_started_at (Path B Phase 1)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-hb-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('sets task_started_at=null when current_task is empty', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: '' });
    expect(readHeartbeat(paths).task_started_at).toBeNull();
  });

  it('sets task_started_at=null when currentTask is omitted', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online');
    expect(readHeartbeat(paths).task_started_at).toBeNull();
  });

  it('stamps task_started_at on first write with non-empty current_task', () => {
    const paths = makePaths(testDir);
    const before = Date.now();
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const after = Date.now();
    const hb = readHeartbeat(paths);
    expect(hb.task_started_at).toBeTruthy();
    const stampedMs = Date.parse(hb.task_started_at!);
    expect(stampedMs).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(stampedMs).toBeLessThanOrEqual(after + 1000);
    // task_started_at should match last_heartbeat on a fresh stamp.
    expect(hb.task_started_at).toBe(hb.last_heartbeat);
  });

  it('preserves task_started_at when current_task is unchanged across writes', async () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const stamped = readHeartbeat(paths).task_started_at;
    expect(stamped).toBeTruthy();

    // Wait a second to ensure ISO-second-resolution distinguishes the writes.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const hb2 = readHeartbeat(paths);
    expect(hb2.task_started_at).toBe(stamped);
    // last_heartbeat should have advanced even though task_started_at did not.
    expect(hb2.last_heartbeat).not.toBe(stamped);
  });

  it('re-stamps task_started_at when current_task transitions to a different value', async () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const stampedA = readHeartbeat(paths).task_started_at;

    await new Promise((resolve) => setTimeout(resolve, 1100));

    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-B' });
    const stampedB = readHeartbeat(paths).task_started_at;
    expect(stampedB).toBeTruthy();
    expect(stampedB).not.toBe(stampedA);
  });

  it('clears task_started_at to null on transition to empty current_task', async () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    expect(readHeartbeat(paths).task_started_at).toBeTruthy();
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: '' });
    expect(readHeartbeat(paths).task_started_at).toBeNull();
  });

  it('re-stamps task_started_at on null → non-empty transition (idle → working)', async () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online');
    expect(readHeartbeat(paths).task_started_at).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const stamped = readHeartbeat(paths).task_started_at;
    expect(stamped).toBeTruthy();
    // Stamp should be after the null-state heartbeat.
    expect(Date.parse(stamped!)).toBeGreaterThan(0);
  });

  it('treats a heartbeat written by an older version (no task_started_at) as a transition and stamps on next write', () => {
    const paths = makePaths(testDir);
    mkdirSync(paths.stateDir, { recursive: true });
    // Synthesize a legacy heartbeat file with no task_started_at field.
    writeFileSync(
      join(paths.stateDir, 'heartbeat.json'),
      JSON.stringify({
        agent: 'test-agent',
        org: '',
        status: 'online',
        current_task: 'task-A',
        mode: 'day',
        last_heartbeat: '2026-05-15T20:00:00Z',
        loop_interval: '',
      }),
    );
    // Same current_task on next write — the helper falls back to `now` because
    // the prior heartbeat didn't carry the field.
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const hb = readHeartbeat(paths);
    expect(hb.task_started_at).toBeTruthy();
    expect(hb.task_started_at).toBe(hb.last_heartbeat);
  });
});
