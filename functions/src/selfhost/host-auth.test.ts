/**
 * W1 chunk 3 — host wiring for the built-in auth: createHost() mounts the
 * Better Auth fetch handler at /__auth (same collision-free namespace as
 * /__data), and the host's verifier accepts the JWTs those endpoints mint.
 *
 * Proven over a real listening socket, exactly like the client shims will
 * use it:
 *   sign-in over HTTP → session token → JWT exchange → data plane accepts
 * plus: /__auth stays a plain not-found when no authHandler is configured
 * (external-OIDC deployments keep their existing behavior).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getFirestore } from "./firestore-shim";
import { createHost } from "./host";
import { createSelfhostAuth, type SelfhostAuth } from "./better-auth";

let auth: SelfhostAuth;
let server: http.Server;
let base: string;

let seq = 0;
const uniqueEmail = (tag: string) => `w1-host-${tag}-${++seq}-${Date.now()}@example.test`;

async function allowEmail(email: string): Promise<void> {
  await getFirestore().collection("allowedEmails").add({ email, createdAt: new Date() });
}

beforeAll(async () => {
  auth = await createSelfhostAuth();
  // Empty barrel ON PURPOSE: this suite is about the auth mount, not the
  // callables — host.test.ts covers those.
  const host = createHost(
    {},
    { verifyToken: auth.verifier, authHandler: auth.handler },
  );
  server = http.createServer(host.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("host /__auth wiring (built-in Better Auth)", () => {
  it("signs in over HTTP and the minted JWT clears the host verifier", async () => {
    const email = uniqueEmail("signin");
    await allowEmail(email);
    const { uid } = await auth.provisionUser({ email, password: "host wiring pw" });

    const signIn = await fetch(`${base}/__auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "host wiring pw" }),
    });
    expect(signIn.status).toBe(200);
    const session = (await signIn.json()) as { token?: string };
    expect(typeof session.token).toBe("string");

    // JWT exchange, the same call the client shim makes (bearer plugin
    // accepts the raw session token).
    const tokenRes = await fetch(`${base}/__auth/token`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    expect(typeof token).toBe("string");

    const authData = await auth.verifier(token);
    expect(authData?.uid).toBe(uid);
  });

  it("HTTP-minted JWTs authenticate against the data plane, owner-scoped", async () => {
    const email = uniqueEmail("dataplane");
    await allowEmail(email);
    const { uid } = await auth.provisionUser({ email, password: "data plane pw" });

    const signIn = await fetch(`${base}/__auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "data plane pw" }),
    });
    const session = (await signIn.json()) as { token: string };
    const tokenRes = await fetch(`${base}/__auth/token`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const { token } = (await tokenRes.json()) as { token: string };

    const write = await fetch(`${base}/__data/write`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            type: "set",
            path: `sources/host-auth-${uid}`,
            data: { userId: uid, name: "wired bank", type: "bank_account" },
          },
        ],
      }),
    });
    expect(write.status).toBe(200);

    const query = await fetch(`${base}/__data/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "sources" }),
    });
    expect(query.status).toBe(200);
    const body = (await query.json()) as { docs: { id: string }[] };
    expect(body.docs.map((d) => d.id)).toContain(`host-auth-${uid}`);
  });

  it("wrong credentials at the HTTP endpoint are rejected, not 500", async () => {
    const email = uniqueEmail("wrongpw");
    await allowEmail(email);
    await auth.provisionUser({ email, password: "the real password" });

    const signIn = await fetch(`${base}/__auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "not the password" }),
    });
    expect(signIn.status).toBe(401);
  });

  it("sign-up over HTTP stays disabled (invite-only: provisionUser is the only door)", async () => {
    const res = await fetch(`${base}/__auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: uniqueEmail("walkin"),
        password: "self registered pw",
        name: "Walk-in",
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("without an authHandler, /__auth answers the host's normal not-found", async () => {
    const bare = createHost({}, { verifyToken: auth.verifier });
    const bareServer = http.createServer(bare.app);
    await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", resolve));
    const bareBase = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${bareBase}/__auth/sign-in/email`, { method: "POST" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { status: string } };
      expect(body.error.status).toBe("NOT_FOUND");
    } finally {
      await new Promise<void>((resolve, reject) =>
        bareServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
