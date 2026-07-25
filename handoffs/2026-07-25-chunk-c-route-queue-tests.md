# Chunk C — Phase-0 route + queue test gaps — implementation brief

**Goal:** close the last two pre-cutover test gaps from the hardening brief —
functional coverage over the `app/api/*` routes that carry the cutover, and the
untested `gmailSyncQueue` provider fork — so the W4 flip happens on tested code
rather than known-soft paths. Off the W4 critical path (that's Felix's hosting
decision); this is the "make the two-user cutover safe" work that can land while
W4 is blocked.

**Status when written (2026-07-25):** Chunks A and B of the hardening brief are
**done and merged** — main @ `fa111a2f`:
- A: auth test coverage + deferred LOWs (PR #31).
- B-3: social callback marker ordering (PR #32).
- B-2: dead GitHub button gated under self-host (PR #33).
- B-1: access-request parity for non-invited social sign-in (PR #34).

Chunk C is the recommended next (and final hardening) chunk. W4 stays blocked
on Felix (back 2026-07-26).

**Read first:**
- `handoffs/2026-07-22-pre-cutover-hardening.md` — the parent brief this
  completes (its section C is the source of the two items below). This file
  supersedes that one for the remaining scope; delete the parent once C lands.
- `docs/phase-2-rip-the-shim.md` "Phase-0 gates that predate any cutover".
- `docs/w4-cutover-runbook.md` — where these gaps show up at flip time.
- Source: `functions/src/api-smoke/auth-routes.test.ts` (the existing 401-only
  slice + its harness), `functions/vitest.api-smoke.config.ts`,
  `functions/src/gmail/gmailSyncQueue.ts` (the provider fork, L244–307).

## Scope — two PR-sized sub-chunks

### C1. `app/api/*` functional smoke suite
W1 (#24) added a **401-contract** slice — `functions/src/api-smoke/auth-routes.test.ts`
proves 6 representative routes answer `401 {"error":"Unauthorized"}` (no
internal text) when unauthenticated. This chunk adds the **functional** layer
the cutover actually rides on: for the data-plane / auth-swap routes, an
**authenticated happy path** and **owner-scoping** (user A cannot read/act on
user B's data).

- Extend the existing `api-smoke` profile (`functions/vitest.api-smoke.config.ts`,
  include `src/api-smoke/**`). It runs the REAL Next handlers with `@/` mapped
  to the repo root.
- Pick the routes that carry the cutover — the data-plane reads/writes and the
  ones sitting directly on `lib/auth/get-server-user.ts`. Start with the highest
  blast-radius handlers (the 44 that authenticate via that seam; the auth-verify
  investigation of 2026-07-21 measured the set).
- Each route: (a) a valid token → happy-path 2xx over a seeded fixture; (b) a
  token for a different owner → 403/404/empty (never another tenant's row).
  Owner-scoping is the property most likely to silently regress across the
  Firebase→shim swap, so it's the point of the suite.
- **Host note:** the api-smoke profile needs the **root** `node_modules` (next,
  firebase-admin), which is empty on the audit box — you cannot run this profile
  locally here. Write the tests and verify via the **"App API routes (auth
  smoke)"** CI job. (C2 below runs under the functions profile and *can* run
  scoped locally.)

### C2. `gmailSyncQueue` provider fork (L244–307)
`processQueueItem` forks on `integrationData.provider`:
- **`imap` leg** (L246–271): decrypt the stored app-password, `makeProvider("imap", …)`
  with host/port/mailbox config — no OAuth, no refresh. This is the
  self-host-friendly mail path.
- **`gmail`/OAuth leg** (L272–306): token expiry check → `refreshAccessToken`
  (success updates the token; failure sets `needsReauth` + throws) →
  `makeProvider(gmail, { accessToken })`. This is the cloud path.

Neither leg is tested. Cover both before real users hit them on the new stack:
- imap leg: missing secret / missing host-or-user → the specific throws; happy
  config → `makeProvider("imap", …)` gets the decrypted password + config.
- gmail leg: token still valid → no refresh; expiring token + refresh success →
  provider built with the new access token; refresh failure → integration
  marked `needsReauth` and it throws.
- Stub `makeProvider` / the mail provider and the crypto so the test pins the
  fork's *decisions*, not a live IMAP/Gmail connection.
- Runs under the functions profile (`functions/node_modules` exists) — scoped
  local runs are fine here.

## Non-goals
- The W4 cutover itself (Felix-blocked), W5/W6 shim teardown, Electric/pg-boss
  (Phase 3), License + CLA (separate human decision).
- A root-package test runner — still an open Phase-0 item; keep borrowing the
  functions runner via `vitest.api-smoke.config.ts` (documented there).
- Rewriting routes to Drizzle — coverage only, not the "rip".

## Guardrails
- Host safety (6 GiB box): scoped runs only. The **guard hook matches command
  TEXT**, so any command mentioning the test-runner name without a worker cap is
  blocked — keep the literal out of shell one-liners you don't intend to run,
  and use the scoped form:
  `npx <runner> run <file> --config <cfg> --pool=forks --maxWorkers=1`.
  Scoped `tsc` via `NODE_OPTIONS=--max-old-space-size=900 … --ignoreConfig`.
  Pass commit messages via `-F`/`--body-file`. Root `node_modules` is empty —
  C1 can't run locally (CI only); C2 can. Max 2 concurrent sub-agents.
- Tests-first (rewrite-goals). Characterization suites pin real behavior — port,
  never regenerate; never "fix" a pinned value without Stefan.
- Branch from `main`; small conventional commits; CI-green AND adversarially
  reviewed before asking to merge; merge only on Stefan's explicit go-ahead (do
  not self-merge). Docs-only changes go straight to `main`. GitHub remote is
  `fork`; push via `git push fork`.
- C1 and C2 are independent — separate PRs, either order. Neither touches the
  auth surface Chunk A/B changed, so no rebase interplay expected.

## On completion — notify Felix (deferred; Stefan's call)
The parent brief's completion step still stands but is **explicitly deferred**
(Stefan, 2026-07-25 — "no email to Felix yet"). Once C lands and Stefan says go,
send the prepared status email so Felix can act on the hosting decision:
  - From: homelab@syh.at · To: felixtosh@gmail.com · Cc: stefan@syh.at
  - Subject: "FiBuKI self-host is ready for cutover — need your call on hosting"
  - Content: what's done (Phase 1 / W1 / W3 + the A/B/C hardening), and his two
    asks — DECIDE the cloud hosting target (blocks W4), DO the creds-side
    `selfhost:export`; plus License+CLA timing with Stefan.
Note: the Gmail connector only exposes create_draft (no send) — draft it in the
homelab@syh.at account for Stefan to send, or Stefan sends direct.
