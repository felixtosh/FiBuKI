/**
 * W1 (Better Auth) — server acceptance suite. Written spec-first with every
 * test `it.fails` (xfail); chunk 1 (server core) implemented `./better-auth`,
 * chunk 2 rewrote `./auth-shim` over the same store, and together they
 * flipped every mark — this suite is now fully green acceptance
 * (see handoffs/2026-07-21-w1-better-auth-impl.md).
 *
 * The seam these tests define (kept deliberately small):
 *
 *   // functions/src/selfhost/better-auth.ts
 *   export interface SelfhostAuth {
 *     handler: (req: Request) => Promise<Response>; // Better Auth fetch handler
 *     verifier: TokenVerifier;                      // plugs into createHost()
 *     provisionUser(opts: {
 *       uid?: string;            // caller-provided — Firebase uids preserved
 *       email: string;
 *       password?: string;       // absent for migrated users (forced reset)
 *       displayName?: string;
 *       admin?: boolean;
 *     }): Promise<{ uid: string }>;
 *     signInEmail(email: string, password: string): Promise<{ token: string }>;
 *   }
 *   export function createSelfhostAuth(): Promise<SelfhostAuth>;
 *
 * `provisionUser` doubles as the W2/W3 migration entry point (invite-only
 * product: users are always provisioned, never self-registered). Sessions
 * live in the same Postgres through the same migrate path as everything
 * else (no auth container). The Firebase-facing admin surface stays
 * `./auth-shim.ts` (the `firebase-admin/auth` alias target) and must be
 * rewritten over the same store — its acceptance is below too.
 *
 * Hard constraints proven here:
 *  - uid preservation (Firebase-shaped fixture uid round-trips)
 *  - invite-only via the same `allowedEmails` data the Firebase build uses
 *  - admin claims (SUPER_ADMIN_EMAIL + setCustomUserClaims port)
 *  - sessions verify to AuthData the data plane owner-scopes by uid,
 *    inside the one tenant db/tenant.ts names (RLS assumptions unchanged)
 */

import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getFirestore, __rawSqlForTest } from "./firestore-shim";
import { getTenantId } from "./db/tenant";
import { getAuth as getAdminAuth } from "./auth-shim";
import { createDataPlane } from "./data-plane";
import type { TokenVerifier } from "./host";
import { createSelfhostAuth } from "./better-auth";

/* The seam contract, restated locally ON PURPOSE: loadAuth() assigning the
 * real module's return value to this interface is the compile-time proof
 * the implementation still satisfies the spec'd shape. */
interface SelfhostAuth {
  handler: (req: Request) => Promise<Response>;
  verifier: TokenVerifier;
  provisionUser(opts: {
    uid?: string;
    email: string;
    password?: string;
    displayName?: string;
    admin?: boolean;
  }): Promise<{ uid: string }>;
  signInEmail(email: string, password: string): Promise<{ token: string }>;
}

async function loadAuth(): Promise<SelfhostAuth> {
  return createSelfhostAuth();
}

/** A Firebase-shaped uid (28 url-safe chars) — the migration fixture. */
const FIREBASE_UID = "Kx7RgQ2mNpZcW3vYtLb8HdFs4A2q";

let seq = 0;
const uniqueEmail = (tag: string) => `w1-${tag}-${++seq}-${Date.now()}@example.test`;

/** Seed the invite gate the same way the Firebase build maintains it. */
async function allowEmail(email: string): Promise<void> {
  await getFirestore().collection("allowedEmails").add({ email, createdAt: new Date() });
}

