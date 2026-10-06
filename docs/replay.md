# Replay: does a branch decide my real account differently?

The replay answers one question about a PR without reading its architecture: **for
every File and Transaction in a real account, would the branch decide something
different from `main`, and does the change agree with what the owner did by hand?**

It runs the one matcher (#613) and the Partner matcher over a frozen copy of an
account, once on `main` and once on the branch, and diffs the two answer sheets. No
model call, no write to any deployment, a few seconds per run.

## The three steps

```
export  (on the deployment, once per account)   -> felix.replay-set.json
sheet   (on any checkout, once per commit)       -> main.sheet.json, pr-660.sheet.json
diff    (anywhere)                               -> report.md
```

### 1. Export your account once

On fibuki.com, from `/opt/fibuki/deploy/selfhost`:

```bash
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
$DC exec -T fibuki-api npm run selfhost:replay -- export --user <your uid> --label Felix --out /tmp/felix.replay-set.json
$DC cp fibuki-api:/tmp/felix.replay-set.json ~/replay/felix.replay-set.json
```

The set holds your Transactions and Files of the most recent 12 calendar months
(`--months`, `0` for everything), the Files without their OCR text, plus all Partners,
File Connections, Invoices, the active Global Partners and the ECB rate months. It reads
only. **It is your real financial data**: `*.replay-set.json` is gitignored, keep it
on your machine, and share it only with the people you want to see your bank lines.

Re-export when your account has changed enough that the old copy no longer
represents it (new imports, a lot of new hand decisions). The diff refuses two
sheets from different exports, so every comparison is on identical data.

### 2. Build a sheet per commit

On your checkout, with no `DATABASE_URL` in the environment (the command refuses one,
so a set can never be loaded into a deployment):

```bash
cd functions
git checkout main && npm run selfhost:replay -- sheet --set ~/replay/felix.replay-set.json --out ~/replay/main.sheet.json
git checkout claude/issue-614-window-due-date && npm run selfhost:replay -- sheet --set ~/replay/felix.replay-set.json --out ~/replay/pr-660.sheet.json
```

Each sheet records, per File, the suggestions the upload trigger would store and what
it would auto-connect; per Transaction, the Partner the matcher would assign. Beside
each answer it records your own decisions: hand connections, Rejections, a Partner you
set yourself. The sheet is labelled with the branch and the git SHA.

Files are scored as a fresh upload with everything else as it is: the File's own
connections are set aside, the Files already on each candidate still count (the
Remainder), Rejections hold, Partners and Learned Patterns are as stored. It answers
"would this File land where it landed", not "what does a new user see on day one".

### 3. Diff

```bash
npm run selfhost:replay -- diff ~/replay/main.sheet.json ~/replay/pr-660.sheet.json --md ~/replay/pr-660.md
```

The report starts with the counts and a one-line verdict, then lists every changed row,
worst first:

| Mark | Meaning | What to do |
|---|---|---|
| ✅ now agrees | the branch now decides what you decided by hand | nothing |
| ❌ no longer agrees | `main` matched your hand decision, the branch does not | the PR regressed this row |
| ❌ contradicts | the branch would connect or assign something you rejected, or something other than your hand decision | the PR regressed this row |
| ❓ unverified | changed, and you never ruled on it | read the row; this is the list that needs a human |

Exit code 1 when any ❌ row exists, so the diff can gate a script.

Only your own decisions are the answer key. An auto-connection you never touched is not
evidence either way, so a change there is ❓ and the row says whether the branch matches
what is stored today.

## Reading a PR with it

- **A refactor** ("no behaviour change" in the PR body): the report must say *No
  behaviour change*. Any row at all is a bug in the refactor.
- **A matching change**: ❌ rows are regressions, ❓ rows are what the PR is for. Judge
  the ❓ rows; the PR body should predict them ("stretches the window, so 45-day
  invoices now connect").
- **Anything else** (UI, extraction prompts, chat): the replay does not see it. The
  PR review says what to test by hand.

A PR that touches `functions/src/matching/` should carry its report (or its counts) in
the Evidence section.

## One click: the `replay` label

The three steps above are the engine. On fibuki.com they run by themselves:

1. Put the **`replay`** label on a PR. Every push to that PR from then on runs the
   replay (`.github/workflows/replay.yml`, shipped as `deploy/selfhost/replay.workflow.yml` until it is moved there; see its header).
2. The workflow ships the PR's and the base commit's `functions/` trees to the box and
   runs `deploy/selfhost/replay.sh` there. The script exports every account listed in
   `/opt/fibuki-replay/accounts` fresh through the running API container (read-only),
   builds the two sheets in throwaway Node containers with no database, and diffs.
3. The counts come back as one PR comment, updated in place. The full reports stay on
   the box under `/opt/fibuki-replay/reports/<pr>/` and are read on
   **fibuki.com/admin/replay**, where each admin sees the report for their own account
   and nobody else's.

Only a maintainer can put the label on, and a fork PR never runs (GitHub hands it no
secrets, and the job condition refuses it). The comment carries counts only.

Box-side setup, once:

```
mkdir -p /opt/fibuki-replay && chmod 700 /opt/fibuki-replay
printf '%s\n' '# <uid> <label> [months, default 12]' \
  '<felix uid> Felix 12' \
  '<stefan uid> Stefan 12' > /opt/fibuki-replay/accounts
```

`/opt/fibuki-replay` sits outside `/opt/fibuki` on purpose: the deploy rsyncs
`/opt/fibuki` with `--delete`. The web container reads the reports through the
`/replay` mount in `docker-compose.prod.yml` (`FIBUKI_REPLAY_DIR`).

## Two accounts, or more

Every set is one account. With the label, every account in `accounts` runs on every
labelled PR, and each owner reads their own report. By hand, Stefan exports his own set
the same way and keeps it on his machine. A PR is then run against both:

```bash
for who in felix stefan; do
  npm run selfhost:replay -- sheet --set ~/replay/$who.replay-set.json --out ~/replay/$who.pr-660.sheet.json
done
```

and each report stands on its own. Two accounts disagree on purpose: one has Learned
Patterns and years of hand decisions, the other may be younger. A change that helps one
and hurts the other is exactly the finding the replay exists for. Nobody needs the other
person's set to run their side; sharing the two `report.md` files is enough.

## What it does not cover

- **Extraction.** The sheet reads the stored Extraction; a prompt or parser change
  needs real model calls on a fixed set of Files, and that is a different, paid tool.
- **The "cold start"**: Partners, Learned Patterns and Rejections dropped. Not built
  yet; the warm replay above is what Stefan's PRs change.
- **The two Gemini fallbacks** in Partner matching (`matchFilesForPartner`, domain
  validation) are not run. The sheet is deterministic.
- **The chat agent.** Keep ten real questions and compare answers on a preview.

## Where the code is

- `functions/src/replay/set.ts`: the set format, export and load.
- `functions/src/replay/sheet.ts`: the sheet builder, on top of the matcher.
- `functions/src/replay/diff.ts`: the verdicts and the Markdown report.
- `functions/scripts/replay.ts`: the CLI (`--months` keeps the most recent calendar
  months, default 12; `0` takes everything).
- `functions/src/selfhost/replay.test.ts`: the whole chain on a two-transaction account.
- `deploy/selfhost/replay.sh` and `.github/workflows/replay.yml`: the label-triggered run.
- `app/api/admin/replay/route.ts` and `app/(dashboard)/admin/replay/page.tsx`: the
  reports page, one account per admin.
