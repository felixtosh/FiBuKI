# Benchmarking matching

How we tell whether a change to matching makes FiBuKI better or worse on real
accounts, what runs today, what we decided on 2026-10-07, and what to build next.
The mechanics of the one tool that exists are in [`replay.md`](replay.md); this page is
the map around it.

## What runs today: the replay

Put the **`replay`** label on a PR. Every push to it then runs the matcher over each
benchmark account on fibuki.com, once on the PR's base and once on its head, and
posts one comment with counts per account:

| Mark | Meaning |
|---|---|
| ✅ | The branch now decides what the owner decided by hand. |
| ❌ | The branch overrules a hand decision or acts on a rejected pair. Look at these first. |
| ❓ | Changed, and nobody ruled on it. This is the list a person has to read. |

- **What it covers:** File to Transaction suggestions and auto-connects, and the
  Partner on each Transaction. It runs "warm": everything else in the account stays
  as it is today.
- **What it does not cover:** extraction, learning from manual decisions (the answers
  are in the data it reads), Global Partner coverage for new Transactions, the chat
  agent. See the roadmap below.
- **Cost:** about two minutes per push, no AI calls, nothing written to any account.
- **It warns, it never blocks.** The check always passes; the verdict is the comment.
  Merging past a ❌ is the author's call, with a line in the PR saying why.
- **The rows:** the comment carries counts only. Each account owner reads their own
  rows on **fibuki.com/admin/replay?pr=&lt;number&gt;**. An admin sees their own account
  and nobody else's.

### The accounts

An admin decides which accounts are in the benchmark, in **user management**: open a
user, section **Benchmark**, switch on **In the benchmark**. It asks for the agreement
that allows it (for example "Contract of 2026-10-07"); that note, the date and the
admin who set it are the consent record. Switching it off takes the account out of the
next replay run and the next version.

`replay.sh` asks the API for that list on every run (`replay accounts`). While nobody
is switched on, it falls back to the old hand-kept `/opt/fibuki-replay/accounts` file
(one `<uid> <label> [months]` per line), which since 2026-10-06 holds Felix and Stefan.
Switch both on in user management and the file is no longer read.

**Stefan:** `/admin/replay` needs the admin flag, which your account does not have yet.
Until Felix sets it, read the counts in the PR comment.

## The shared benchmark data

One frozen dataset for everyone who works on matching, so two people tuning the matcher
measure on the same thing.

**For an admin**, on fibuki.com/admin/replay, card **Benchmark data**:

- **Build version** snapshots every account that is in the benchmark (the last 12
  months each) into one file, `bench-YYYY-MM` (a second one in the same month is
  `bench-YYYY-MM-2`), with a sha256 checksum. It reads the accounts and writes nothing
  to them.
- The card lists the versions with their accounts, checksum and size, and says how many
  hand decisions came in since the newest one. Build the next version when that number
  is worth it, and tell the others once: "bench-2026-11 is out".
- **Delete** removes a version from the server. Copies already downloaded stay where
  they are, so keep the list of people who may download short.

**For a developer**, who needs the **May download benchmark data** switch (an admin sets
it in user management, per person):

1. Download a version: the download button on the same card, or with a personal API key
   (Settings, API keys), for an agent or a script:

   ```bash
   curl -H "Authorization: Bearer $FIBUKI_API_KEY" \
     "https://fibuki.com/api/admin/benchmark" # lists the versions
   curl -H "Authorization: Bearer $FIBUKI_API_KEY" -o ~/bench/bench-2026-10.json \
     "https://fibuki.com/api/admin/benchmark?version=bench-2026-10"
   ```

   Every download is logged with who, which version and how.
2. Check it, from `functions/`:

   ```bash
   npm run selfhost:replay -- verify --bundle ~/bench/bench-2026-10.json
   ```

   It prints the version, checksum and accounts, and refuses a file that was changed.
3. Run a branch against main on one account, and diff:

   ```bash
   git checkout main
   npm run selfhost:replay -- sheet --bundle ~/bench/bench-2026-10.json --account Felix --out ~/bench/main.felix.json --label main
   git checkout my-branch
   npm run selfhost:replay -- sheet --bundle ~/bench/bench-2026-10.json --account Felix --out ~/bench/branch.felix.json --label my-branch
   npm run selfhost:replay -- diff ~/bench/main.felix.json ~/bench/branch.felix.json --md ~/bench/felix.md
   ```

   Repeat per account. Every run prints `bench-2026-10 · checksum … · Felix, Stefan` first:
   two results are comparable only when that line matches. No AI calls, no database:
   `sheet` refuses to run with `DATABASE_URL` set.

