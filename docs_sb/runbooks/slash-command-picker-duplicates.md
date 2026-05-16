# Runbook — slash-command picker showing the same command 4+ times

When `/<command>` appears multiple times in the Claude Code slash picker, two amplifiers stack:

1. **Two on-disk definitions for the same name.** A file at `.claude/commands/<name>.md` AND a skill at `.claude/skills/<name>/SKILL.md` both register `/<name>`. The picker shows both.
2. **`triggers:` array amplification.** Every entry in a skill's `triggers: [...]` is a separately-matchable surface. The picker's fuzzy-match (against whatever you've typed so far) runs against name + description + each trigger; each trigger that fuzzy-matches contributes a separate picker row pointing at the same skill.

A 24-entry trigger list with a query that fuzzy-hits four or five of them = four or five picker rows for one skill.

## Symptoms

- `/<cmd>` shows up 3+ times in the picker
- Some rows have slightly different descriptions (different sources)
- Hitting any of them resolves to the same skill

## Diagnosis

```bash
# Find both definitions
grep -rln "^name: <cmd>" .claude/commands .claude/skills

# Inspect triggers list length
sed -n '/^triggers:/p' .claude/skills/<cmd>/SKILL.md
```

If you get hits in both `commands/` and `skills/`, or the `triggers:` array has many entries, that's the cause.

## Fix

1. **Delete the `.claude/commands/<cmd>.md` wrapper if it only delegates** to the SKILL. (`grep -l "Invoke the .* skill" .claude/commands/` finds these.)
2. **Trim `triggers:`** to the minimum useful set — `/<cmd>` plus 1-2 natural-language phrasings. Most "be the X", "play the X", "switch to X" patterns are dead weight that just inflate picker rows.

Restart Claude Code (or use `/doctor` reload) for the picker to pick up changes.

## Gotcha — `.gitignore` excludes `.claude/`

In this repo, `.gitignore` blocks `.claude/` with a whitelist for `commands/` only:

```
.claude/
!.claude/commands/
!.claude/commands/**
!.claude/rules/
!.claude/rules/**
```

`.claude/skills/` is not whitelisted, so:
- The SKILL.md you trimmed locally **is not tracked** — `git status` shows nothing
- A fresh clone re-introduces the duplicates from upstream

Two ways to make the fix stick:

- **Upstream PR to grandamenium/cortextos** — trim triggers in the source SKILL.md and (optionally) extend `.gitignore` whitelist to include `.claude/skills/`. Best leverage.
- **Local-only patch** — keep the trimmed SKILL.md in your checkout; re-apply on every fresh clone. Cheap but doesn't propagate.

## Incident log

- **2026-05-16** — `/act-as` was showing 5 picker rows (1 from `commands/act-as.md`, 4 from SKILL.md triggers via fuzzy-match against `/mode`). Trimmed SKILL.md triggers from 24 entries to 3 (`/act-as`, `act as`, `act-as`); deleted `commands/act-as.md`. Both changes local-only — upstream still has the bloat.
