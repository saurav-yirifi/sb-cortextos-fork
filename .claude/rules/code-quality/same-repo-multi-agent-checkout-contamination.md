---
domain: [git, fleet-coordination, multi-agent]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# Same-repo multi-agent contamination: branch checkout silently discards another agent's uncommitted work

**When multiple agents share a single git working tree, any agent's branch checkout silently discards (or carries forward unexpectedly) other agents' uncommitted work.** Class-of-trap is distinct from cross-fleet contamination — there it's another fleet's agents touching our tree; here it's our-fleet's-agents-on-our-shared-repo. Same matrix shape, different ownership boundary.

The trap surfaces when:
- Agent A is mid-implementation on branch X with uncommitted edits to files that differ between X and Y.
- Agent B (unaware of A's work) does `git checkout Y` (or `git checkout -b new-branch Y`), git either refuses (if conflicting) or carries A's edits onto the new branch silently.
- Either outcome wastes A's time: refusal blocks B; carry-over scope-mixes A's work into B's PR.

## Pattern fix

Three options, in order of preference:

1. **Dedicated git worktrees per agent on shared repos.** `git worktree add ../repo-engineer feat/x` gives engineer its own working tree under the same .git. Branch checkouts in one worktree don't affect another. Best discipline; one-time setup cost.

2. **Coordinate checkouts via inbox messages.** Before any branch switch, agent posts a `branch_checkout_lock` inbox message; other agents check before their own switches. Lower setup cost but requires every agent to honor the protocol.

3. **Commit-before-checkout discipline.** Every agent commits (or at minimum stashes with descriptive name) ALL working-tree changes before any branch operation. WIP commits are fine — squash before PR. Lowest setup cost, requires every agent's discipline.

## Rule of thumb

A shared git working tree is a shared mutable resource — the same coordination rules apply as to any concurrent-write data structure. Either partition it (worktrees), lock it (inbox protocol), or serialize via a discipline (commit-before-checkout). Picking none is the failure mode.

## Source incident

Micro-retro 2026-05-08 — analyst (this agent) branched + checked out for BL-002 on cortextos-fork; engineer's uncommitted BL-003 phase 1 edits (~5 files, 31 passing tests) on the shared working tree were affected. Engineer recovered via `/tmp/bl-003-worktree`, +20 min cost. Class is distinct from the 2026-05-08 cross-fleet-contamination rule (which was jarvis-fleet auto-committing into engineer-D2 branch on the jarvis tree); both rules together cover the full matrix of repo-ownership × fleet-membership.
