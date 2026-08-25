# Standing up FiBuKI on Hetzner

> **Status.** The migration this document was written for is done. The web host is
> **`fibuki.com`**; `new.fibuki.com` served the stack during the cutover and now only
> redirects to the apex. The API host is still **`new-api.fibuki.com`** and stays that
> way on purpose — see the decision at the end of this page. Read the DNS and host names
> below as *your* deployment's names.

## Current deployment

| | |
|---|---|
| Host | `fibuki-selfhost`, `cpx32` (4 vCPU / 8 GB / 160 GB), `nbg1` Nuremberg |
| Ingress | Caddy only. Let's Encrypt certs for both names, auto-renewing |
| Auth | Built-in Better Auth, endpoints at `/__auth` |
| Inventory | 112 callables, 8 request functions, 12 scheduled jobs, 50 excluded |
| Backups | Hetzner server snapshots on. **`backup.sh` not yet installed as cron** |

`cpx32` rather than the `cx33` this document's provisioner defaults to: the whole
CX and CAX lines were out of capacity in every EU location. `cx33` is ~EUR 8.49/mo
against `cpx32`'s ~35.49, so it is worth revisiting when capacity returns. That
means a rebuild rather than a rescale, since Hetzner cannot shrink a 160 GB disk
to `cx33`'s 80 GB.

**Outstanding before migration:** `FIBUKI_SMTP_PASS` is still a placeholder, so
there is no outbound mail. That gates the cutover, because the importer creates
migrated users passwordless and they recover via a password-reset email.


Concrete deploy for the stack in [`README.md`](README.md). Read
[`../../docs/w4-cutover-runbook.md`](../../docs/w4-cutover-runbook.md) first: this
covers steps 1 and 7 of it (target infrastructure, and the smoke test), not the
data migration in between.

Nothing here touches production `fibuki.com`. The new stack lives on its own
subdomain until a DNS flip promotes it, which is the whole point of the subdomain
isolation decision.

## What you need before starting

| | |
|---|---|
| Hetzner project API token | Console > Security > API Tokens, **Read & Write**. `hcloud` has no OAuth flow. |
| DNS control for `fibuki.com` | Currently GoDaddy (`ns23`/`ns24.domaincontrol.com`). |
| An SSH keypair | `ssh-keygen -t ed25519 -C fibuki-deploy` if you don't have one. |
| A GPG key for backups | `backup.sh` refuses to write unencrypted dumps of customer data. |

## 1. Authenticate hcloud

```bash
hcloud context create fibuki     # paste the token when prompted
hcloud context active
```

## 2. Provision

```bash
cd deploy/selfhost
DRY_RUN=1 ./provision-hetzner.sh   # read the plan first
./provision-hetzner.sh
```

Creates a `cx32` in `fsn1` (Falkenstein), a Cloud Firewall allowing only
**22, 80, 443, icmp**, hardened SSH (no password auth), Docker, `fail2ban`,
unattended security upgrades, and Hetzner server backups.

8 GB is the floor, not headroom: Chromium sits around 400 MB resident plus 50 to
100 MB per concurrent PDF page, on top of Postgres, MinIO, Next, and the API.

The firewall is the real boundary. Docker publishes ports by writing iptables
rules that sit ahead of `ufw`, so a host firewall cannot be relied on to contain a
published container port. The Cloud Firewall runs outside the host.

## 3. DNS (before first boot)

Both names must resolve **before** you bring the stack up, or Caddy's ACME
challenge fails and backs off with a retry delay.

```
fibuki.com           A     <server-ipv4>
new-api.fibuki.com   A     <server-ipv4>
fibuki.com           AAAA  <server-ipv6>
new-api.fibuki.com   AAAA  <server-ipv6>
```

Confirm from off-box, not just locally:

```bash
dig +short fibuki.com new-api.fibuki.com
```

## 4. Ship the code

The box builds from source, so it needs the repo at the selfhost branch. It does
**not** need Firebase credentials and must never have them: that is why the
migration is split into two programs.

```bash
IP=$(hcloud server ip fibuki-selfhost)
ssh root@$IP 'mkdir -p /opt/fibuki'
# From a clone at the selfhost branch. Order matters: --include for the templates
# must precede the --exclude that would otherwise swallow them, and a bare
# `--exclude '.env*'` takes the examples with it.
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude .DS_Store \
  --include '.env*.example' --exclude '.env*' \
  --exclude 'fibuki-dump' \
  -e "ssh -i ~/.ssh/fibuki_deploy" \
  ./ root@$IP:/opt/fibuki/
```

Excluding real `.env` files is not optional: a local one would overwrite the
server's, and it would carry your development secrets onto a rented box. The
`fibuki-dump` exclude matters later, during the migration.

## 5. Configure

```bash
ssh root@$IP
cd /opt/fibuki/deploy/selfhost
cp .env.hetzner.example .env
chmod 600 .env
# Fill every CHANGE_ME:  openssl rand -base64 36
vi .env
```

