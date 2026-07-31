# W4 — fibuki.com cutover runbook

> **Status:** DRAFT — the tooling (W3) is merged and green; the cutover itself
> (W4) is **blocked on Felix** (back 2026-07-26) for the hosting-target
> decision. This runbook is the executable plan for the day that decision
> lands; the env values and host names below are filled in at that point.

Scope and sequencing come from
[`phase-2-rip-the-shim.md`](phase-2-rip-the-shim.md) §W4. The migration
**tooling** this runbook drives is W3:
[`functions/src/selfhost/migrate-export.ts`](../functions/src/selfhost/migrate-export.ts),
[`migrate-import.ts`](../functions/src/selfhost/migrate-import.ts),
[`migrate-cli.ts`](../functions/src/selfhost/migrate-cli.ts), and the
creds-side launcher
[`functions/scripts/export-firebase-dump.ts`](../functions/scripts/export-firebase-dump.ts).

This is **cutover pattern (a)** from the phase-2 decision: a short
**write-freeze → one-shot migration → DNS flip**, no dual-write machinery.
Justified by the invite-only base of exactly two users. The new stack ships to
**`new.fibuki.com`** (subdomain isolation — two auth systems never share an
origin); the flip is DNS/config, not a code change (the shim already runs the
whole product on Postgres — that is what Phase 1 + the parity suites pin).

---

## 0. The split, and why it exists

Firebase Admin credentials must never live on the machine that runs the
selfhost stack, so the migration is two programs joined by a **dump
directory** (the version-1 format in
[`dump-format.ts`](../functions/src/selfhost/dump-format.ts)):

```
  Firebase (creds machine)                 Selfhost host
  ────────────────────────                 ─────────────
  npm run selfhost:export   ──dump dir──▶  npm run selfhost:import
   (real firebase-admin)                   npm run selfhost:verify
                                            (Postgres + S3, via the shims)
```

`export` reads Firebase with the Admin SDK and writes a self-contained
directory. `import`/`verify` run against the selfhost stack and never touch
Firebase. Transfer the directory between them however credentials policy
allows (scp/rsync over SSH, an encrypted volume — the dump contains customer
data; treat it as such and delete it after the soak window).

---

## 1. Preconditions (gate — do not start until all true)

**Target infrastructure is up and reachable** — the four-container stack (or
managed Postgres + app hosts) that Felix specifies, serving `new.fibuki.com`.

