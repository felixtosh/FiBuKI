# FiBuKI self-host deploy stack

Additive, env-gated deploy artifacts for running FiBuKI without Firebase, using
the selfhost shims (`functions/src/selfhost/*`, `lib/selfhost/*`). Nothing here
affects a normal Firebase build — it is only referenced by this compose file.

## Stack

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:16-alpine` | Firestore-shim JSONB store (`DATABASE_URL`) |
| `seaweedfs` | `chrislusf/seaweedfs` | storage-shim S3 backend (bucket auto-created by the shim). Replaced MinIO in September 2026, when MinIO's server was archived upstream and its images withdrawn from every registry |
| `fibuki-api` | built (`api.Dockerfile`, Node 22) | selfhost host: callables + trigger bus + cron, over the shims; `:8788` |
| `fibuki-web` | built (`web.Dockerfile`, Node 22) | Next frontend, `FIBUKI_BACKEND=selfhost` alias build; `:3000` |

## Run

```bash
cp deploy/selfhost/.env.example deploy/selfhost/.env   # then fill in secrets
cd deploy/selfhost
docker compose --env-file .env up -d --build
docker compose ps
curl -fsS http://localhost:8788/healthz    # ~112 callables / 12 scheduled
```

## Upgrading an existing deployment: MinIO to SeaweedFS

**If your stack predates September 2026, do this before bringing the app up on
the new code.** The blob store changed from MinIO to SeaweedFS, and the two do
not share a volume: SeaweedFS starts empty.

Nothing is deleted if you skip it. The MinIO volume stays exactly where it was
and the app simply looks in the wrong place, so what a user sees is an account
whose Files have all vanished, which is indistinguishable from data loss until
somebody explains it.

```bash
git pull                              # or rsync, per README-hetzner.md
./migrate-minio-to-seaweedfs.sh       # copies and verifies; app keeps serving
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env up -d --build       # switches the app over
```

The script brings up only `seaweedfs`, mirrors the bucket with the `mc` already
inside the MinIO image, and verifies object counts plus `mc diff` before
reporting success. It refuses to run twice into a non-empty destination.

Rollback is the same command with `FIBUKI_S3_ENDPOINT=minio` and
`FIBUKI_S3_PORT=9000`: the MinIO service and its volume are left intact on
purpose. Retire them only once SeaweedFS has served long enough to trust.

**Save the MinIO image before it is pruned.** It can no longer be pulled from
any registry, so the copy on your host is the only one you have:

```bash
docker save minio/minio:latest | gzip > minio-image-backup.tar.gz
```

A fresh install needs none of this.

## Plan (feature surface)

Self-host has nobody to bill, so the plan is an env lever, not a Stripe
subscription (#159):

```
FIBUKI_PLAN=full   # default when unset: the whole feature surface
```

Accepted values: `full` (alias of `pro`), `free`, `data`, `smart`, `pro`.
Anything else refuses loudly instead of silently granting the default. First
login provisions the account records (an auth user row and a `subscriptions`
document with the budget fields); when `FIBUKI_PLAN` changes, restart
`fibuki-api` and the stored plan is re-pointed on each user's next request.
Plan limits (transaction quota, AI fair-use budget) still apply; they come
from the chosen plan.

The lever only exists on the selfhost tier: with `FIBUKI_TIER=cloud` (hosted
fibuki.com) it is ignored and Stripe owns the plan.

## Gmail (OAuth)

A mailbox connects over IMAP (an app password, nothing to register) or over
Gmail OAuth, which needs an OAuth client of your own at Google. The steps and
variables are in the Gmail section of `.env.example`.

**On a private host the app stays in Testing mode.** Google only publishes an
OAuth app whose home page and privacy-policy URL are public, on a domain the
owner has verified, and its branding check fetches both pages. A host reachable
only over a VPN (a NetBird or WireGuard mesh, say) cannot pass that check, so
the app is never published. In Testing mode:

- every Google account that connects must be listed as a test user;
- Google ends the login after 7 days, so the mailbox needs a reconnect weekly.

The OAuth flow itself works on a private host: the redirect to the callback goes
through the user's browser, which can reach the host, and the token exchange is
an outbound call from the host to Google.

**Do not connect over OAuth an address already connected over IMAP.** Doing so
currently breaks the IMAP mailbox; see
[felixtosh/FiBuKI#747](https://github.com/felixtosh/FiBuKI/issues/747) (one Mail
Integration per address, switched in place when connected through the other
provider).

## Notes

- **Auth**: production uses OIDC (`OIDC_ISSUER` → `oidc-verifier.ts`, tested with
  Authentik). `FIBUKI_DEV_UID` is a dev-only bypass and must never be set here.
  On first login each user is provisioned automatically (see Plan above); in
  OIDC mode the admin flag on the token (`OIDC_ADMIN_GROUP`) is mirrored into
  the user record, so the admin panel shows the same admins the API enforces.
- **Invites need a mailer**: the invite email goes over SMTP
  (`FIBUKI_SMTP_HOST/USER/PASS`). Without one configured, sending an invite
  now fails with a clear error instead of reporting success and sitting
  "Pending" forever (#159).
- **NEXT_PUBLIC_\***: inlined at *build* time (Next + CSP), so they are compose
  `build.args`, not just runtime env — rebuild `fibuki-web` if they change.
- **Data**: `fibuki-pgdata` / `fibuki-seaweeddata` named volumes (`fibuki-miniodata` is kept as the pre-migration rollback) (container-uid owned).
- **Reverse proxy**: put a TLS proxy in front of `:3000` (web) and `:8788` (api),
  one hostname each. The api's CORS layer (`FIBUKI_WEB_ORIGIN`) expects the split
  origin. Point `FIBUKI_PUBLIC_URL` / `NEXT_PUBLIC_FIBUKI_API_URL` at the api host.