Two things that are easy to get wrong:

- **Leave `OIDC_ISSUER` unset.** `server.ts` checks it first and, if set, leaves
  the built-in auth unmounted. The importer preserves Firebase uids while the OIDC
  verifier derives uid from the IdP's `sub`, so OIDC would make migrated data
  import cleanly and read as empty.
- **Never set `FIBUKI_DEV_UID`.** It authenticates every bearer token as one user.

## 6. Bring it up

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

First build takes a while (two Node images, one with Chromium).

Verify, on the box:

```bash
curl -fsS http://127.0.0.1:8788/healthz    # ~112 callables / 12 scheduled jobs
```

And from outside:

```bash
curl -fsSI https://fibuki.com | head -1
curl -fsS  https://new-api.fibuki.com/healthz    # expect 404 — masked on purpose
```

Confirm nothing else is exposed. Only 22, 80, 443 should answer:

```bash
nmap -Pn -p 22,80,443,3000,5432,8788,9000,9001 fibuki.com
```

## 6b. Prove mail works, before you need it

Mail is on the critical path: the importer creates migrated users **passwordless**,
so a password-reset email is the only way anyone gets in. Discovering it is broken
after a write freeze is the wrong time.

**Hetzner Cloud blocks outbound ports 25 and 465.** Port 465 fails with a bare
`ETIMEDOUT` on `CONN`, which looks like bad credentials but is not. Measured from
the `nbg1` host on 2026-07-29:

| Port | Reachable |
|---|---|
| 25 | no |
| 465 | no |
| 587 | yes |
| 2465 | yes (Resend, implicit TLS) |
| 2587 | yes (Resend, STARTTLS) |

The env template therefore uses **2465** with `FIBUKI_SMTP_SECURE=true`. If you
switch to 587, set `FIBUKI_SMTP_SECURE=false` — 587 is STARTTLS, not implicit TLS.

To smoke-test, call `sendEmail` from the shim inside the api container. A `true`
return means the SMTP transaction was accepted:

```bash
CID=$(docker compose ps -q fibuki-api)
docker cp smoke-mail.ts "$CID":/app/smoke-mail.ts
docker compose exec -T fibuki-api \
  npx vite-node --config vitest.selfhost.config.ts smoke-mail.ts
```

(`vite-node` has no `-e` flag, so this needs a real file inside `/app`.)

## 7. Prove PDFs work

This is the fix most likely to still be wrong, and the cutover runbook would only
catch it after you have already frozen writes. Exercise a path that reaches
`htmlToPdf` (a receipt conversion, or a UVA report) and confirm:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  logs fibuki-api | grep -i chrom
```

## 8. Backups, before any real data

```bash
apt-get install -y gnupg rclone
# Import/create the key that GPG_RECIPIENT names, then:
install -d -m 700 /var/backups/fibuki
cat >/etc/cron.d/fibuki-backup <<'EOF'
GPG_RECIPIENT=you@fibuki.com
OFFSITE_CMD=rclone copy --to-remote storagebox:fibuki/
10 3 * * * root /opt/fibuki/deploy/selfhost/backup.sh >> /var/log/fibuki-backup.log 2>&1
EOF
```

Then run both by hand once and do not proceed until the second one passes:

```bash
GPG_RECIPIENT=you@fibuki.com /opt/fibuki/deploy/selfhost/backup.sh
/opt/fibuki/deploy/selfhost/restore-test.sh
```

## 9. Then, and only then, migrate

Back to [`w4-cutover-runbook.md`](../../docs/w4-cutover-runbook.md) from step 2.
The export runs on **your** machine (the one with the Firebase service account),
never here.

### Stop the cron host before importing

**`verify` cannot pass against a stack whose cron is running.** The API hosts 12
schedules, and `processGmailSyncQueue` / `processPrecisionSearchQueue` fire every
five minutes. They pick up freshly imported queue documents and do exactly what
they are supposed to: mutate them, delete finished ones, stamp
`emailIntegrations`. `verify` then compares the dump against data the system has
already moved on from and reports mismatches that are not import errors.

Observed on the first real run: `emailIntegrations` 2 mismatched,
`gmailSyncQueue` 1 mismatched, `precisionSearchQueue` 1 missing — all of it the
cron host doing its job.

So bring the stack up with cron disabled for the migration window:

```bash
# In .env for the duration of the migration:
FIBUKI_NO_CRON=1

docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d
# import, then verify, and only once verify exits 0:
#   remove FIBUKI_NO_CRON and `up -d` again to resume the schedules.
```

The API logs `FIBUKI_NO_CRON set — N scheduled jobs NOT started` at boot, so it is
easy to confirm. Re-running the import afterwards is safe regardless: it is
idempotent.

### Do not `down -v` to reset the data

`down -v` removes **every** volume in the project, `caddy-data` included, and that
holds the ACME account plus both issued certificates. Caddy then re-requests them,
which counts against Let's Encrypt's duplicate-certificate limit (5 per week per
identical name set). To wipe only the application data:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
docker volume rm selfhost_fibuki-pgdata selfhost_fibuki-miniodata
```

