/**
 * Route smoke over PATCH /api/mail/imap/credentials — repairing a broken
 * mailbox in place instead of disconnecting and reconnecting it.
 *
 * What the suite is actually defending. Before this route, a rejected IMAP
 * login set `needsReauth`, which the nightly sync filters out and the manual
 * sync route refuses; only a successful sync cleared it, and none could be
 * attempted. The escape was disconnect-then-connect, which soft-deletes files
 * from that mailbox not yet matched to a transaction. So the load-bearing
 * assertions here are the two that separate this route from that escape: a
 * successful repair leaves files and queue state alone, and a failed one
 * writes nothing at all.
 *
 * Codes are pinned; messages are not — they are copy, and rewording them is
 * not a regression.
 *
 * Runs under the api-smoke profile ONLY (needs root node_modules for
 * next/imapflow); the db and identity wiring is ./route-harness. The verify
 * login is stubbed at the imapflow seam: no socket is opened.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { setupRouteHarness } from "./route-harness";

const { store, authed } = setupRouteHarness();

/** What the stubbed client throws on connect(); undefined means it succeeds. */
const imap: { connectError: unknown } = { connectError: undefined };

vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect(): Promise<void> {
      if (imap.connectError) throw imap.connectError;
    }
    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => {} };
    }
    async logout(): Promise<void> {}
    close(): void {}
  },
}));

// The route encrypts the app-password before storing it. 64 hex chars = the
// 32-byte key the crypto helper requires.
process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "a".repeat(64);

const MAILBOX_ID = "mailbox-1";

/** A broken mailbox: flagged for reauth, carrying a classified auth failure. */
function seedBrokenMailbox(): void {
  store.seed("emailIntegrations", MAILBOX_ID, {
    userId: "user-A",
    provider: "imap",
    email: "someone@example.test",
    displayName: "someone@example.test",
    isActive: true,
    needsReauth: true,
    lastSyncErrorCode: "auth_failed",
    lastError: "Authentication failed.",
    lastSyncError: "Authentication failed.",
    imapHost: "mail.example.test",
    imapPort: 993,
    imapSecure: true,
    imapMailbox: "INBOX",
    imapAllowSelfSigned: false,
  });
  store.seed("emailTokens", MAILBOX_ID, {
    integrationId: MAILBOX_ID,
    userId: "user-A",
    provider: "imap",
    secret: "old-ciphertext",
    secretIv: "old-iv",
  });
}

function patchRequest(uid: string, body: Record<string, unknown>): NextRequest {
  return authed(uid, "http://test.local/api/mail/imap/credentials", "PATCH", body);
}

async function repair(
  uid: string,
  body: Record<string, unknown>
): Promise<{ status: number; code?: string }> {
  const { PATCH } = await import("@/app/api/mail/imap/credentials/route");
  const res = await PATCH(patchRequest(uid, body));
  const parsed = (await res.json()) as { code?: string };
  return { status: res.status, code: parsed.code };
}

/** Read a document straight out of the double. */
async function read(collection: string, id: string): Promise<Record<string, unknown>> {
  const snap = await store.collection(collection).doc(id).get();
  return (snap.data() ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  imap.connectError = undefined;
  seedBrokenMailbox();
});

