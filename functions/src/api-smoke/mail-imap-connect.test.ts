/**
 * Route smoke over POST /api/mail/imap/connect — the flow every new mailbox
 * goes through, and until now untested.
 *
 * The point of the suite is the classified 400: a failed verify login must come
 * back as an error *code* the UI can branch on. #176 lifts the classifier out
 * of this route into shared mail code so the sync worker can reach it too, and
 * this pins that the move changes nothing the caller can see.
 *
 * Codes are pinned; messages are not — they are copy, and rewording them is not
 * a regression.
 *
 * Runs under the api-smoke profile ONLY (needs root node_modules for
 * next/imapflow). The verify login is stubbed at the imapflow seam: no socket
 * is opened, the route's own catch/classify branch is what runs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeFirestore } from "./fake-firestore";

// The route captures `getAdminDb()` at MODULE load, so the db and the error the
// stubbed IMAP client throws both live in hoisted boxes the mock factories read.
const h = vi.hoisted(() => {
  const box: { db: unknown; connectError: unknown } = {
    db: undefined,
    connectError: undefined,
  };
  return { box };
});

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => h.box.db,
  getAdminApp: () => ({}),
  getAdminStorage: () => ({}),
  getAdminBucket: () => ({}),
}));

// Identity from the Bearer token (same seam stub as route-owner-scoping).
vi.mock("@/lib/auth/get-server-user", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/get-server-user")>();
  return {
    ...actual,
    getServerUserIdWithFallback: async (request: Request): Promise<string> => {
      const header = request.headers.get("Authorization");
      if (!header?.startsWith("Bearer ")) throw new actual.UnauthorizedError();
      return header.substring(7);
    },
  };
});

// A client whose connect() throws whatever the test staged.
vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect(): Promise<void> {
      throw h.box.connectError;
    }
    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => {} };
    }
    async logout(): Promise<void> {}
    close(): void {}
  },
}));

const store = new FakeFirestore();
h.box.db = store;

beforeEach(() => {
  store.reset();
  h.box.connectError = undefined;
});

/** POST the connect body as an authenticated user. */
function connectRequest(): NextRequest {
  return new NextRequest("http://test.local/api/mail/imap/connect", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer user-A" },
    body: JSON.stringify({
      host: "mail.example.test",
      user: "someone@example.test",
      password: "app-password",
      mailbox: "INBOX",
    }),
  });
}

async function connectWith(
  error: unknown
): Promise<{ status: number; code?: string; err?: string }> {
  h.box.connectError = error;
  const { POST } = await import("@/app/api/mail/imap/connect/route");
  const res = await POST(connectRequest());
  const body = (await res.json()) as { code?: string; error?: string };
  return { status: res.status, code: body.code, err: body.error };
}

describe("POST /api/mail/imap/connect — classified verify failures", () => {
  it("a rejected login answers 400 auth_failed", async () => {
    const error = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "AUTHENTICATIONFAILED",
      responseText: "Invalid credentials",
    });
    const res = await connectWith(error);
    expect(res.status).toBe(400);
    expect(res.code).toBe("auth_failed");
    expect(res.err).toBeTruthy();
  });

  it("an unresolvable host answers 400 unreachable", async () => {
    const error = Object.assign(new Error("getaddrinfo ENOTFOUND mail.example.test"), {
      code: "ENOTFOUND",
    });
    const res = await connectWith(error);
    expect(res.status).toBe(400);
    expect(res.code).toBe("unreachable");
  });

  it("a missing mailbox answers 400 mailbox_not_found", async () => {
    const error = Object.assign(new Error("Command failed"), {
      mailboxMissing: true,
      responseText: "Mailbox doesn't exist",
    });
    const res = await connectWith(error);
    expect(res.status).toBe(400);
    expect(res.code).toBe("mailbox_not_found");
  });

  it("a self-signed certificate answers 400 tls_failed", async () => {
    const error = new Error("self signed certificate in certificate chain");
    const res = await connectWith(error);
    expect(res.status).toBe(400);
    expect(res.code).toBe("tls_failed");
  });

  it("an unrecognised failure answers 400 connect_failed", async () => {
    const res = await connectWith(new Error("no branch matches this text"));
    expect(res.status).toBe(400);
    expect(res.code).toBe("connect_failed");
  });

  it("nothing is persisted when the verify login fails", async () => {
    await connectWith(
      Object.assign(new Error("Command failed"), { authenticationFailed: true })
    );
    const integrations = await store.collection("emailIntegrations").get();
    expect(integrations.docs.length).toBe(0);
  });
});
