# Chunk C — pre-cutover route + queue test gaps: DONE (outcome record)

Chunk C shipped 2026-07-25, closing the last two pre-cutover test gaps from the
hardening brief so the W4 flip lands on tested code rather than known-soft
paths. Both PRs were CI-green and adversarially re-reviewed before merge; merged
to `main` on Stefan's explicit go-ahead.

- **C2 — PR #35** (`5c8c6d8a`): `gmailSyncQueue` provider fork now covered.
  The fork `processQueueItem` runs before touching a mailbox was extracted
  **verbatim** into an exported `resolveMailProvider` (behaviour-preserving — the
  extraction sits before the `try` block, so failure semantics are unchanged:
  a throw propagates to the trigger wrapper without entering the retry-catch and
  without `provider.close()`). 10 characterization tests
  (`functions/src/gmail/__tests__/gmailSyncQueue-provider-fork.test.ts`) pin both
  legs — imap (missing secret / missing host-or-user throw; happy config builds
  with the decrypted password + connection config) and gmail/OAuth (valid token
  skips refresh; expiring + refresh success builds with the new token; refresh
  failure and downgraded-scope grant mark `needsReauth` and throw). Runs under
  the functions profile; scoped local runs fine.

- **C1 — PR #36** (`80f488c0`): functional owner-scoping smoke over the
  data-plane routes that carry the cutover. W1 pinned the 401 contract; C1 adds
  the happy-path 2xx **and** owner-scoping (user B never reads/acts on user A's
  row — the property most likely to silently regress across the Firebase→shim
  auth swap). Five routes: `POST gmail/pause`, `POST gmail/resume`,
  `GET`+`POST gmail/sync`, `POST sources/[id]/disconnect`. Each runs the real
  Next handler with identity stubbed at the auth seam (token-verify itself stays
  covered by `auth-routes.test.ts`) against a real in-memory data plane. 42
  tests total (route suite + a 17-test self-test of the harness).

## Notes for the next session

- **The api-smoke route suite is CI-only.** It imports the real Next handlers,
  which need the root dependency tree (next, firebase-admin) — empty on the audit
  box. Verify via the **"App API routes (auth smoke)"** CI job. The in-memory
  Firestore double (`functions/src/api-smoke/fake-firestore.ts`) is
  dependency-free and its self-test (`fake-firestore.test.ts`) DOES run locally
  under the api-smoke profile, so the route suite's owner-scoping assertions
  can't pass on a broken harness.
- **Two wiring gotchas surfaced by CI** (now fixed, worth knowing if extending
  the suite): the gmail routes capture `const db = getAdminDb()` at module load,
  so the suite must share ONE `FakeFirestore` and `reset()` between tests, not
  recreate it. And `vi.mock("firebase-admin/firestore")` does **not** intercept
  the route's copy — route (repo root) and test (functions/) resolve
  firebase-admin to different physical trees — so the suite uses the real
  Timestamp/FieldValue and asserts observable state, not sentinel internals.
- **Coverage only, not the rip.** These are characterization suites — port,
  never regenerate; do not "fix" a pinned value without Stefan.

## Deferred completion step — the Felix email (Stefan's call)

Still explicitly deferred (Stefan, 2026-07-25 — "no email to Felix yet"). Once
Stefan says go, send the prepared status email so Felix can act on the hosting
decision that blocks W4:
- From: homelab@syh.at · To: felixtosh@gmail.com · Cc: stefan@syh.at
- Subject: "FiBuKI self-host is ready for cutover — need your call on hosting"
- Content: what's done (Phase 1 / W1 / W3 + the A/B/C hardening), and his two
  asks — DECIDE the cloud hosting target (blocks W4), DO the creds-side
  `selfhost:export`; plus License+CLA timing with Stefan.
- The Gmail connector only exposes `create_draft` (no send) — draft it in the
  homelab@syh.at account for Stefan to send, or Stefan sends direct.
