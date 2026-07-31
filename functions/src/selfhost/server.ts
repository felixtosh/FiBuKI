/**
 * fibuki-api process entry: boots the index.ts barrel through the selfhost
 * shims and serves every mounted callable/request function.
 *
 * Must run with the module aliases active, which vite-node gets from the
 * same config the tests use:
 *
 *   npx vite-node --config vitest.selfhost.config.ts src/selfhost/server.ts
 *
 * Auth (in precedence order):
 *   1. FIBUKI_DEV_UID=<uid>  — dev bypass, accepts ANY bearer as that uid.
 *   2. OIDC_ISSUER set       — external OIDC (Authentik/Keycloak/Entra):
 *      verify id_token via JWKS (createOidcVerifier), map sub->uid,
 *      OIDC_ADMIN_GROUP -> token.admin. Built-in auth stays unmounted.
 *   3. neither               — Better Auth built-in (the default since W1
 *      chunk 3): createSelfhostAuth() verifies its own JWTs and its fetch
 *      handler is mounted at /__auth. Requires FIBUKI_AUTH_SECRET whenever
 *      DATABASE_URL is set (createSelfhostAuth refuses to start otherwise).
 * Never set FIBUKI_DEV_UID in production; it defeats the other two.
 */

import { createCronHost } from "./cron-host";
import { createHost, type TokenVerifier } from "./host";
import { createOidcVerifier } from "./oidc-verifier";
import { createSelfhostAuth } from "./better-auth";

interface ResolvedAuth {
  verifyToken: TokenVerifier;
  /** Set only in built-in mode: the Better Auth handler for /__auth. */
  authHandler?: (req: Request) => Promise<Response>;
}

async function resolveVerifier(): Promise<ResolvedAuth> {
  const devUid = process.env.FIBUKI_DEV_UID;
  if (devUid) {
    console.warn(`fibuki-api: DEV AUTH MODE — every bearer token authenticates as "${devUid}"`);
    return { verifyToken: async () => ({ uid: devUid, token: {} }) };
  }

  const issuer = process.env.OIDC_ISSUER;
  if (issuer) {
    console.log(`fibuki-api: external OIDC verification against issuer ${issuer}`);
    return {
      verifyToken: createOidcVerifier({
        issuer,
        jwksUri: process.env.OIDC_JWKS_URI,
        audience: process.env.OIDC_AUDIENCE,
        adminGroup: process.env.OIDC_ADMIN_GROUP,
        groupsClaim: process.env.OIDC_GROUPS_CLAIM,
      }),
    };
  }

  console.log("fibuki-api: built-in auth (Better Auth) — endpoints at /__auth");
  if (
    (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_SECRET) &&
    !process.env.FIBUKI_AUTH_ISSUER &&
    !process.env.BETTER_AUTH_URL
  ) {
    // The issuer doubles as the OAuth redirect_uri base — without it Google
    // gets the unreachable internal placeholder and every social sign-in dies
    // at the consent screen with a redirect_uri mismatch.
    console.warn(
      "fibuki-api: GOOGLE_CLIENT_ID is set but FIBUKI_AUTH_ISSUER is not — " +
        "Google OAuth would use the internal placeholder URL. Set FIBUKI_AUTH_ISSUER " +
        "to this deployment's public URL.",
    );
  }
  const auth = await createSelfhostAuth();
  return { verifyToken: auth.verifier, authHandler: auth.handler };
}

async function main() {
  const barrel = await import("../index");

  const { verifyToken, authHandler } = await resolveVerifier();

  const { app, inventory } = createHost(barrel as Record<string, unknown>, {
    verifyToken,
    authHandler,
    log: (m) => console.error(m),
  });

  // FIBUKI_NO_CRON=1 runs the HTTP host without schedules (e.g. a second
  // replica, or poking callables without the queue drains firing).
  const cron = createCronHost(barrel as Record<string, unknown>, {
    log: (m) => console.error(m),
  });
  if (process.env.FIBUKI_NO_CRON) {
    console.warn(`fibuki-api: FIBUKI_NO_CRON set — ${cron.jobs.length} scheduled jobs NOT started`);
  } else {
    cron.start();
    for (const job of cron.jobs) {
      console.log(`cron: ${job.name} [${job.schedule} -> ${job.cron} ${job.timezone}]`);
    }
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void cron.stop().finally(() => process.exit(0));
    });
  }

  const port = Number(process.env.PORT ?? 8788);
  app.listen(port, () => {
    console.log(
      `fibuki-api listening on :${port} — ${inventory.callables.length} callables, ` +
        `${inventory.requests.length} request functions, ${cron.jobs.length} scheduled jobs, ` +
        `${inventory.excluded.length} excluded`,
    );
  });
}

main().catch((err) => {
  // Fatal boot errors (e.g. DATABASE_URL without FIBUKI_AUTH_SECRET) exit
  // cleanly with the message instead of an unhandled-rejection trace.
  console.error(`fibuki-api: fatal startup error — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
