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

- `MemTotal <= 8 GiB` → this host can never run the full thing
- `MemAvailable < 4 GiB` → this host is too loaded right now

On a normal workstation both checks pass and the hook is invisible. It only ever
fires where it's needed.

It matches a command that runs the tool, not the tool's name in the text:
`grep -i vitest package.json` passes, `cd functions && npx vitest run` without a
worker cap does not.

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

### The guard matches the command string, not the command

The hook greps the whole command text for the tool names. It cannot tell the
difference between *running* one and merely *mentioning* one, so these are all
blocked even though none of them executes anything:

```bash
grep -n "vitest" .claude/hooks/guard-memory.sh     # reading about it
cat > notes.md <<'EOF' ... vitest ... EOF          # writing a doc that names it
gh issue comment 1 --body "we should run vitest"   # quoting it to a human
```

That is the safe direction to fail, and it is not worth loosening the pattern —
a guard that tries to parse intent is a guard that eventually lets the real
thing through. Work around it instead:

- write file content with the **Write tool** rather than a heredoc
- pass long text to `gh` with `--body-file`, never an inline `--body`
- to inspect the hook itself, open it with Read rather than grepping for the name

Hit twice in one session on 2026-09-10, both times on read-only or
text-authoring commands.

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
- **Work in a worktree, never in the shared checkout.** Several sessions (Felix's
  tabs, Stefan's cloud session) run against the same repo at once. Switching
  branches in `~/Documents/fibuki.nosync` collides with them: on 2026-10-01 another
  tab's `git pull --rebase` rebased a feature branch mid-work. Instead:
  - `git worktree add -b <branch> <scratch-dir>/<name> origin/main`, and run every
    command against that path (the shell returns to the main checkout between calls);
  - give it its own `npm ci` in the root **and** in `functions/`. A symlink to the main
    checkout's `node_modules` breaks the moment another tab reinstalls them (tsc then
    reports a missing `FirebaseFirestore`, vitest "no tests");
  - leave the main checkout on `main` with the user's uncommitted changes untouched;
  - once the PR is merged, `git worktree remove` it and delete its branch, locally and
    on `origin`.
- **Small, conventional commits.** PRs land as merge commits (`gh pr merge --merge`),
  which is what the history uses.
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

## Writing tests

Keep the suite cheap to maintain. Four rules:

- **Prefer the self-host suite** (`functions/src/selfhost/`, run with
  `vitest.selfhost.config.ts`). It runs the real code against a real Postgres
  engine (PGlite), so a test breaks when behaviour changes, not when an
  internal is renamed. Reach for `vi.mock` only at a true boundary: a model
  call, a third-party API, a secret.
- **Never sleep a fixed time to wait for something.** Wait for the thing:
  `__whenShimIdle()` for fire-and-forget writes, `drainTriggers()` for
  triggers, `__whenListensIdle()` for realtime listens, `vi.waitFor` for a
  condition, a barrier when a test needs concurrent callers to interleave.
  A fixed delay is only right when the timer itself is under test (backoff,
  watchdog), and then say so in a comment.
- **Use the shared setup.** `startTestServer` / `startTestDataPlane`
  (`selfhost/test-helpers.ts`) for an HTTP surface; `security/victim.ts` for
  anything about one user reaching another's data; `tools/__tests__/
  handlers-harness.ts` for tool-handler mocks.
- **Cross-user isolation is covered generically.** The suites in
  `selfhost/security/` attack every callable, AI tool and data-plane route from
  the registries; a new one is attacked without anyone adding it. A new
  surface that does not come from a registry (a Next API route) needs a case
  in `cross-user-routes.test.ts`.
