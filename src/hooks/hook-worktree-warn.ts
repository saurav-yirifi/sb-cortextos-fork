/**
 * SessionStart hook — warns if the agent has booted with cwd inside a
 * canonical shared working tree.
 *
 * BL-2026-05-08-005 convention: each agent works in
 *   ~/cortextos-worktrees/<agent>/<branch>
 * or
 *   ~/jarvis-worktrees/<agent>/<branch>
 * and never directly in
 *   /Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork
 *   /Volumes/MacStorage/UserData/0devprojects/sb-claude-jarvis
 *
 * Configured in settings.json as a SessionStart hook:
 *   "SessionStart": [
 *     { "hooks": [{ "type": "command",
 *                   "command": "cortextos bus hook-worktree-warn",
 *                   "timeout": 5 }] }
 *   ]
 *
 * Output:
 * - Always exits 0; a SessionStart hook failure must not block boot.
 * - On no match: writes `{}` to stdout (no additional context).
 * - On match: emits a `worktree_canonical_boot_warning` bus event AND
 *   writes hookSpecificOutput.additionalContext so the warning lands in
 *   the agent's session context immediately.
 */

import { realpathSync } from 'fs';

import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';
import { readStdin } from './index.js';

const CANONICAL_PATHS = [
  '/Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork',
  '/Volumes/MacStorage/UserData/0devprojects/sb-claude-jarvis',
];

/**
 * Resolve a path through symlinks. Returns input unchanged on failure.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * True when `cwd` is exactly one of the canonical roots OR is a descendant
 * of one. The trailing-slash check prevents false positives on
 * sibling paths that share a prefix (e.g. `/Volumes/.../sb-cortextos-fork-other`).
 */
export function isUnderCanonical(cwd: string, canonicalPaths: string[] = CANONICAL_PATHS): boolean {
  for (const canonical of canonicalPaths) {
    if (cwd === canonical || cwd.startsWith(canonical + '/')) return true;
  }
  return false;
}

/**
 * Build the warning text injected as additionalContext.
 */
export function buildWarningMessage(agentName: string, cwd: string): string {
  return [
    `[BL-005 worktree warning] You booted with cwd inside a shared canonical working tree:`,
    `  ${cwd}`,
    ``,
    `Branch operations there silently corrupt other agents' uncommitted state. Before any non-trivial`,
    `code work, switch to a per-agent worktree:`,
    ``,
    `  cd ${CANONICAL_PATHS[0]}`,
    `  git fetch origin main`,
    `  git worktree add ~/cortextos-worktrees/${agentName}/<branch> -b <branch> origin/main`,
    `  cd ~/cortextos-worktrees/${agentName}/<branch>`,
    ``,
    `Read-only ops here (git fetch, log, status against main) are fine. See your CLAUDE.md`,
    `§ "Working tree (shared-repo discipline)" for the full workflow.`,
  ].join('\n');
}

async function main(): Promise<void> {
  // Drain stdin so Claude Code's hook-input pipe doesn't block. We don't
  // currently need any field from the SessionStart payload, but the harness
  // still pipes JSON on stdin and an unread pipe can stall.
  await readStdin().catch(() => '');

  const agentName = process.env.CTX_AGENT_NAME;
  if (!agentName) {
    process.stdout.write('{}\n');
    return;
  }

  const cwd = safeRealpath(process.cwd());
  if (!isUnderCanonical(cwd)) {
    process.stdout.write('{}\n');
    return;
  }

  // Best-effort audit-trail event. logEvent has its own internal error
  // handling; we still wrap defensively so a failed write never poisons
  // session boot.
  try {
    const instanceId = process.env.CTX_INSTANCE_ID || 'default';
    const org = process.env.CTX_ORG || '';
    const paths = resolvePaths(agentName, instanceId, org);
    logEvent(paths, agentName, org, 'action', 'worktree_canonical_boot_warning', 'warning', {
      cwd,
      agent: agentName,
      reminder: 'use ~/cortextos-worktrees/<agent>/<branch> for non-trivial code work',
    });
  } catch { /* non-fatal */ }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: buildWarningMessage(agentName, cwd),
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

// Always exit 0 — see file header.
main().catch(() => undefined).then(() => process.exit(0));
