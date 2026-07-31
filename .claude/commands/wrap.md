---
description: Session-wrap ritual — harvest learnings to memory, prune, handoff hygiene, commit + push
---

Close out the session cleanly.

1. **Harvest durable learnings.** Scan this conversation for anything worth
   persisting that isn't already in memory: a corrected preference or working
   style (`feedback`), an ongoing goal/constraint not derivable from code or
   git (`project`), a non-obvious fact about how a system behaves
   (`reference`), or something about Stefan (`user`). For each, write one file
   to `~/.claude/projects/-home-yazzbert-fibuki/memory/` in the standard
   format and add a one-line pointer to `MEMORY.md`. **Do not** persist what
   the repo/git/CLAUDE.md already records, or what only mattered to this
   conversation.

2. **Prune memory (context diet).** `MEMORY.md` loads in full on *every*
   session, so a stale index is rent paid on every turn. In the same pass as
   step 1, cheaply prune — act only on what this session touched or obviously
   rotted:
   - **Delete what's proven wrong or done** — remove the file *and* its
     `MEMORY.md` line.
   - **Merge near-duplicates** — collapse to one file; fix any `[[links]]`.
   Only touch what you're confident about; when unsure, leave it. Note in the
   report how many lines `MEMORY.md` gained/lost.

3. **Handoff hygiene.** `git pull fork main` + re-read `handoffs/` first —
   other sessions edit them too. Fulfilled handoff prompt → `git rm` it
   (write a follow-up first if remainder exists). Work stopping mid-stream at
   a logical point → write a new self-contained handoff brief (goal ·
   read-first · scope · non-goals · guardrails). Outcome/history docs and
   other workstreams' prompts stay.

4. **PR / CodeQL loose ends.** For any PR touched this session: report its
   state (CI, adversarial review done?, awaiting Stefan's merge call?). If a
   security PR merged, note that alert closure was (or still needs to be)
   verified on `alerts?ref=refs/pull/<N>/merge`. Background agents or
   watchers still running → report them, don't kill. Local branches whose PR
   merged → `git branch -d` them.

5. **External follow-ups.** If the session touched anything owed by others,
   restate the open asks in the report (e.g. Felix: functions deploy / npm
   publish; Chrome Web Store release status). Don't silently drop them.

6. **Commit + push.** `git status -s` first — Write-tool writes are not
   auto-staged; verify every file changed this session is in the commit.
   Scan `git diff --staged` for secrets before committing. **Never** commit
   `.claude/settings.local.json`. Push via `git push fork <branch>` —
   **never** `origin` (root-owned deploy checkout). Docs/handoff commits go
   directly on `main`; code goes through a PR per the normal workflow.

Report what you saved, pruned, deleted, and pushed in a few lines.