**The target starts empty.** `verify` proves the dump is a **subset** of the
target with byte-identical content — it does **not** assert the target holds
nothing else (the compose CI Postgres is shared across suites, so emptiness
can't be an importer invariant). A non-empty target that happens to contain
the dump's ids would pass verify while hiding stale rows. Confirm the tenant
is empty before importing.

**Environment on the selfhost host** (consumed by the shims that `import`
runs through — same variables the running `new.fibuki.com` API uses, so
importing into the live target is configuration-consistent):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection (node-postgres Pool). Unset ⇒ ephemeral in-memory PGlite — **never** for a real cutover. |
| `FIBUKI_AUTH_SECRET` | Better Auth signing secret. `createSelfhostAuth` refuses to start when `DATABASE_URL` is set without it. |
| `FIBUKI_STORAGE=s3` | Select the S3/MinIO blob store (not `memory`). |
| `FIBUKI_S3_ENDPOINT` / `FIBUKI_S3_PORT` / `FIBUKI_S3_SSL` | MinIO/S3 endpoint. |
| `FIBUKI_S3_ACCESS_KEY` / `FIBUKI_S3_SECRET_KEY` | S3 credentials. |
| `FIBUKI_STORAGE_BUCKET` | Target bucket (default `fibuki-selfhost`). |
| `FIBUKI_AUTH_ISSUER` | Public URL of the deployment (also the OAuth redirect base if Google sign-in is enabled). |

**Environment on the creds machine** (for `export`):

| Variable | Purpose |
| --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to the Firebase service-account JSON. |
| `FIREBASE_STORAGE_BUCKET` | Source bucket (or pass `--bucket`). |

**A retained Firebase snapshot** — a frozen Firestore export kept as the
rollback anchor and for the post-cutover soak. Do not decommission the
Firebase project until the soak window closes.

---

## 2. Freeze writes on Firebase

Make the export a consistent point-in-time snapshot: stop all writes to
Firebase before exporting. Put the current fibuki.com in maintenance mode
(or disable the cloud functions that mutate Firestore). With two invited
users this is a brief, coordinated window, not a public outage.

Verify no writers remain (no active sessions mutating data) before continuing.

---

## 3. Export (creds machine)

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
cd functions
npm run selfhost:export -- \
  --dir ./fibuki-dump \
  --bucket <source-bucket>            # or set FIREBASE_STORAGE_BUCKET
```

Defaults: discovers every top-level collection, exports all auth users, and
copies the whole storage bucket. Narrow with `--collections a,b,c`,
`--storage-prefix files/`, or drop a section with `--no-users` /
`--no-storage`. The command prints a summary (collections/docs, users,
objects/bytes) and writes `manifest.json` + `collections/*.ndjson` +
`users.ndjson` + `storage-manifest.ndjson` + `objects/…`.

Sanity-check the printed counts against what you expect (two users; the known
collections) before transferring.

---

## 4. Transfer the dump to the selfhost host

Move `./fibuki-dump` to the selfhost host over an encrypted channel. It
contains customer data — restrict permissions, and delete it from both
machines once the soak window closes.

---

## 5. Import (selfhost host)

Dry-run first — it reads the dump and reports the plan (and surfaces an
unreadable/short dump) without writing anything:

```bash
cd functions
npm run selfhost:import -- --dir ./fibuki-dump --dry-run
```

Then the real import:

```bash
npm run selfhost:import -- --dir ./fibuki-dump
```

What it does (see [`migrate-import.ts`](../functions/src/selfhost/migrate-import.ts)):
docs land through the ordinary shim write path (`DocRef.set` upsert), so
flattened generated columns + canonical JSONB + `tenant_id` come out identical
to organically-written data; users go through `provisionUser` (uid-preserving,
**passwordless** — migrated users get a forced reset, never a working
credential); objects replay to their **verbatim** Firebase paths so every
stored-path reference in migrated docs keeps resolving. The import is
**idempotent** — re-running converges (upserts + object put-overwrite), so a
partial run is safe to repeat.

---

## 6. Verify — the gate

```bash
npm run selfhost:verify -- --dir ./fibuki-dump ; echo "exit=$?"
```

`verify` re-reads every dump entry against the target: per-doc deep-equal in
wire space, per-user presence, per-object md5 vs the manifest. **Proceed only
on exit code 0.** Non-zero prints exactly what diverged:

- exit `1` — something is `missing`, `mismatched`, or `checksumFailures`; the
  report lists the offending ids/paths. Investigate, re-run import if it was
  partial, re-verify. Do **not** flip DNS on a failed verify.
- exit `2` — usage error (bad `--dir`), not a data verdict.

As a second gate, the compose CI suite should be green against a **staging
copy** of this migrated data before the production flip.

---

## 7. Cutover (DNS flip) and smoke test

With verify green:

1. Point fibuki.com (or promote `new.fibuki.com`) at the selfhost API.
2. Smoke-test on the live target: sign in as each user (password reset flow,
   since migrated users are passwordless), load transactions, open and
   **download a receipt** (exercises the storage import + verbatim paths and
   the `/__storage/download` URL rewrite), and confirm the cron host is
   running its schedules.

**Accepted regressions until Phase 3** (do not treat as cutover failures):
realtime becomes polling (`onSnapshot` → poll), and trigger delivery is
in-process with the orphan-cron as the crash-recovery net.

---

## 8. Rollback

Until the DNS flip, rollback is trivial: unfreeze Firebase, the old stack is
untouched. After the flip, if a blocking issue surfaces during the smoke test,
flip DNS back to Firebase and unfreeze — the retained snapshot means no data
was lost (the selfhost target was write-frozen too until users arrive). Keep
the frozen Firestore export until you are confident.

---

## 9. Decommission (after soak)

Only after a soak window with the frozen Firebase export retained: decommission
the Firebase project, revoke the service-account key used for export, and
delete the dump directory from both machines.

---

## Open carry-overs that touch the cutover

From the W1 review (tracked in the W3 impl brief §W1 carry-overs) — decide
whether each is fixed before the flip or accepted for the two-user window:

- Google/social sign-in path has zero test coverage; it is also the migration
  path for the Google-sign-in user.
- Non-invited Google users fail silently (no "access requested" banner).
- The login page's GitHub button is a dead control under selfhost.
- Mid-pickup reload can strand a live server session.
