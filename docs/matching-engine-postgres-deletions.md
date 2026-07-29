# Matching-engine deletions: inventory and proposal

> **Status:** ACCEPTED as written by Stefan 2026-07-21 (all three checkboxes
> below; logged in [`decisions.md`](decisions.md)). This doc now serves as
> the Phase-2 deletion registry. Workstream:
> `handoffs/2026-07-21-matching-engine-deletions.md`.

## The constraint that shapes every case

**One codebase, two backends until Phase 2.** The Cloud Functions run against
real Firestore in production (fibuki.com) *and* against the shim on selfhost.
Anything expressed through the Firestore API works on both; a SQL join cannot
be expressed through that API, and the shim interface is frozen (Phase 2 rips
it). So a "Postgres makes this redundant" finding lands in one of three
buckets:

- **Do now** — work that helps both paths or is pure Phase-1 flattening.
- **Phase 2** — the actual deletion: when the shim goes, retrieval code stops
  being Firestore API calls and joins become writable. This doc is the
  registry of those deletions so Phase 2 doesn't have to rediscover them.
- **Keep** — code that looked like Firestore compensation but earns its keep
  for other reasons.

A fourth option — a retrieval-provider seam now, so selfhost gets SQL while
Firebase keeps the chunk loops — is possible behind every function boundary
below, but it doubles the retrieval implementations to test while the only
production deployment is still Firebase, and selfhost today is one tenant
with small data. **Recommended in zero cases.** It's listed per case only
where the function boundary makes it trivial, in case priorities change.

What is *not* in scope in any bucket: scoring and decision logic. The pinned
bugs (billing-cycle 12→14 relabel, `/g`-regex IBAN, unanchored suffix-strip)
and everything else `matching-characterization.test.ts`,
`transactionScoring.test.ts`, `learnBillingCycle.test.ts`, and the selfhost
chain suites pin stays byte-for-byte. Only retrieval plumbing is inventoried.

## Summary table

| # | Code | Firestore-forced shape | Postgres-native shape | Verdict |
|---|------|------------------------|------------------------|---------|
| 1 | `matchFileTransactions.ts` — `isTransactionCovered()` | connections by transactionId, then `__name__ in` 30-chunks over files, sum in JS | one `SUM` over `file_connections ⋈ files` | **Phase 2** (enabler: case 8) |
| 2 | `matchFileTransactions.ts` — `transactionSuggestions` pre-computation | — | — | **Keep** (product behavior, not retrieval compensation) |
| 3 | `findTransactionMatches.ts` — searchQuery path | fetch 1000 recent, substring-filter in JS | `ILIKE`/FTS in the WHERE | **Phase 2**, needs per-case OK (changes candidate set) |
| 4 | `matchFilesForPartner.ts` — "unfiled"/"unconnected" filters | fetch by partner/date window, JS-filter on denormalized arrays | anti-join on `file_connections` | **Phase 2** + data reconciliation (see case 7) |
| 5 | `precisionSearchQueue.ts` strategies 1–2 — "unassociated" filters | same anti-join-on-arrays shape | same anti-join | **Phase 2** |
| 6 | `__name__ in` chunk loops (4 sites) | 30-id batches + JS join-back | single joins | **Phase 2** |
| 7 | Denormalization triple `file.transactionIds` ↔ `transaction.fileIds` ↔ `fileConnections` | three representations, hand-synced | ONE table | **Phase 2/3**; reader map below |
| 8 | `fileConnections` still in the JSONB `docs` bridge | every connection query JS-filtered, unindexed | flattened table, all shapes compile | **Do now** — the one PR proposed from this workstream |
| 9 | `processOrphanedFiles.ts` — stale-scan cron | overfetch ×2 + in-code flag checks (`!= true or missing` unqueryable) | exact `IS NOT TRUE` predicate | **Keep** cron (crash-recovery until pg-boss); JS filtering dies at Phase 2 |

## Case details

### 1. `isTransactionCovered()` — `matching/matchFileTransactions.ts:1161`

Per auto-match candidate: query `fileConnections` by `transactionId`, collect
fileIds, then fetch the files in `__name__ in` 30-chunks to sum
`extractedAmount` in JS. Also `hasManualTransactionConnections()`
(`:1137`) — that one is already a fine indexed equality query and needs
nothing.

Postgres-native: `SELECT COALESCE(SUM(f.extracted_amount),0) FROM
file_connections c JOIN files f ON f.id = c.file_id WHERE c.transaction_id =
$1`. One round trip, no chunking, no JS sum.

**Verdict: Phase 2.** The function boundary is clean (id + amount in, bool
out) so a provider seam would be trivial — still not recommended (see above).
Flattening `fileConnections` now (case 8) at least makes the first query
indexed on selfhost. The coverage *rule* (10 % tolerance, sum-vs-amount) is
decision logic and stays as-is.

### 2. `transactionSuggestions` pre-computation — `matching/matchFileTransactions.ts`

