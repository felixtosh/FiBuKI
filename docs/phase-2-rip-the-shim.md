# Phase 2 — rip the shim: kickoff proposal

> **Status:** ACCEPTED 2026-07-21 by Stefan (in-session, Felix on-board;
> logged in [`decisions.md`](decisions.md)). Case-3 OK stays deferred to W5.
> Load-bearing fact learned at acceptance: **the user base is exactly two**
> (Stefan and Felix), which shrinks W2 to a step inside W3. Felix is
> unavailable until Sunday 2026-07-26 — W4's hosting decision waits for him;
> W1/W3 and the Phase-0 gap tests don't.

Scope per [`rewrite-goals.md`](rewrite-goals.md): remove the Firestore API
surface entirely; Better Auth + migration of existing fibuki.com users off
Firebase Auth. This doc turns that one paragraph into ordered, PR-sized
workstreams and names the decisions that need a human.

## The sequencing is forced: cutover first, teardown second

The naive reading of "rip the shim" — rewrite the 177 functions files that
speak the Firestore API to Drizzle, then move production — is impossible
without a flag day. The moment shared code speaks SQL instead of the
Firestore API, it can no longer run against real Firestore, so production
would have to jump to the new stack in the same instant the rewrite lands.
`rewrite-goals.md` rules that out ("Each phase ships independently. No flag
day").

The other order works and is strangler-safe:

1. **Make the selfhost stack production-ready** — real auth (the current
   `auth-shim.ts` is a 53-line synthetic single-user stub), user migration,
   data/storage migration tooling.
2. **Cut fibuki.com over to the Postgres stack with the code unchanged.**
   The shim already runs the entire product against Postgres — that is what
   Phase 1 built and what the parity + pushdown + chain suites pin. The
   cutover diff is config and deployment, not code.
3. **Then rip the shim incrementally.** Once nothing runs on real Firestore,
   the one-codebase/two-backends constraint dissolves. Retrieval code gets
   rewritten to Drizzle subsystem-by-subsystem, executing the accepted
   [deletion registry](matching-engine-postgres-deletions.md), with the
   characterization suites still pinning behavior throughout.

Consequence worth stating plainly: **fibuki.com runs on the shim for a
while.** That is fine — it is exactly the "multi-tenant with one tenant"
architecture with more tenants, the JSONB-bridge scaling concern is already
addressed for every hot collection (all five are flattened + indexed), and
the parity suite exists precisely to make the shim trustworthy.

## Workstreams

Each is its own handoff + PR series, in dependency order. W1–W3 are
pre-cutover, W4 is the cutover, W5–W6 are post-cutover. Per practices, each
workstream starts with a spec + xfail acceptance suite before implementation.

### W1 — Better Auth (server + client)

Replace `functions/src/selfhost/auth-shim.ts` (synthetic) and
`lib/selfhost/auth-client.ts` (858 LOC, zero tests — a named Phase-0 gap;
tests come first, closing it) with Better Auth: sessions in our Postgres,
org plugin for the tenancy primitives, OIDC pluggable so self-hosters can
front it with Authentik/Keycloak/Entra. The client keeps the
`firebase/auth`-shaped surface the 151 aliased frontend files expect —
same module-resolution trick, zero app-code changes. Invite-only
registration (`allowedEmails`) and admin claims ports onto Better Auth
equivalents.

**Critical constraint: preserve Firebase uids as Better Auth user ids.**
`userId` is denormalized onto essentially every document; minting new ids
would mean rewriting every row during migration. Better Auth accepts
caller-provided ids — use them.

### W2 — Firebase Auth user migration

Real work, not hand-waved, but small: registration is invite-only, so the
user base is enumerable and tiny. Identity mapping is uid-preserving (W1).
Per sign-in method:

- **Google Sign-In users** — no secret to migrate. Sign in with Google via
  Better Auth's social provider on the new stack; account matches by
  email → linked to the migrated user row with the preserved uid.
- **Email/password users** — two options, decision below:
  - *(a) Password-hash import:* `firebase-tools auth:export` emits the
    modified-scrypt hashes + params; Better Auth supports custom password
    hashers, so a verify-then-rehash-on-first-login adapter is possible.
    Most seamless, most code, crypto-adjacent code we then own.
  - *(b) Forced reset:* migrate the accounts without secrets; first login
    on the new stack sends a password-reset email. One-time friction per
    user, zero imported crypto. **Recommended** at this user-base size.

### W3 — Data + storage migration tooling

One-shot, idempotent, resumable importers, dry-runnable against a staging
tenant:

- **Firestore → Postgres:** export via the Admin SDK, write through the
  existing shim write path so the canonical JSONB + generated columns +
  `tenant_id` come out identical to organically-written data (the
  `wire-values` codec and the migrate-time backfill machinery already
  exist). Every migrated user lands as a tenant in the same schema.
- **Firebase Storage → S3:** object copy keyed by the same paths
  `blobstore-s3.ts` already serves; verify by count + spot checksums.
- **Verification gate:** per-collection row counts + sampled deep-equals
  between source and target, and the compose CI suite green against a
  migrated staging copy, before any cutover.

### W4 — Cutover of fibuki.com

- New stack ships to **`new.fibuki.com`** (subdomain isolation per
  `rewrite-goals.md` — two auth systems never share an origin).
- **Pattern named honestly:** this is a v2 with separate data, i.e. a
  migration cliff, not a strangler fig. With an invite-only base the
  recommended shape is *(a)* **short write-freeze + one-shot migration +
  DNS flip** — no dual-write machinery. Alternative *(b)* is per-user
  staged migration (users flip in cohorts), which buys gradualness at the
  cost of running two live systems and a partial-state support burden.
- **Accepted regression until Phase 3:** realtime becomes polling
  (`onSnapshot` → poll is the client shim's proven mechanism; Electric is
  Phase 3). Trigger delivery is in-process with the orphan-cron as the
  crash-recovery net (pg-boss is Phase 3) — registry case 9 already keeps
  that cron on purpose.
- Firebase project decommission only after a soak window with a frozen
  Firestore export retained.
- **Infra prerequisite (Felix):** where cloud production runs — a host for
  the four-container compose (or managed Postgres + app hosts). Not a
  this-repo decision; flagging early because W4 blocks on it.

### W5 — Shim teardown + deletion-registry execution

Post-cutover, the actual "rip": subsystem-by-subsystem, each PR replacing
Firestore-API call sites with Drizzle against the flattened tables, deleting
shim surface as it loses its last caller, characterization suites pinning
scoring/decision logic byte-for-byte throughout. The accepted registry
supplies the matching-engine list: cases 1, 4, 5, 6, and 9's JS
flag-filtering become joins/exact predicates; case 3 (searchQuery → ILIKE)
gets its own OK when reached because it changes the candidate set.

Order within W5: start where the registry already names the shapes (matching
+ analytics retrieval), then the long tail of callables, then the shim files
themselves (`firestore-shim.ts`, `data-plane.ts` reroutes to Drizzle-backed
reads, parity suite retires with the API it pinned). Endgame per
`rewrite-goals.md`: generated columns become plain columns and the JSONB
payload drops.

### W6 — Relation reconciliation + single-table cutover (registry cases 4/7)

After cutover, in SQL: backfill legacy arrays-without-connection-docs into
`file_connections` rows, verify the three representations agree, then make
`fileConnections` the source of truth with the arrays as derived data.
Prerequisite for every anti-join rewrite in W5's matching chunk; dropping
the arrays entirely still waits for Electric-era reads (Phase 3), as the
registry records.

## Phase-0 gates that predate any cutover

Open items from `rewrite-goals.md` Phase 0 that gate W4, restated so they
land in a workstream instead of a footnote:

- **61 `app/api/*` routes, zero tests** — the data plane and auth swap sit
  under these routes; a smoke-level suite is part of W1/W3 acceptance.
- **`gmailSyncQueue.ts:244-307` provider fork** — untested branch that
  differs per backend; test before it runs on the new stack for real users.
- **License + CLA** — gates open-sourcing, not cutover; must exist before
  the first external contributor. Independent of W1–W6, needs a human
  decision on timing.

## Decisions requested from Stefan

- [x] **Sequencing:** cutover-first strangler order as laid out (W1–W3 →
      cutover → teardown). The alternative (rewrite-then-cutover) is a
      flag day; recommended: as laid out.
- [x] **Auth migration for password users:** (b) forced reset — moot in
      practice, the user base is two people.
- [x] **Cutover pattern:** (a) short write-freeze + one-shot migration +
      DNS flip, no dual-write.
- [x] **Confirm accepted regressions until Phase 3:** polling realtime,
      in-process triggers with cron safety net.
- [x] **Registry case 3** (search moves from 1000-most-recent to
      all-history ILIKE): ask again when W5 reaches it.
- [ ] **Raise with Felix (when back, Sunday 2026-07-26):** cloud hosting
      target for the four-container stack (blocks W4), and License + CLA
      timing.