The file holds real bank lines. Keep it out of the repo (`*.json` under `~/bench`, not
the checkout) and delete it when a newer version replaces it.

### Results so far

| Run | Felix | Stefan | What it showed |
|---|---|---|---|
| Control, #759 (comment-only change in `matcher.ts`) | 0 of 378 rows changed | 0 of 683 rows changed | The replay is deterministic: a reported change is a code change. |
| #739, stored Due and Debit Dates | 6 Files changed: 1 ❌, 5 ❓ | 10 Files changed: 10 ❓ | One of Felix's hand connections is overruled. Read that ❌ before merging #739. |

The first #739 run covered Felix only: `replay.sh` read the accounts file on stdin,
which `docker compose exec` swallowed after the first line. Fixed in #744.

## Why the answer key grows now

The replay grades a change only against what a person decided. Two changes from the
same day make that answer key bigger and the grading honest:

- **Confirming automatic matches (#750, #755).** A check mark left of the X on an
  automatic Partner, connection or No Receipt category makes it the User's own. The
  matcher learns from it, nothing automatic can overwrite it afterwards, and the
  replay counts it as a hand decision. Every confirm turns a ❓ into a ✅ or ❌ for later
  PRs.
- **The activity log (#752).** Every change a person, the matcher or an AI makes to a
  Transaction or File is logged with who made it. When a replay row looks odd, the
  item's log says how it got there.

## Decisions (Felix, 2026-10-07)

1. **Warn, never block.** A bugfix that has to ship is not held by a benchmark. A
   matching PR gets a scorecard; a PR that does not touch matching gets nothing.
2. **Run it while building, not only at review.** The benchmark has to be one fast
   local command a person or an agent runs after each change, so it must stay free of
   AI calls and deterministic.
3. **One shared dataset, not one per developer.** If Felix and Stefan each tune
   against their own account, they work against each other. The benchmark data is one
   frozen, versioned set built from the accounts whose owners agreed in writing, with
   a per-account breakdown so a change cannot hide that it helps one account and hurts
   another.
4. **Synthetic data is not the benchmark.** It encodes our own assumptions. Every
   real failure the benchmark finds becomes a synthetic unit test instead, so the
   lesson survives without the real data.
5. **Global Partners are frozen in the set.** They change without any code change, so
   both sides of a comparison must see the same list.

## Roadmap

In order. Each item is one PR.

1. **Holdout bench for Partner assignment.** Pick a cut-off date. Hand decisions and
   Rejections before it are training: rebuild the learned state (patterns, billing
   cycles, scoring weights) from them alone. Hand decisions and Rejections after it
   are the hidden answers. Run main and the branch on the same rebuilt state. Keep
   only Global Partners created before the cut-off, or the set leaks answers. This
   is the first thing that tests the code that learns from manual decisions.
2. **The scorecard.** Per account, never summed:
   - *Gates:* hidden Rejections the branch acts on by itself, and hidden hand decisions
     it overrules. Either going up prints **worse** in bold.
   - *Work saved:* hidden hand decisions the branch gets right with nothing for the User
     to do.
   - *Direction:* how often the hand choice ranks first, the median margin over the best
     wrong candidate, and how many cases sit just under the auto threshold.
   - *Noise:* compare case by case and count only the disagreements (main right and
     branch wrong, or the reverse). With these small numbers only a lopsided result,
     roughly 8 against 1, counts as better or worse.
3. **The same holdout for File to Transaction.**
4. **Calibration.** For hand-decided cases grouped by score band, how often the top
   candidate was right. That sets `AUTO_MATCH_THRESHOLD` from data: the lowest score
   where the top candidate is nearly always right and no hidden Rejection is acted
   on. Tune on the training half, check on the hidden half, over several cut-off
   dates, and keep a change only if it holds on every account.
5. ~~**The shared benchmark data** behind user management~~: built, see
   [The shared benchmark data](#the-shared-benchmark-data) above.
6. **A short "please confirm" list** of the cases near the threshold and the cases
   where main and a branch disagree. Those are the confirmations worth most.

## Open questions

- Where the set lives on a developer's machine and how long a downloaded version may be
  kept.
- Whether a pseudonymised set is worth building once more accounts opt in. Name
  matching depends on the real spelling, so it would lose signal.
- An extraction benchmark (corrected Files re-extracted, field accuracy) is a separate,
  paid tool that runs only when its own label is set.
