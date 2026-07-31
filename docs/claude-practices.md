# Working on FiBuKI with Claude

Conventions for driving this repo with Claude Code. Adapted from the practices in
Stefan's MMS repos, which have run this way for months.

Read alongside [`who-is-this-for.md`](./who-is-this-for.md) (what we're building) and
[`rewrite-goals.md`](./rewrite-goals.md) (how the rebuild works).

## Host safety — enforced, not advisory

**The claude-audit box has 4 GiB.** A full `vitest run` spawns one worker per CPU,
each with its own V8 heap. `tsc --noEmit` over this project and `next build` are
similarly hungry. Any of them OOM-freezes that host hard enough to need a reset.
This happened three times before it was enforced.

`.claude/hooks/guard-memory.sh` (wired via `.claude/settings.json`) blocks these
shapes as a `PreToolUse` hook. It is **host-aware**:

- `MemTotal < 8 GiB` → this host can never run the full thing
- `MemAvailable < 4 GiB` → this host is too loaded right now

On a normal workstation both checks pass and the hook is invisible. It only ever
fires where it's needed.

**Scoped forms that work on a small host:**

```bash
# one test file, one worker
npx vitest run src/mail/imap/ImapProvider.test.ts --pool=forks --maxWorkers=1

# explicit files, capped heap
npx tsc --noEmit --max-old-space-size=900 src/foo.ts src/bar.ts
```

Full suites and full builds go on **CT 999**, not the audit box.

**Also:** no parallel sub-agents on the audit box. Fan-out is what OOMs it —
run build agents one at a time.

## Bound your output

Long command output is tokenized on entry **and replayed every turn after**. Cap it
at the source unless the full dump is the deliverable:

- `git log` / `ls` / `grep` → `| head -N` or `--max-count` / `-n N`
- `git diff` → `--stat` first, then scope to a path
- poll loops → print one line, not the whole payload

## Model routing is the biggest token lever

Don't pay premium reasoning rent on mechanical work. File moves, renames, shims,
doc edits and single-step changes want a cheap tier. Reserve the premium tier for
genuinely multi-step, interdependent work.

Sub-agents can run at a lower tier for cheap fan-out — but see the host-safety note
above about running them one at a time here.

## Prefer more, smaller sessions

Token economy, and less context drift and hallucination. At a logical stopping
point, write a **handoff** to `handoffs/YYYY-MM-DD-<slug>.md`: a self-contained
brief for the next chunk — goal, read-first docs, scope, non-goals, guardrails.

Before writing a handoff, `git pull` and re-read `handoffs/` — concurrent sessions
may have changed them. When a handoff is fulfilled, delete it and either write a
follow-up or fold the remainder into an issue.

**Exception:** orchestrator sessions — one long session coordinating cheap
sub-agent workers. There the workers are the small contexts.

## Spec before you build, then `/goal` against it

For anything where "what exactly are we building?" isn't settled:

1. **Spec it** — explore the idea, leave behind a handoff doc plus a **failing
   (`xfail`) test suite encoding the acceptance criteria**.
2. **`/goal` implements against it** — done when those tests pass with the marks
   removed.

This is the shape of the whole rebuild. Phase 0 writes the tests; every later phase
is a transformation that those tests verify. It's also why Phase 0 is not optional:
without the tests there is nothing for `/goal` to be *done* against, and an LLM
will happily generate confident, wrong accounting logic.

`/goal` requires Claude Code **v2.1.139+**. Skip the spec step for small, obvious
changes.

## Git

- **Branch from `main`.** Never stack a feature branch on another in-progress
  branch — it tangles review and drags in unrelated unmerged work.
- **Small, conventional commits.** Squash-merge PRs.
- **Self-review every PR, docs included.** Doc PRs are not exempt.
- **Verify Write-tool writes actually got committed** — check `git status -s`
  before you claim done.

## Don't touch docs silently

After a change, check whether it makes `README.md` or `docs/` stale.

- **`README.md`:** never edit it automatically. **Suggest** the specific edit and
  let a human decide.
- **`docs/`:** after a new feature, **propose** a matching docs update — which
  file, roughly what to add.

Raise both in the end-of-work summary. Don't write docs unprompted.

## Check existing decisions before inventing

Search `docs/` and the git history before proposing an approach. The most common
waste is re-deriving a decision that's already written down — see
[`rewrite-goals.md`](./rewrite-goals.md) for the ones that are settled (Postgres not
Supabase; port not rewrite; Austria only; same features both tiers).
</content>
</invoke>