The handoff asks whether pre-computing suggestions still pays for itself when
candidate retrieval is an indexed query. Finding: **the pre-computation was
never retrieval compensation.** The candidate fetch inside it is already an
indexed date-range query on both backends (`transactions.date` is a generated
column; the shape is pushdown-pinned since PR #15). What the stored
`transactionSuggestions` payload buys is product behavior: suggestions appear
instantly in the UI (`file-transaction-suggestions.tsx`,
`file-detail-panel.tsx` read them straight off the file doc via listeners),
they're computed at extraction time when the trigger chain has the file hot,
and the passive-mode flow depends on them being stored. Moving to on-demand
would change when scores are computed and what the UI sees — outcome-adjacent
and a UX regression on slow connections.

**Verdict: keep.** Revisit at Phase 3 only if Electric changes the read
story. (It stays payload data, not a generated column — decided in PR #16.)

### 3. `findTransactionMatchesForFile` searchQuery path — `matching/findTransactionMatches.ts:188`

When the user types in the connect dialog, the callable fetches the 1000 most
recent transactions and substring-matches name/partner/reference in JS.
Postgres-native is an `ILIKE` (or FTS) predicate in the WHERE — but that
changes which candidates are scored (today: only the 1000 most recent; SQL
would search all history). That's a *better* behavior, but per the ground
rules anything that changes the candidate set needs its own explicit OK.
The no-search paths of this callable are already indexed range queries;
nothing else here is Firestore-shaped.

**Verdict: Phase 2, with its own OK at that point.** Nothing to do now.

### 4. `matchFilesForPartner.ts` — anti-join filters

Two fetch-then-filter shapes:

- `:376` — transactions for the partner, JS-filtered to "no `fileIds`, no
  `noReceiptCategoryId`".
- `:409-450` — two parallel file queries (partner's files + unassigned files
  in the transactions' date window), merged in a Map, JS-filtered to "no
  `transactionIds`, not `isNotInvoice`".

Both are anti-joins over the denormalized arrays. Postgres-native:
`LEFT JOIN file_connections … WHERE fc.id IS NULL` plus plain predicates.
The prefilters (`partnerId ==`, `extractedDate` range, `extractionComplete`)
are all generated columns already — the *fetch* side is fine on both
backends; only the array-filter is the workaround.

**Caveat that blocks a naive rewrite:** the anti-join over `file_connections`
is **not semantics-preserving** against the array check today —
`lib/operations/file-ops.ts:1353` documents legacy connections where
transactions carry `fileIds` with *no* `fileConnections` document. Until the
relation is reconciled (case 7), the arrays are the more complete
representation and the JS filters are *correct*, not just workarounds.

**Verdict: Phase 2, after reconciliation.** The scoring
(`scoreFileForTransaction`, greedy assignment, AI fallback) stays untouched.

### 5. `precisionSearchQueue.ts` strategies — `:897-900`, `:1026-1029`

`partner_files` and `amount_files` strategies both do indexed prefilters
(partner equality / `extractedDate` ±90d window — generated columns, pinned)
then `.filter((f) => !f.transactionIds || f.transactionIds.length === 0)`.
Same anti-join shape and same reconciliation caveat as case 4.

**Verdict: Phase 2.** Scoring via `scoreAttachmentMatch` (the single source
of truth) is untouched.

### 6. `__name__ in` chunk loops

Four sites, all the same shape — batch ids in 30s because Firestore's `in`
caps at 30, then join back in JS:

| Site | Loop | Phase-2 replacement |
|------|------|---------------------|
| `matching/learnBillingCycle.ts:249-302` (`computeInvoiceDelays`) | connections by `transactionId in`, then files by `__name__ in`, then two `Array.find` join-backs | one `file_connections ⋈ files ⋈ transactions` returning (extracted_date, tx date) pairs |
| `analytics/exportMatchIntelligence.ts:126-170` | three enrichment loops (files, transactions, partners by id) | `file_connections ⋈ files ⋈ transactions ⋈ partners` |
| `matching/learnScoringWeights.ts:85-90` | connections by `transactionId in` | join |
| `matchFileTransactions.ts:1181` | part of case 1 | see case 1 |

The shim implements `__name__ in` (pinned by the parity suite since the
cursor-gap fix), so these all *work* on selfhost today — they're just N round
trips instead of one join, and ~120 LOC of chunking/join-back plumbing. The
delay *math* in `computeInvoiceDelays` and the weight tiers in
`learnScoringWeights` are pinned decision logic; only the fetch loops around
them are up for deletion.

**Verdict: Phase 2, all four.** This table is the registry.

### 7. The denormalization triple — reader map

`file.transactionIds` ↔ `transaction.fileIds` ↔ `fileConnections`: three
representations of one relation, kept in sync by
connect/disconnect/deleteSource/deleteFile code. End state is ONE table. The
handoff asked for the full reader map before any proposal; counts of
non-test files touching each representation:

| Representation | app | components | hooks | lib | functions | types |
|---|---|---|---|---|---|---|
| `transactionIds` | 4 | 12 | 5 | 15 | 31 | 3 |
| `fileIds` | 6 | 10 | 5 | 13 | 33 | 6 |
| `fileConnections` | 2 | 1 | 0 | 4 | 25 | 2 |

The load-bearing fact: **~40 frontend files read the arrays**, mostly through
`onSnapshot` listeners on `files`/`transactions` docs (file tables, connect
dialogs, transaction detail panels, agent read tools). The arrays are the
UI's read model; `fileConnections` is metadata (connection type, confidence,
score breakdown) read by far fewer sites (partner-detail-panel, agent
batch/search tools, analytics). Collapsing to one table means the UI's reads
become joined reads — that's an API/read-model change (Phase 2) or an
Electric shape (Phase 3), not a Phase-1 delete. Additionally the legacy
inconsistency from case 4 means a reconciliation/backfill pass
(arrays → connection rows) must precede any "connections table is the truth"
cutover.

**Verdict: Phase 2/3.** Concretely: Phase 2 makes `fileConnections` the
source of truth (after reconciliation) and turns the arrays into derived
data; dropping the arrays entirely waits until the UI reads move off raw doc
listeners. Nothing now except case 8.

### 8. Flatten `fileConnections` — the one PR proposed from this workstream

`fileConnections` is still in the JSONB `docs` bridge, so on selfhost every
connection query — including the ones inside the matching engine (cases 1, 6)
and the hot connect/disconnect paths — is a JS-filtered scan over JSONB, per
the Phase-1 rule "fine for one user, fatal for multi-tenant". It is also the
enabler for every join in this document.

Query-shape inventory (from all call sites, functions + frontend):
equality on `fileId`, `transactionId`, `userId`, `connectionType`; `in` on
`fileId`/`transactionId` (30-chunks); `orderBy createdAt desc` + limit
(exportMatchIntelligence). All compile under the existing pushdown contract.

Proposed spec, same harness as the four flattened collections:

- Generated columns: `file_id`, `transaction_id`, `user_id`,
  `connection_type` (text), `created_at` (timestamp).
- Indexes: `(tenant_id, transaction_id)`, `(tenant_id, file_id)`,
  `(tenant_id, user_id, created_at)`.
- No matching-engine code changes; app code unchanged (that's the point of
  the harness). Pushdown differential may gain little since these shapes are
  mostly pinned already — the partners flatten showed that's a valid outcome.

**Verdict: do now, pending OK.** One PR, full PR + CI + adversarial-review +
merge-OK flow.

### 9. `processOrphanedFiles.ts` — stale-scan cron

Two compensations are entangled here; the handoff asked which is which:

- **Firestore-unqueryability compensation:** "extraction done but partner
  match not done" is `partnerMatchComplete != true or missing` — Firestore
  can't query that, so the code scans by `updatedAt < staleTime`, overfetches
  ×2, and checks the flags in JS. On Postgres the predicate is exact
  (`partner_match_complete IS NOT TRUE`). This part dies at Phase 2.
- **Trigger-reliability compensation:** the cron exists because trigger
  delivery can be delayed or lost. That does *not* go away on selfhost —
  `trigger-shim.ts`/`bus.ts` deliver triggers in-process with no durable
  queue, so a crash mid-chain loses the follow-on trigger. The cron is the
  crash-recovery net until pg-boss makes the pipeline transactional
  (Phase 3).

The `updatedAt` stale-scan query shape is already pushdown-pinned (the
`<`-only range ordered ASC was one of PR #16's pinned shapes), so the scan is
indexed on selfhost today.

**Verdict: keep the cron; the overfetch + JS flag-filtering is registered
for Phase 2; retirement of the cron itself is Phase 3 (pg-boss).**

## What this adds up to

Postgres does delete matching-engine code — but almost all of it at Phase 2,
when the shim (and with it the Firestore-API constraint on shared code) goes.
Trying to force the joins in now means either breaking production (still on
Firestore) or a dual-retrieval seam that costs more than it returns. The
Phase-1-sized work that's real today:

1. **Flatten `fileConnections`** (case 8) — one PR, pending Stefan's OK.
2. **This document as the Phase-2 deletion registry** — cases 1, 3, 4, 5, 6,
   9 name file:line and the replacement SQL shape, so Phase 2 starts from a
   list, not a rediscovery.
3. **A reconciliation prerequisite flagged** (cases 4/7): legacy
   arrays-without-connection-docs must be backfilled before any anti-join or
   single-table cutover is semantics-preserving.

Decisions requested from Stefan:

- [x] OK / not-OK: flatten `fileConnections` now (case 8).
- [x] Confirm: everything else waits for Phase 2, with this doc as registry.
- [x] Confirm: suggestion pre-computation (case 2) and the orphan cron
      (case 9) are keeps.
