# FiBuKI rebuild — goals and constraints

> **Status:** Agreed 2026-07-17 by Felix and Stefan. Supersedes the "move to
> Supabase" idea. Read [`who-is-this-for.md`](./who-is-this-for.md) first — the
> product focus is what justifies all of this.

## The goal in one paragraph

Take FiBuKI off Firebase and onto a stack with no vendor in it, so that the same
codebase runs as a cloud product we host and charge for, and as an open-source
product anyone can run themselves. Self-host and cloud are the **same code with
different config** — not two products, not two branches.

## The one architectural idea

**Self-host is multi-tenant with one tenant.**

Same schema, same `tenant_id` column, same enforcement path. Self-host just always
has exactly one tenant. There is no second code path, no `if (selfHosted)` branch
in business logic. If you find yourself writing one, the design is wrong.

This only works because **we own the API layer**. The client never talks to the
database. That single decision is what makes the database, storage, auth, and
deployment topology swappable underneath. It is load-bearing — protect it.

## Port, not rewrite

This is the constraint most likely to be violated, so it goes near the top.

**The domain logic is the company.** The matching engine, extraction, BMD export,
capital-gains logic, reconciliation — that's years of edge cases discovered from
real Austrian accounting data, most of which are documented nowhere except in the
code. Firebase coupling is not the company.