## Decision: the API keeps the hostname `new-api.fibuki.com`, permanently

Decided 2026-07-30, and since carried out. At cutover **only the web host changed** —
`new.fibuki.com` became `fibuki.com` — and the API name stays as it is forever, despite
the "new" reading oddly later.

The reason is that a rename is not just a DNS record. These are pinned to the API
hostname today:

| Pinned to `new-api.fibuki.com` | Count / where |
| --- | --- |
| `files.downloadUrl` | **539 rows** in Postgres |
| other collections (bmdExports) | 3 rows |
| `FIBUKI_PUBLIC_URL`, `FIBUKI_AUTH_ISSUER`, `FIBUKI_API_HOST` | `.env` |
| `NEXT_PUBLIC_FIBUKI_API_URL` | **baked into the web bundle at build time** |
| Better Auth Google redirect | `…/__auth/callback/google`, registered at Google |
| Stripe webhook endpoint | `…/stripeWebhook`, whose `whsec_` is PER-ENDPOINT |
| TLS certificate | Caddy |

Renaming would need a data rewrite, a web rebuild, a re-registered Google redirect
URI and a **second Stripe endpoint with a different signing secret** — each a step
that can be missed halfway through a cutover, and the Stripe one fails silently by
simply never reconciling a subscription.

Keeping the name makes the cutover a strictly smaller operation, and in particular
means **no `selfhost:rewrite-urls` pass is required** — the 539 download URLs already
point somewhere that will still be correct.

If it is ever renamed, do it BEFORE registering the Stripe webhook and before real
users arrive: at that point it costs one idempotent rewrite pass on data nobody
depends on.

### What the cutover therefore has to change

Only things carrying the WEB host:

```
FIBUKI_WEB_HOST=fibuki.com
FIBUKI_WEB_ORIGIN=https://fibuki.com      # also feeds Better Auth trustedOrigins
APP_URL=https://fibuki.com
NEXT_PUBLIC_APP_URL=https://fibuki.com    # build arg -> requires a web rebuild
GOOGLE_OAUTH_REDIRECT_URI=https://fibuki.com/api/gmail/callback
TRUELAYER_REDIRECT_URL=https://fibuki.com/api/truelayer/callback
```

Plus, outside the box: the `fibuki.com` A/AAAA records, and **re-registering the
Gmail OAuth redirect** at Google — that one lives on the web host, unlike the Better
Auth sign-in callback which lives on the API host and does not move.

`fibuki-web` must be rebuilt, not merely restarted: every `NEXT_PUBLIC_*` is inlined
at build time, so a runtime change to them is silently ignored.

## Known gap: public invoice sharing is non-functional

`/i/<token>` returns **HTTP 500** on this stack, for any token, valid or not.
Verified against a real migrated share token on 2026-07-29.

Cause is structural, not a bug to patch. `app/(public)/i/[token]/page.tsx` is a
server component that reads `invoiceShares` and `invoices` through `getAdminDb()`,
i.e. `firebase-admin`. Two things make that impossible here:

- `next.config.ts` aliases only the **client** SDKs (`firebase/app`,
  `firebase/firestore`, `firebase/storage`, `firebase/functions`, `firebase/auth`).
  `firebase-admin/*` is deliberately not aliased.
- `fibuki-web` receives only `PORT` and `NODE_ENV` — no `DATABASE_URL`, no Firebase
  credentials. It is not part of the self-host data plane by design.

So the page cannot reach any datastore. This is the same category as the Gmail
OAuth routes under `app/api/gmail/*`.

**A fix is a feature port, roughly three pieces:**

1. A public request function on `fibuki-api` (which does have DB access), e.g.
   `GET /__share/:token`, validating the share (exists, not revoked, invoice not
   cancelled) and returning the invoice payload.
2. Rewriting the public page to fetch that instead of using the Admin SDK.
3. A share-scoped object route for the PDF. **The object path must be derived from
   the share record, never taken from the URL** — otherwise a share token becomes a
   read-any-object capability. The existing `/__storage/download/*` route cannot be
   reused, since it authenticates a *user* token.

Until then, treat public sharing as unavailable on self-host. It does not block a
signed-in user from viewing or downloading their own files, which works.

## Accepted regressions

Per the phase-2 decision, not bugs: realtime is polling rather than
`onSnapshot`, and trigger delivery is in-process with the orphan-cron as the
crash-recovery net.

## Scaling, when you get there

The API is a single Node process with no clustering, so a bigger instance buys
little. `FIBUKI_NO_CRON=1` lets you run additional replicas safely, but exactly
one instance may run the schedules: there is no advisory lock or leader election,
so two unguarded instances fire all 12 jobs twice. The trigger bus is in-process,
so heavy trigger and PDF work cannot be isolated onto a dedicated worker until
pg-boss lands in Phase 3.