describe("PATCH /api/mail/imap/credentials — a verified repair", () => {
  it("stores the new secret and clears the failure state", async () => {
    const { status } = await repair("user-A", {
      integrationId: MAILBOX_ID,
      password: "new-app-password",
    });
    expect(status).toBe(200);

    const token = await read("emailTokens", MAILBOX_ID);
    expect(token.secret).not.toBe("old-ciphertext");
    expect(token.secretIv).not.toBe("old-iv");

    const mailbox = await read("emailIntegrations", MAILBOX_ID);
    expect(mailbox.needsReauth).toBe(false);
    expect(mailbox.lastSyncErrorCode).toBeNull();
    expect(mailbox.lastError).toBeNull();
    expect(mailbox.lastSyncError).toBeNull();
  });

  it("applies supplied connection settings and keeps the omitted ones", async () => {
    await repair("user-A", {
      integrationId: MAILBOX_ID,
      password: "new-app-password",
      mailbox: "Archive",
    });

    const mailbox = await read("emailIntegrations", MAILBOX_ID);
    expect(mailbox.imapMailbox).toBe("Archive");
    // Untouched by the request, so they must survive it. An omitted field
    // means "keep", never "reset to default".
    expect(mailbox.imapHost).toBe("mail.example.test");
    expect(mailbox.imapPort).toBe(993);
    expect(mailbox.imapSecure).toBe(true);
  });

  it("leaves the mailbox's files and sync state alone", async () => {
    // The whole reason this route exists: the disconnect it replaces
    // soft-deletes unmatched files and drops queue state.
    store.seed("files", "file-1", {
      userId: "user-A",
      gmailIntegrationId: MAILBOX_ID,
      isDeleted: false,
    });
    store.seed("gmailSyncQueue", "queue-1", {
      userId: "user-A",
      integrationId: MAILBOX_ID,
      status: "failed",
      processedMessageIds: ["msg-1", "msg-2"],
    });

    await repair("user-A", { integrationId: MAILBOX_ID, password: "new-app-password" });

    const file = await read("files", "file-1");
    expect(file.isDeleted).toBe(false);
    const queueItem = await read("gmailSyncQueue", "queue-1");
    expect(queueItem.processedMessageIds).toEqual(["msg-1", "msg-2"]);
  });
});

describe("PATCH /api/mail/imap/credentials — a rejected login", () => {
  it("answers 400 auth_failed", async () => {
    imap.connectError = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      responseText: "Authentication failed",
    });
    const { status, code } = await repair("user-A", {
      integrationId: MAILBOX_ID,
      password: "still-wrong",
    });
    expect(status).toBe(400);
    expect(code).toBe("auth_failed");
  });

  it("writes nothing at all", async () => {
    imap.connectError = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
    });
    await repair("user-A", { integrationId: MAILBOX_ID, password: "still-wrong" });

    // A user checking a guess at their password cannot be allowed to make
    // things worse: neither the credential nor the flags may move.
    const token = await read("emailTokens", MAILBOX_ID);
    expect(token.secret).toBe("old-ciphertext");
    expect(token.secretIv).toBe("old-iv");

    const mailbox = await read("emailIntegrations", MAILBOX_ID);
    expect(mailbox.needsReauth).toBe(true);
    expect(mailbox.lastSyncErrorCode).toBe("auth_failed");
  });

  it("reports an unreachable server as unreachable, not as bad credentials", async () => {
    imap.connectError = new Error("connect ECONNREFUSED 10.0.0.9:993");
    const { status, code } = await repair("user-A", {
      integrationId: MAILBOX_ID,
      password: "new-app-password",
    });
    expect(status).toBe(400);
    expect(code).toBe("unreachable");
  });
});

describe("PATCH /api/mail/imap/credentials — what it refuses", () => {
  it("does not find another user's mailbox", async () => {
    const { status } = await repair("user-B", {
      integrationId: MAILBOX_ID,
      password: "new-app-password",
    });
    expect(status).toBe(404);

    const token = await read("emailTokens", MAILBOX_ID);
    expect(token.secret).toBe("old-ciphertext");
  });

  it("refuses a Gmail integration", async () => {
    store.seed("emailIntegrations", "gmail-1", {
      userId: "user-A",
      provider: "gmail",
      email: "someone@gmail.test",
      isActive: true,
      needsReauth: true,
    });
    const { status, code } = await repair("user-A", {
      integrationId: "gmail-1",
      password: "new-app-password",
    });
    expect(status).toBe(400);
    expect(code).toBe("wrong_provider");
  });

  it("requires a password", async () => {
    const { status } = await repair("user-A", { integrationId: MAILBOX_ID });
    expect(status).toBe(400);
  });

  it("rejects an unauthenticated caller", async () => {
    const { PATCH } = await import("@/app/api/mail/imap/credentials/route");
    const res = await PATCH(
      new NextRequest("http://test.local/api/mail/imap/credentials", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ integrationId: MAILBOX_ID, password: "x" }),
      })
    );
    expect(res.status).toBe(401);
  });
});
