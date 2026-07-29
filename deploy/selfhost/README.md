# FiBuKI self-host deploy stack

Additive, env-gated deploy artifacts for running FiBuKI without Firebase, using
the selfhost shims (`functions/src/selfhost/*`, `lib/selfhost/*`). Nothing here
affects a normal Firebase build — it is only referenced by this compose file.

## Stack

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:16-alpine` | Firestore-shim JSONB store (`DATABASE_URL`) |
| `minio` | `minio/minio` | storage-shim S3 backend (bucket auto-created by the shim) |
| `fibuki-api` | built (`api.Dockerfile`, Node 22) | selfhost host: callables + trigger bus + cron, over the shims; `:8788` |
| `fibuki-web` | built (`web.Dockerfile`, Node 20) | Next frontend, `FIBUKI_BACKEND=selfhost` alias build; `:3000` |

## Run

```bash
cp deploy/selfhost/.env.example deploy/selfhost/.env   # then fill in secrets
cd deploy/selfhost
docker compose --env-file .env up -d --build
docker compose ps
curl -fsS http://localhost:8788/healthz    # ~112 callables / 12 scheduled
```

## Notes

- **Auth**: production uses OIDC (`OIDC_ISSUER` → `oidc-verifier.ts`, tested with
  Authentik). `FIBUKI_DEV_UID` is a dev-only bypass and must never be set here.
- **NEXT_PUBLIC_\***: inlined at *build* time (Next + CSP), so they are compose
  `build.args`, not just runtime env — rebuild `fibuki-web` if they change.
- **Data**: `fibuki-pgdata` / `fibuki-miniodata` named volumes (container-uid owned).
- **Reverse proxy**: put a TLS proxy in front of `:3000` (web) and `:8788` (api),
  one hostname each. The api's CORS layer (`FIBUKI_WEB_ORIGIN`) expects the split
  origin. Point `FIBUKI_PUBLIC_URL` / `NEXT_PUBLIC_FIBUKI_API_URL` at the api host.
