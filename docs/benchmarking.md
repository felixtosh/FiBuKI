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

The box reads `/opt/fibuki-replay/accounts` (one `<uid> <label> [months]` per line).
Since 2026-10-06 it holds Felix (`felix@i7v6.com`) and Stefan
(`stefan@houseofbandits.at`), 12 months each. A uid is `auth_users.id` in Postgres, not
the email.

**Stefan:** your account runs on every labelled PR, but `/admin/replay` needs the admin
flag, which your account does not have yet. Until Felix sets it in user management,
ask for the counts in the PR comment, or read
`/opt/fibuki-replay/reports/<pr>/<your uid>.md` on the box.

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
5. **The shared benchmark data**, behind user management:
   - an admin-only "in the benchmark" flag per user, with the date and the contract
     note as the consent record; the replay reads its accounts from this flag instead
     of the file;
   - a separate "may download benchmark data" flag per person;
   - an admin button that builds a versioned snapshot (`bench-YYYY-MM`) of all opted-in
     accounts on the box, with a checksum, and deletes old versions;
   - a download that accepts the login (a button on the admin page) or a personal API
     key (for agents), checks the flag and logs who took which version;
   - the bench reads only that file, never a database, and prints the version and
     checksum on its first line, so two scorecards are comparable only when those
     match. A counter of new hand decisions since the current version says when to
     cut the next one; one message per version, not per production change.
6. **A short "please confirm" list** of the cases near the threshold and the cases
   where main and a branch disagree. Those are the confirmations worth most.

## Open questions

- Where the set lives on a developer's machine and how long a downloaded version may be
  kept.
- Whether a pseudonymised set is worth building once more accounts opt in. Name
  matching depends on the real spelling, so it would lose signal.
- An extraction benchmark (corrected Files re-extracted, field accuracy) is a separate,
  paid tool that runs only when its own label is set.