- **Port** the infrastructure. Replace the coupling.
- **Refactor** domain logic where Postgres makes it simpler (a lot of the matching
  engine exists *because* Firestore can't join — that code should shrink).
- **Never regenerate** domain logic from scratch, with an LLM or otherwise.

The proof this works already exists: the `selfhost/spike` branch runs FiBuKI on
Postgres with **98 frontend files importing `firebase/*` completely unmodified**.
The infrastructure came out without the domain logic moving. That's the whole
thesis, already demonstrated.

### On using an LLM for this

LLMs make writing code cheap. They do not make *knowing what the code should do*
cheap. Use one for the mechanical transformation — Firestore calls to Drizzle
queries — which is exactly what they're good at and which tests can verify. Do not
use one to regenerate logic that has no tests. It will produce confident, plausible
code that's subtly wrong on the edge cases nobody wrote down.

**Tests first. Then the LLM.** Not negotiable — see Phase 0.

## The stack

| Layer | Choice | Why | Escape hatch |
|---|---|---|---|
| **DB** | Postgres, plain | The data is relational. Firestore was always the wrong fit. | Any Postgres: local, RDS, Neon, Supabase |
| **Query** | Drizzle | TS-native, migrations are readable SQL, no engine binary | It's just SQL |
| **API** | Hono on Node 22 | Light, portable across runtimes | Plain HTTP |
| **Auth** | Better Auth, OIDC pluggable | Lives in the app, stores in our Postgres, **no auth container**. Org plugin gives multi-tenancy primitives. | OIDC means self-hosters can plug Authentik/Keycloak/Entra |
| **Storage** | S3 API | MinIO or Garage self-host, any S3 in cloud | The API *is* the abstraction |
| **Jobs** | pg-boss | Postgres-backed queue. **No Redis.** Transactional with the data. | Graphile Worker |
| **Realtime** | ElectricSQL | Apache-2.0, one container, reads the WAL, syncs reads. Writes still go through our API. | LISTEN/NOTIFY + own WebSocket |
| **AI** | Provider interface | Same pattern as the existing MailProvider seam | BYO key, or local Ollama |

Result: `docker compose up` gives you postgres, storage, app, electric. **Four
containers, whole product.**

### Why not Supabase

Supabase's value is PostgREST + RLS — the client talks to the DB directly, auth
enforced by row policies, thin API. FiBuKI is the opposite shape: ~112 callables of
real business logic. That logic does not go into row policies.

Using Supabase non-idiomatically (just hosted Postgres + auth + storage) means
paying vendor coupling for ~30% of the product. And going idiomatic costs more:
Edge Functions are Deno (a second runtime, which *breaks* the self-host/cloud
parity that's the entire point), and self-hosted Supabase is ~10 containers against
our four.

**Supabase remains a fine deploy target** — it's Postgres. It is not the
architecture.

### Realtime

ElectricSQL's recommended pattern is: sync reads through Electric, writes through
your own API. That's exactly FiBuKI's shape. It's a sync layer over Postgres we
already own, not a framework we build into — remove it and we're back to polling,
nothing else breaks.

It's also strictly better than what Firestore gave us: `onSnapshot` was
server-push, Electric gives local-first and offline-capable. For a tool people use
on bad café wifi, "works offline, syncs later" is a product feature.

**Risk:** Electric is young and has had a v1 rewrite. Mitigated by it being
read-sync only, with polling as a proven fallback (we're running it today).

## Multi-tenancy

**Shared schema, `tenant_id` on every table, API enforces, RLS as backstop.**

RLS is not the mechanism — we own the API, so that's the enforcement point. But
for tax data, where a cross-tenant leak is existential, RLS is a seatbelt worth
wearing: `set local app.tenant_id` per transaction, policies as defense in depth.
Drizzle supports it.

Schema-per-tenant and DB-per-tenant both look tempting and both bite at migration
time. Don't.

## The cloud/self-host split

**Same features. Different effort.** This is a rule, not a guideline.

| | Self-host | Cloud |
|---|---|---|
| Features | All of them | All of them |
| OAuth apps | Bring your own | We did the verification + CASA |
| Bank connections | Your finAPI contract | Ours |
| AI models | Your key, or local Ollama | Included |
| Compliance | Yours | Ours |

The moat is real work already done (see `docs/casa/`), not a crippled build. Any
proposal to gate a *capability* behind the cloud tier violates this and should be
rejected.

The existing **IMAP provider is core to this**, not a side feature: self-hosters
can't realistically get Gmail `gmail.readonly` verified (restricted scope, Google
security review, CASA assessment). IMAP is the open-source ingest path.

## License

**AGPL-3.0 + CLA.**

- AGPL stops someone hosting FiBuKI-as-a-service against us.
- The CLA lets us dual-license: sell a commercial license to anyone whose legal
  department won't touch AGPL, and keep cloud-only infrastructure proprietary.

**The CLA must be in place before the first external contributor.** Without it we
can never relicense without tracking down every contributor for sign-off. This is
the only decision here with a hard expiry.

## Phases

Each phase ships independently. No flag day.

### Phase 0 — safety net (before any port work)

This phase is the whole argument. Everything after it is unsafe without it.

- ✅ **Characterization tests on domain logic** *(done 2026-07-17)* — BMD export,
  matching engine, extraction; real bugs pinned on purpose (billing-cycle 12→14
  relabel, stateful `/g`-regex IBAN classifier, unanchored suffix-strip in
  transactionScoring).
- ✅ **Selfhost suite wired into CI** *(done 2026-07-17)* — `test:selfhost` npm
  script + `functions-selfhost` CI job (PGlite).
- ✅ **Compose-backed CI job** *(done 2026-07-17)* — `functions-selfhost-compose`
  runs the same suite against real Postgres + MinIO
  (`deploy/selfhost/docker-compose.ci.yml`), sequential because the workers share
  one `docs` table.
- ✅ **Firestore-API parity test** *(done 2026-07-17, green 2026-07-19)* —
  `functions/src/test/firestore-parity.test.ts`, same assertions against
  `firebase-admin` (emulator, `firestore-parity` CI job) and the shim. Scope
  derived from app call sites. It caught the cursor gap below plus two classes of
  real production bug (undefined-value writes — fixed 2026-07-19 — and a missed
  `__name__`/documentId filter call site).
- **License + CLA.** *(open)*

Known coverage gaps still to close: `gmailSyncQueue.ts:244-307` (the provider
fork), and the long tail of the 61 `app/api/*` routes — a first auth-smoke
slice (6 routes + the `get-server-user` helpers, own CI job) landed with the
W1 spec (PR #19, 2026-07-21), but there is still no test runner at the repo
root (the smoke profile borrows the functions runner via
`functions/vitest.api-smoke.config.ts`). **Closed 2026-07-21:**
`lib/selfhost/auth-client.ts` (was 858 LOC, zero tests) — surface
characterization + W1 xfail acceptance in
`functions/src/selfhost/auth-client.test.ts`.

**Shim cursor gap — CLOSED 2026-07-19.** Found 2026-07-17 on CT 999:
`firestore-shim.ts` implemented no `startAfter`, but `tools/handlers.ts:228` and
`precisionSearchQueue.ts:1953` call it — under selfhost these threw. The shim now
implements `startAfter(docSnapshot | values)` with Firestore's implicit `__name__`
tiebreak (plus `__name__` equality/`in` filters), pinned by the parity suite
against the real SDK. The lesson stands: the shim had only been asserted against
its own intended behavior, and the parity suite is exactly the instrument that
catches this class. The current implementation filters in JS like the rest of the
shim — efficient SQL cursor pushdown still belongs to Phase 1.

### Phase 1 — schema

Drizzle, `tenant_id`, flatten collections **behind the existing shim interface**.
The shim is the migration harness — that's its entire purpose. Collection by
collection, app code doesn't notice. Delete matching-engine code that Postgres
makes redundant.

The current shim stores docs as JSONB in one `docs` table and filters **in JS**
(`firestore-shim.ts:447`). Fine for one user. **Fatal for multi-tenant** — no
indexes, no pushdown. It is a bridge, not a destination.

Progress *(2026-07-21)*:

- ✅ **Drizzle + migration infra** — schema in
  `functions/src/selfhost/db/schema.ts`, readable SQL migrations under
  `functions/drizzle/` (authored by `npm run db:generate`), applied at boot by
  `db/migrate.ts` through ONE code path for embedded PGlite and node-postgres.
  Phase-0 spike databases (docs table without tenant_id) are adopted and
  backfilled automatically and idempotently.
- ✅ **tenant_id everywhere + RLS backstop** — `tenants` table, `tenant_id` on
  every data table, every document read/write inside a transaction that does
  `SET LOCAL ROLE fibuki_app` + `set_config('app.tenant_id', …, true)`.
  Policies use FORCE RLS **and** a dedicated non-superuser app role — PGlite
  and the docker-image postgres user are superusers, whom RLS never binds, so
  role-switching is what makes the seatbelt real (pinned by `db/rls.test.ts`).
- ✅ **SQL pushdown** — filters/orderBy/startAfter-keysets/limit compile to SQL
  against flattened tables (`db/pushdown.ts`). Contract: compiled WHERE is a
  superset, the JS pipeline (parity-pinned) re-verifies returned rows; LIMIT
  is pushed only when everything compiled exactly. A differential suite
  (`db/pushdown.test.ts`) pins table path ≡ JSONB path per query shape.
- ✅ **First collection flattened: `sources`** — real table, STORED GENERATED
  columns over the canonical JSONB payload (indexable/joinable, and
  absent-vs-null document semantics survive the bridge era; Phase 2 turns
  them into plain columns and drops the payload). App code unchanged.
- ✅ **`transactions` flattened** *(2026-07-21, PR #15)* — 12 generated
  columns from an inventory of all 175 call sites; first heavy user of the
  timestamp keyset-cursor path (the `tools/handlers.ts` listTransactions
  shape pushes LIMIT with a desc timestamp keyset). `searches`/`history`
  subcollections stay in `docs` via existing generic routing.
- ✅ **`files` flattened** *(2026-07-21, PR #16)* — 15 generated columns from
  an inventory of all ~125 call sites (incl. the `FILES_COLLECTION` alias in
  `email-inbound/receiveEmail.ts` a literal grep misses). New pinned pushdown
  shapes: the stale-scan's `<`-only range ordered ASC on the same field
  (json-null rows under a pushed LIMIT via NULLS FIRST), JS-side null
  equality withholding LIMIT, and `!= null` staying JS-side entirely.
  `transactionSuggestions` stays payload data, not a column.
- ✅ **`partners` flattened** *(2026-07-21, PR #17 — last collection)* — 4
  generated columns (`userId`, `isActive`, `globalPartnerId`, `name`) from an
  inventory of all ~93 call sites; every query shape was already pinned by
  the sources suite, so the pushdown differential gained nothing (a valid
  outcome the handoff predicted). The `partnerType` ternaries are doc-by-id
  only and `globalPartners` stays in `docs`. `db/rls.test.ts` lost partners
  as its "unflattened" representative twice over — `categories` took both
  roles, and the RLS loops now cover the `partners` table directly.
- ✅ **Matching-engine deletions workstream closed for Phase 1**
  *(2026-07-21)* — investigation found nearly all Postgres-enabled deletions
  are Phase-2-gated by the one-codebase/two-backends constraint;
  [`matching-engine-postgres-deletions.md`](matching-engine-postgres-deletions.md)
  is the accepted per-case registry Phase 2 starts from. The Phase-1-sized
  piece shipped: **`fileConnections` flattened** (PR #18, fifth and last
  flatten) — 5 generated columns, first collection whose Firestore name
  differs from its table name (routing + backfill pinned in `rls.test.ts`).

### Phase 2 — rip the shim

Remove the Firestore API surface entirely. Better Auth + migration of existing
fibuki.com users off Firebase Auth (identity mapping, password reset or OAuth
re-link — real work, don't hand-wave it).

### Phase 3 — the new capabilities

Electric (realtime), pg-boss (retire the Firestore-collection queue + node-cron),
cloud tier, billing.

## Deployment during the transition

New version ships to a **subdomain** (`new.fibuki.com`), not a path
(`fibuki.com/new`). Path-routing two auth systems on one origin means shared cookie
scope, CSP knots, and a real security surface. A subdomain gives clean isolation
for free.

Be honest about which pattern this is: if the new version has separate data, it's a
v2 with a migration cliff, not a strangler fig. That's a legitimate choice — but
name it, because it determines whether dual-write is needed.

## What this does not fix

Stated plainly so nobody mistakes the rebuild for progress on the business:

**The stack was never the bottleneck.** No customer will ever notice it. The
competition (BMD, sevDesk, lexoffice, FreeFinance) doesn't lose deals over their
database — they compete on tax-compliance depth and Steuerberater trust.

The rebuild is justified by three things and no others:

1. **You cannot open-source on Firebase.** Nobody can `git clone && docker compose
   up` against a Firebase project. The open-source goal is impossible without it.
2. **Firestore can't join.** Postgres lets us delete code.
3. **Firebase cost curves** on a read-heavy accounting app are a margin problem.

Those are sufficient. "The new stack is better" is not. Don't let the rebuild
become the thing we do instead of finding customers.
</content>
</invoke>