describe("Better Auth server acceptance — server core + auth-shim over the real store", () => {
  it("createSelfhostAuth() boots against the selfhost Postgres", async () => {
    const auth = await loadAuth();
    expect(typeof auth.handler).toBe("function");
    expect(typeof auth.verifier).toBe("function");
    expect(typeof auth.provisionUser).toBe("function");
    expect(typeof auth.signInEmail).toBe("function");
  });

  it("preserves caller-provided Firebase uids end to end", async () => {
    const auth = await loadAuth();
    const email = uniqueEmail("uid-preserve");
    await allowEmail(email);
    const created = await auth.provisionUser({ uid: FIREBASE_UID, email, password: "correct horse battery" });
    expect(created.uid).toBe(FIREBASE_UID);

    const { token } = await auth.signInEmail(email, "correct horse battery");
    const authData = await auth.verifier(token);
    expect(authData?.uid).toBe(FIREBASE_UID);
  });

  it("verifier rejects garbage and expired-session tokens with null (host answers 401)", async () => {
    const auth = await loadAuth();
    expect(await auth.verifier("not-a-session-token")).toBeNull();
    expect(await auth.verifier("")).toBeNull();
  });

  it("verifier refuses a token whose session was revoked (signature still valid)", async () => {
    // The revocation backstop behind the JWT decision (a): tokens carry the
    // session id as `sid`, and the verifier requires that session to still
    // exist — killing the session kills every token minted from it, even
    // though the JWKS signature stays valid. Chunk 2's deleteUser leans on
    // exactly this.
    const auth = await loadAuth();
    const email = uniqueEmail("revoked");
    await allowEmail(email);
    await auth.provisionUser({ email, password: "revoked session pw" });
    const { token } = await auth.signInEmail(email, "revoked session pw");
    expect(await auth.verifier(token)).not.toBeNull();

    // The token is locally decodable (pinned by the client suite) — read the
    // sid claim and revoke that session directly in the store.
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    ) as { sid?: string };
    expect(typeof payload.sid).toBe("string");
    await __rawSqlForTest(`DELETE FROM auth_sessions WHERE id = $1`, [payload.sid], getTenantId());

    expect(await auth.verifier(token)).toBeNull();
  });

  it("sign-in with a wrong password yields no session", async () => {
    const auth = await loadAuth();
    const email = uniqueEmail("wrong-pw");
    await allowEmail(email);
    await auth.provisionUser({ email, password: "right password here" });
    await expect(auth.signInEmail(email, "wrong password")).rejects.toBeTruthy();
  });

  it("invite-only: provisioning an email absent from allowedEmails is refused", async () => {
    // Ports the allowedEmails semantics (CLAUDE.md auth section) onto Better
    // Auth: the SAME data that gates registration on the Firebase build gates
    // it here. SUPER_ADMIN_EMAIL is exempt (auto-granted on first login).
    const auth = await loadAuth();
    const intruder = uniqueEmail("uninvited");
    await expect(auth.provisionUser({ email: intruder, password: "whatever whatever" })).rejects.toBeTruthy();

    const invited = uniqueEmail("invited");
    await allowEmail(invited);
    await expect(auth.provisionUser({ email: invited, password: "whatever whatever" })).resolves.toBeTruthy();
  });

  it("admin claims: SUPER_ADMIN_EMAIL verifies with token.admin === true", async () => {
    const email = uniqueEmail("super");
    process.env.SUPER_ADMIN_EMAIL = email;
    try {
      const auth = await loadAuth();
      await auth.provisionUser({ email, password: "the super admin pw" });
      const { token } = await auth.signInEmail(email, "the super admin pw");
      const authData = await auth.verifier(token);
      expect(authData?.token?.admin).toBe(true);
    } finally {
      delete process.env.SUPER_ADMIN_EMAIL;
    }
  });

  it("admin claims: setCustomUserClaims({admin:true}) is reflected on the next session", async () => {
    const auth = await loadAuth();
    const email = uniqueEmail("promoted");
    await allowEmail(email);
    const { uid } = await auth.provisionUser({ email, password: "promoted user pw" });

    let session = await auth.signInEmail(email, "promoted user pw");
    expect((await auth.verifier(session.token))?.token?.admin).not.toBe(true);

    await getAdminAuth().setCustomUserClaims(uid, { admin: true });
    session = await auth.signInEmail(email, "promoted user pw");
    expect((await auth.verifier(session.token))?.token?.admin).toBe(true);
  });

  it("auth-shim admin surface returns real users, not synthetic records", async () => {
    // auth-shim.ts is the `firebase-admin/auth` alias target consumed by 14
    // functions files (getUser ×13, getUserByEmail, listUsers, deleteUser,
    // setCustomUserClaims, …). Today it fabricates `${uid}@selfhost.local`
    // records; after W1 it must read the Better Auth store.
    const auth = await loadAuth();
    const email = uniqueEmail("admin-surface");
    await allowEmail(email);
    const { uid } = await auth.provisionUser({ email, password: "admin surface pw", displayName: "Real Name" });

    const rec = await getAdminAuth().getUser(uid);
    expect(rec.email).toBe(email); // synthetic shim returns uid@selfhost.local
    expect(rec.displayName).toBe("Real Name");

    const byEmail = await getAdminAuth().getUserByEmail(email);
    expect(byEmail.uid).toBe(uid);

    const { users } = await getAdminAuth().listUsers();
    expect(users.map((u) => u.uid)).toContain(uid);
  });

  it("auth-shim listUsers pages via pageToken — every user once, no dupes, terminates", async () => {
    // A tenant larger than one page: the exporter (migrate-export.exportUsers)
    // loops on pageToken, so the shim must both honor an incoming token and
    // hand back the next one. Keyset pagination must not drop or duplicate a
    // row at a page boundary.
    const auth = await loadAuth();
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) {
      const email = uniqueEmail(`paged-${i}`);
      await allowEmail(email);
      const { uid } = await auth.provisionUser({ email, password: "pagination test pw" });
      mine.push(uid);
    }

    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const res = await getAdminAuth().listUsers(2, token);
      expect(res.users.length).toBeLessThanOrEqual(2); // page size respected
      seen.push(...res.users.map((u) => u.uid));
      token = res.pageToken;
      expect(++pages).toBeLessThan(1000); // guard a non-terminating loop
    } while (token);

    // The shared-tenant sweep contains other tests' users too; assert on ours.
    for (const uid of mine) {
      expect(seen.filter((u) => u === uid)).toHaveLength(1);
    }
    expect(new Set(seen).size).toBe(seen.length); // nothing duplicated anywhere
  });

  it("auth-shim listUsers rejects a malformed pageToken (firebase parity)", async () => {
    await loadAuth();
    await expect(getAdminAuth().listUsers(2, "not-a-real-token")).rejects.toMatchObject({
      code: "auth/invalid-page-token",
    });
  });

  it("auth-shim verifyIdToken accepts a live session token", async () => {
    const auth = await loadAuth();
    const email = uniqueEmail("verify");
    await allowEmail(email);
    const { uid } = await auth.provisionUser({ email, password: "verify token pw" });
    const { token } = await auth.signInEmail(email, "verify token pw");
    await expect(getAdminAuth().verifyIdToken(token)).resolves.toMatchObject({ uid });
  });

  it("auth-shim deleteUser removes the account and kills its sessions", async () => {
    const auth = await loadAuth();
    const email = uniqueEmail("deleted");
    await allowEmail(email);
    const { uid } = await auth.provisionUser({ email, password: "to be deleted pw" });
    const { token } = await auth.signInEmail(email, "to be deleted pw");

    await getAdminAuth().deleteUser(uid);
    await expect(getAdminAuth().getUser(uid)).rejects.toBeTruthy();
    expect(await auth.verifier(token)).toBeNull();
  });

  it("two real users are owner-scoped by uid through the data plane, one tenant", async () => {
    // Multi-user login on the selfhost stack, with db/tenant.ts semantics
    // unchanged: both users' rows live in the ONE tenant; isolation between
    // them is the data plane's owner-scoping by uid, RLS backstop untouched.
    const auth = await loadAuth();
    const emailA = uniqueEmail("tenant-a");
    const emailB = uniqueEmail("tenant-b");
    await allowEmail(emailA);
    await allowEmail(emailB);
    const a = await auth.provisionUser({ email: emailA, password: "user a password" });
    const b = await auth.provisionUser({ email: emailB, password: "user b password" });
    const tokenA = (await auth.signInEmail(emailA, "user a password")).token;
    const tokenB = (await auth.signInEmail(emailB, "user b password")).token;

    const app = express();
    app.use("/__data", createDataPlane(auth.verifier));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const write = await fetch(`${base}/__data/write`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        body: JSON.stringify({
          ops: [
            {
              type: "set",
              path: `sources/w1-acceptance-${a.uid}`,
              data: { userId: a.uid, name: "A's bank", type: "bank_account" },
            },
          ],
        }),
      });
      expect(write.status).toBe(200);

      // Owner-read collections are auto-scoped to the caller's uid by the
      // data plane — B must not see A's row, however B phrases the query.
      const queryFor = async (token: string) =>
        fetch(`${base}/__data/query`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            path: "sources",
            wheres: [{ field: "userId", op: "==", value: a.uid }],
          }),
        });

      const asB = await queryFor(tokenB);
      expect(asB.status).toBe(200);
      const bodyB = (await asB.json()) as { docs: unknown[] };
      expect(bodyB.docs).toHaveLength(0);

      const asA = await queryFor(tokenA);
      expect(asA.status).toBe(200);
      const bodyA = (await asA.json()) as { docs: unknown[] };
      expect(bodyA.docs.length).toBeGreaterThan(0);
      void b; // B's uid only matters as "not A" — the token is the assertion
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});
