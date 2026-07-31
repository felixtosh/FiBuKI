# Decision log

Audit trail of **human decisions** — the calls Stefan (or another human) makes
that shape the project but don't show up as reviewable code. GitHub is the
audit trail for code changes; this file is the audit trail for judgment calls:
scope, process, product rules, external commitments.

**Rules:**

- Every session that involves a human decision appends it here, newest first.
- One entry per decision: date, who decided, the decision, and enough context
  that a reader six months later understands *why* without spelunking chat
  logs.
- Code-level choices (naming, index tuples, refactors) stay in PR
  descriptions; product/architecture foundations live in
  [`who-is-this-for.md`](who-is-this-for.md) and
  [`rewrite-goals.md`](rewrite-goals.md) — this log records the dated calls
  that applied or changed them.
- This file is docs: it ships to `main` without a PR (see 2026-07-21 below).

---

## 2026-07-25 — Non-invited social sign-in: full access-request parity

**Decided by:** Stefan (in-session choice; implemented in PR #34)

A non-invited Google sign-in under self-host must reach the **same outcome as
the cloud build** — record an access request an admin can act on, and show the
"access request submitted" banner — not just silently fail. Chosen over the
lighter "client-only message, no server record" option.

Context: the Firebase `submitAccessRequest` callable needs an authenticated
caller (Firebase auto-creates the OAuth user, records, then deletes it). The
self-host invite gate blocks creation outright, so there is never an
authenticated caller. Parity therefore requires the **host** to write the
`accessRequests` record from the `user.create.before` hook (the client
data-policy forbids client creates). This keeps the "self-host and cloud ship
the same features" rule intact rather than accepting an admin-visibility gap.

## 2026-07-21 — W1 Better Auth: implementation decisions (spec accepted)

**Decided by:** Stefan (checkboxes in
[`handoffs/2026-07-21-w1-better-auth-impl.md`](../handoffs/2026-07-21-w1-better-auth-impl.md);
spec suites merged as PR #19)

- **Session-token shape: (a) Better Auth JWT plugin.** `getIdToken()` stays a
  locally-decodable JWT; the host verifies via JWKS with the same machinery
  `oidc-verifier.ts` already has. Keeps the client thin and the external-OIDC
  path structurally identical to the built-in one.
- **Google sign-in on selfhost: Better Auth's Google social provider**, BYO
  OAuth client via env — consistent with "same features, bring your own
  OAuth" (`who-is-this-for.md`). No external-IdP requirement for Google.
- **401 shaping approved:** unauthenticated `app/api/*` requests move
  500 → `401 {"error":"Unauthorized"}` on the Firebase build too (the spec
  found the routes' 401 branches are dead code and two routes leak internal
  error text). Chunk 5 of the implementation.
- **Ported registration callables: keep excluded.** `validateRegistration`,
  `setAdminClaim`, `listAdmins`, `sendPasswordReset` etc. stay in
  `EXCLUDED_EXPORTS`; invite-only/admin semantics land as Better Auth-native
  equivalents instead of un-excluding the Firebase-era callables.
- **Next API routes under selfhost: revisit later** (W3/W4). Out of W1 scope;
  the auth-verify decision ("no selfhost branch point in
  `get-server-user.ts`") stands for now even though the selfhost UI calls
  some of these routes (`chat`, `gmail/*`). The spec suite deliberately
  encodes nothing here.

## 2026-07-21 — Phase 2 kickoff: proposal accepted, cutover-first order

**Decided by:** Stefan (in-session; Felix on-board with all decisions so far)

[`phase-2-rip-the-shim.md`](phase-2-rip-the-shim.md) accepted: cutover-first
strangler order (make the selfhost stack production-ready → cut fibuki.com
over with code unchanged → tear the shim down and execute the deletion
registry). Cutover pattern is **short write-freeze + one-shot migration +
DNS flip**, no dual-write. Password-user migration is forced reset — moot in
practice because the production user base is **exactly two people (Stefan
and Felix)**, which collapses W2 into a step of W3. Accepted-until-Phase-3
regressions confirmed: polling realtime, in-process triggers with the
orphan-cron safety net. Registry case 3 (all-history ILIKE search) gets its
own OK when W5 reaches it.

Timing context: Felix is unavailable until Sunday 2026-07-26; the W4
hosting-target and License+CLA conversations wait for him. Until then the
work is W1 (Better Auth, uid-preserving) and W3 (migration tooling) plus
the Phase-0 gap tests folded into their acceptance criteria.

## 2026-07-21 — fileConnections flatten merged; matching-engine workstream closed for Phase 1

**Decided by:** Stefan (merge OK on PR #18)

Fifth and final Phase-1 flatten. CI 8/8 green (incl. compose job against
real Postgres + S3) and post-CI adversarial re-review found nothing. With
this, the accepted DO-NOW list from
[`matching-engine-postgres-deletions.md`](matching-engine-postgres-deletions.md)
is complete; everything else in that doc waits for Phase 2, with the doc as
the deletion registry. The workstream handoff is deleted as fulfilled.

## 2026-07-21 — Matching-engine deletions: proposal accepted as written

**Decided by:** Stefan (all three checkboxes in
[`matching-engine-postgres-deletions.md`](matching-engine-postgres-deletions.md))

The per-case inventory is accepted: (1) flatten `fileConnections` out of the
JSONB bridge now — the one code PR from this workstream; (2) all other
Postgres-enabled deletions (chunk loops, anti-join filters, coverage-check
join, searchQuery ILIKE) wait for Phase 2, with the proposal doc as the
deletion registry; (3) `transactionSuggestions` pre-computation and the
orphan cron are keeps. Context: one codebase serves both real Firestore
(prod) and the shim until Phase 2, so SQL joins can't land earlier without a
dual-retrieval seam that isn't worth its testing cost.

## 2026-07-21 — Partners flatten merged; Phase 1 flattening complete

**Decided by:** Stefan (merge OK on PR #17)

Conditional OK ("if the rls.test.ts problem is fixed, merge") — the fix was
already in the reviewed, CI-green commit, so the PR merged as-is. All four
collections (`sources`, `transactions`, `files`, `partners`) are now real
tables; the JSONB `docs` bridge holds only unflattened collections and
subcollections. Next workstream per the 2026-07-20 scope decision:
matching-engine deletions (own handoff).

## 2026-07-21 — Docs changes ship without PR/review

**Decided by:** Stefan

Documentation-only changes (files under `docs/`, handoff hygiene) can be
committed and pushed straight to `main` without a pull request or review.
Code changes keep the full PR → CI → adversarial review → explicit-merge-OK
workflow.

## 2026-07-21 — Human decisions get a persistent audit trail

**Decided by:** Stefan

Human decisions must be recorded in a document under `docs/` (this file).
Rationale: GitHub covers code provenance, but the judgment calls behind the
code lived only in session transcripts and handoff files, which get deleted
once fulfilled.

## 2026-07-21 — CodeQL runs `security-extended` only

**Decided by:** Stefan (merge OK on PR #14)

Dropped the `security-and-quality` suite; kept `security-extended`. The ×166
quality-only alerts auto-closed with the suite switch. A quality-rule cleanup
round remains possible later but is deliberately untracked.

## 2026-07-21 — Keep `getServerUserIdWithFallback` name after auth fix

**Decided by:** Stefan (merge OK on PR #12)

The verify-ID-token fix kept the historical function name to avoid touching
44 API routes in a security PR. The "fallback" in the name is historical;
renaming is optional cleanup, not scheduled.

## 2026-07-20 — Phase 1 flattening scope and order

**Decided by:** Stefan

Flatten collections out of the JSONB bridge in call-site-weight order:
`transactions` → `files` → `partners` (after `sources` proved the harness).
After transactions + files land, start deleting matching-engine code that
Postgres joins make redundant — as a separate, later workstream with its own
handoff. Non-goals confirmed: no Better Auth / shim removal (Phase 2), no
Electric/pg-boss (Phase 3), no schema-per-tenant, no `if (selfHosted)`
branches.

## Earlier foundations (pre-log)

Decisions made before this log existed are recorded in their governing docs:

- Product scope — Austria-only pre-accounting for EPUs; Steuerberater is
  gatekeeper, not buyer; self-host and cloud ship the same features:
  [`who-is-this-for.md`](who-is-this-for.md).
- Rebuild rules — port never regenerate; self-host is multi-tenant with one
  tenant; the API layer owns all DB access; tests before port work:
  [`rewrite-goals.md`](rewrite-goals.md).
- Operational rules — transaction deletion not allowed, server-side scoring
  only, Cloud-Functions-only mutations: [`CLAUDE.md`](../CLAUDE.md).
