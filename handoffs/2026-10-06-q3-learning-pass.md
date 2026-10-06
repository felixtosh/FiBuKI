# Workstream: Q3 2026 as a learning pass

**Status (2026-10-06):** not started. Stefan has not touched Q3 yet, and that is the point:
Q3 is the first quarter where we can record what automation does on its own, for a
returning User, before any human correction. Q3's UVA is due 15 November, so the pass also
has to end in a fileable quarter.

## Goal

Curate Q3 on Stefan's account on the homelab instance and come out with three things:

1. **An unbiased accuracy figure for a returning User:** automation's untouched state
   compared with the curated one, on the same account.
2. **The reasons:** every correction Stefan makes that surprised him, with a one-line why.
3. **What using the app felt like:** where the app made the work slow or confusing, logged
   as it happens.

Each cluster of findings becomes a drafted issue that Stefan approves before it is filed.

## Why this and not another replay

The H1 2026 replay (below) compared an empty test account with Stefan's curated data. That
curated data was built partly by accepting the matcher's own suggestions, so the agreement
it measured is biased upward. Q3's untouched state has no such bias. Once Stefan starts
clicking, that baseline is gone, so the snapshot comes first.

## Read first

1. [`CONTEXT.md`](../CONTEXT.md): File, Transaction, Partner, payee, File Connection,
   Connection Origin, No-document Category, Rejection.
2. Issues from the H1 replay, so their findings are not filed twice:
   - felixtosh/FiBuKI#719: most missed File Connections score 70–79, just under the
     auto-connect threshold of 85.
   - felixtosh/FiBuKI#720: re-derive existing Transactions' Partners as the payee
     (follow-up to #550).
   - felixtosh/FiBuKI#721: a new User gets no No-document Category, even on transfers
     between their own accounts.
   - felixtosh/FiBuKI#722: a File imported over IMAP records the encoded attachment size.
3. The session memory entries `fibuki-replay-harness`, `fibuki-run-callable-as-user` and
   `fibuki-receipt-sources` (claude-audit only): where the harness lives, how to reach the
   account, and where missing receipts usually are.

## Where things are (claude-audit only, never in this repo)

The harness and all data live in `~/.local/share/fibuki/replay/`, outside the repo,
because they hold real bookkeeping data:

- `export-answer-key.mjs <from> <to>`: read-only snapshot of Stefan's account for a date
  range, through his API key (`~/.secrets/fibuki.env`).
- `replay.mjs`, `compare.mjs`, `lib.mjs`: the H1 replay into a dedicated empty test User
  (key in `~/.secrets/fibuki-replay.env`) and its report. This is the "cold start" that
  [`docs/replay.md`](../docs/replay.md) lists as not built: real uploads, real Extraction,
  nothing learned.
- `q3-before-20261005-1836/`: a first Q3 snapshot. It is **not** the baseline (see step 2).

## The repo's replay is the other half

[`docs/replay.md`](../docs/replay.md) runs the matcher offline over a frozen export of an
account, once on `main` and once on a branch, and says where the branch decides
differently from what the owner did by hand. No uploads, no model calls, seconds per run.
Use it where it fits instead of the live harness:

- **#719 (threshold):** a branch with a lower auto-connect line, replayed against Stefan's
  account, measures the same question without the upload burst.
- **After step 4:** once Q3 is curated, a fresh export makes Q3's hand decisions part of
  the set every later PR is replayed against.

The live harness stays the tool for what the repo's replay does not cover: Extraction and
the cold start.

## Steps

1. **Bank data first (Stefan).** Q3's bank lines currently stop around 10–17 August on all
   three accounts. Stefan imports the August–September statements **through the app's CSV
   upload**, not the API: that also checks AI column detection, which the replay skipped.
   Note anything odd about the import itself.
2. **Baseline snapshot (Claude).** Once automation has settled after the import (no File or
   Transaction still processing), run `export-answer-key.mjs 2026-07-01 2026-09-30` and
   rename the folder `q3-before-<timestamp>`. Take it immediately before Stefan starts, since
   scheduled automation keeps changing the account and anything it does after the
   snapshot would be counted as Stefan's correction. Also record what is missing, not just
   what is wrong: list the Paperless documents and mails that hold Q3 receipts FiBuKI has not
   imported (the `fibuki-receipt-sources` memory says where to look). Coverage is a finding
   too.
3. **Curate (Stefan, in the app).** Stefan does the work himself, so the app's usability is
   tested too. Claude does not make his changes through the API. Order:
   - suggestions (accept or reject), so Partners learn before the next step
   - bank lines with nothing on them
   - Files with no bank line
   - No-document Categories

   Whenever something surprises him, he drops one line in chat ("wrong because…", "could
   not find…", "took too many clicks…"). Claude appends each line to
   `~/.local/share/fibuki/replay/q3-notes.md` with the File or Transaction it concerns. When
   he asks why automation did something, Claude reads the live breakdown with MCP
   `score_file_transaction_match` (or `get_partner` for billing cycles) and notes the
   answer next to his line.
4. **After snapshot and diff (Claude).** Snapshot again into `q3-after-<timestamp>`. Build a
   small `diff-before-after.mjs` (the ids are stable on one account, so this is simpler than
   `compare.mjs`). Report per File: connection kept, added, removed or changed; Partner
   kept or changed; extracted fields Stefan corrected; per Transaction: Partner and
   No-document Category kept or changed; UVA figures before and after. Join each change
   with its line from `q3-notes.md`. A change between the snapshots is not always
   Stefan's: accepting a suggestion teaches a Partner, and automation may then connect
   or categorise other lines on its own. Split the changes by who made them (each
   Transaction's automation history, and the Connection Origin where it is readable), and
   count automation's own follow-up moves as automation, not as corrections.
5. **Findings to issues (Claude, then Stefan).** Group the changes by cause. Check each
   group against #719–#722 and the open tracker. Draft every body to acceptance criteria,
   show the drafts to Stefan, then file. A rule question opens a grilling issue with
   `needs-triage`, not a `ready-for-agent` brief.

## Guardrails

- **felixtosh/FiBuKI is public.** No amounts tied to Stefan's business (revenue, UVA
  figures), no names of private persons, no IBANs in issues, PRs or this handoff. Use
  counts, ratios and generic examples.
- **Reads only on Stefan's account through the API.** Auto mode has refused MCP writes there
  before. The curation is his anyway.
- **The audit box has 4 GB.** No parallel sub-agents, no full test suites; keep snapshot
  files sliced when reading them.
- **Do not change matching logic during the pass.** A threshold or rule change mid-quarter
  makes the before/after diff unreadable. Findings wait for the issues.

## Non-goals

- Filing the Q1/Q2 UVA (a separate, still open task; the `fibuki-uva-q1q2-2026-filing`
  memory has its state).
- Replaying Q3 into the test account. That needs a reset for the test account first:
  deleted Files block identical re-uploads, and purging is only possible in the app. Build
  the reset, then replay Q3 to see the same quarter as a new User.
- Moving the harness to a `~/bin/hl-fibuki-replay` command. Do it once the Q3 diff works.

## Done when

Q3 is curated and fileable, the before/after report exists with Stefan's reasons joined in,
and every finding is either filed (with Stefan's approval), folded into an existing issue,
or explicitly dropped. Then delete this handoff.
