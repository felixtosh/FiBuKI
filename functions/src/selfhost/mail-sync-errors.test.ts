/**
 * The sync worker's IMAP failure path, driven against the self-host Firestore
 * shim (#178).
 *
 * What is being pinned: a broken IMAP mailbox has to say which of five things
 * is wrong, and a failure the user cannot fix by waiting must not be retried
 * three times into the same wall — three rejected logins per sync is how a mail
 * server decides to rate-limit or lock an account.
 *
 * Assertions read the documents the run leaves behind (the integration's
 * classified code, whether a retry item exists), never which internal function
 * ran. The user-facing message strings are copy and deliberately unpinned.
 *
 * The mail provider is stubbed so a "failure" is a staged throw rather than a
 * live mailbox — but `classifyImapError` itself is the real one, since the
 * classification is the decision under test.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  box: { searchError: undefined as unknown },
}));

// Real module, except that makeProvider yields a mailbox whose search() throws
// whatever the test staged. classifyImapError stays real.
vi.mock("../mail", async (importActual) => {
  const actual = await importActual<typeof import("../mail")>();
  return {
    ...actual,
    makeProvider: () => ({
      search: async () => {
        if (h.box.searchError) throw h.box.searchError;
        return { messages: [], nextPageToken: undefined };
      },
      getMessage: async () => {
        throw new Error("not reached");
      },
      getAttachment: async () => {
        throw new Error("not reached");
      },
      close: async () => {},
    }),
  };
});

// The stored app-password is opaque here; the worker only needs it to come back
// as a string it can hand to the provider.
vi.mock("../utils/encryption", () => ({
  decrypt: () => "app-password",
  encrypt: (plaintext: string) => ({ encrypted: `enc:${plaintext}`, iv: "iv" }),
}));

import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { processQueueItem } from "../gmail/gmailSyncQueue";

const db = getFirestore();
const USER = "stefan-test";
const INTEGRATION = "integration-1";
const QUEUE_ITEM = "queue-item-1";

const OPTIONS = {
  clientId: "client-id",
  clientSecret: "client-secret",
  encryptionKey: "encryption-key",
};

/** An imapflow-shaped failure: the useful part rides on the error object. */
const imapError = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), extra);

async function seedIntegration(overrides: Record<string, unknown> = {}) {
  await db.collection("emailIntegrations").doc(INTEGRATION).set({
    userId: USER,
    provider: "imap",
    email: "stefan@example.com",
    isActive: true,
    needsReauth: false,
    imapHost: "mail.example.test",
    imapPort: 993,
    imapSecure: true,
    imapMailbox: "INBOX",
    ...overrides,
  });
  await db.collection("emailTokens").doc(INTEGRATION).set({
    integrationId: INTEGRATION,
    userId: USER,
    provider: "imap",
    secret: "cipher",
    secretIv: "iv",
  });
}

/** Seed the queue document the worker settles, and return the item it is given. */
async function seedQueueItem(type: "initial" | "scheduled" | "manual" = "manual") {
  const now = Timestamp.now();
  const dateFrom = Timestamp.fromDate(new Date("2026-08-01T00:00:00Z"));
  const dateTo = Timestamp.fromDate(new Date("2026-08-20T00:00:00Z"));
  const item = {
    id: QUEUE_ITEM,
    userId: USER,
    integrationId: INTEGRATION,
    type,
    status: "processing" as const,
    dateFrom,
    dateTo,
    emailsProcessed: 0,
    filesCreated: 0,
    attachmentsSkipped: 0,
    errors: [] as string[],
    retryCount: 0,
    maxRetries: 3,
    processedMessageIds: [] as string[],
    createdAt: now,
    startedAt: now,
  };
  await db.collection("gmailSyncQueue").doc(QUEUE_ITEM).set(item);
  return item;
}

async function integration(): Promise<Record<string, unknown>> {
  const snap = await db.collection("emailIntegrations").doc(INTEGRATION).get();
  return (snap.data() ?? {}) as Record<string, unknown>;
}

/** Every queue document for this integration, original and retry clones alike. */
async function queueDocs() {
  const snap = await db
    .collection("gmailSyncQueue")
    .where("integrationId", "==", INTEGRATION)
    .get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

const pendingRetries = (docs: Record<string, unknown>[]) =>
  docs.filter((d) => d.status === "pending");

beforeEach(() => {
  __resetFirestoreShim();
  h.box.searchError = undefined;
});

describe("processQueueItem — IMAP failures", () => {
  it("classifies a rejected login, flags reauth, and does not retry", async () => {
    await seedIntegration();
    const item = await seedQueueItem();
    h.box.searchError = imapError("Command failed", {
      authenticationFailed: true,
      serverResponseCode: "AUTHENTICATIONFAILED",
    });

    await processQueueItem(item, OPTIONS);

    const doc = await integration();
    expect(doc.lastSyncErrorCode).toBe("auth_failed");
    expect(doc.needsReauth).toBe(true);
    expect(doc.lastSyncStatus).toBe("failed");

    const docs = await queueDocs();
    expect(pendingRetries(docs)).toHaveLength(0);
    expect(docs.every((d) => d.status === "failed")).toBe(true);
  });

  it("classifies a missing mailbox and does not retry", async () => {
    await seedIntegration();
    const item = await seedQueueItem();
    h.box.searchError = imapError("Command failed", {
      mailboxMissing: true,
      responseText: "Mailbox doesn't exist",
    });

    await processQueueItem(item, OPTIONS);

    const doc = await integration();
    expect(doc.lastSyncErrorCode).toBe("mailbox_not_found");
    // Not a credential problem — the badge stays off.
    expect(doc.needsReauth).toBe(false);
    expect(pendingRetries(await queueDocs())).toHaveLength(0);
  });

  it("classifies an unreachable server, leaves reauth alone, and still retries", async () => {
    await seedIntegration();
    const item = await seedQueueItem();
    h.box.searchError = imapError("getaddrinfo ENOTFOUND mail.example.test");

    await processQueueItem(item, OPTIONS);

    const doc = await integration();
    expect(doc.lastSyncErrorCode).toBe("unreachable");
    expect(doc.needsReauth).toBe(false);

    const retries = pendingRetries(await queueDocs());
    expect(retries).toHaveLength(1);
    expect(retries[0].retryCount).toBe(1);
  });

  it("keeps retrying a transient failure until the retry budget is spent", async () => {
    await seedIntegration();
    const item = { ...(await seedQueueItem()), retryCount: 3, maxRetries: 3 };
    h.box.searchError = imapError("getaddrinfo ENOTFOUND mail.example.test");

    await processQueueItem(item, OPTIONS);

    expect((await integration()).lastSyncErrorCode).toBe("unreachable");
    expect(pendingRetries(await queueDocs())).toHaveLength(0);
  });

  it("a successful sync clears the classified code and the reauth flag", async () => {
    await seedIntegration({ needsReauth: true, lastSyncErrorCode: "auth_failed" });
    const item = await seedQueueItem();

    await processQueueItem(item, OPTIONS);

    const doc = await integration();
    expect(doc.lastSyncErrorCode).toBeNull();
    expect(doc.needsReauth).toBe(false);
    expect(doc.lastSyncStatus).toBe("success");
  });
});

describe("processQueueItem — Gmail is unaffected", () => {
  async function seedGmail() {
    await db.collection("emailIntegrations").doc(INTEGRATION).set({
      userId: USER,
      provider: "gmail",
      email: "stefan@example.com",
      isActive: true,
      needsReauth: false,
    });
    await db.collection("emailTokens").doc(INTEGRATION).set({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)),
    });
  }

  it("a Gmail failure is not classified and keeps its retry", async () => {
    await seedGmail();
    const item = await seedQueueItem();
    // Same wire-level failure that classifies as `unreachable` for IMAP.
    h.box.searchError = imapError("getaddrinfo ENOTFOUND gmail.googleapis.com");

    await processQueueItem(item, OPTIONS);

    const doc = await integration();
    expect(doc.lastSyncErrorCode).toBeUndefined();
    expect(doc.needsReauth).toBe(false);

    const retries = pendingRetries(await queueDocs());
    expect(retries).toHaveLength(1);
    expect(retries[0].retryCount).toBe(1);
  });

  it("a successful Gmail sync leaves the reauth flag untouched", async () => {
    await seedGmail();
    await db.collection("emailIntegrations").doc(INTEGRATION).update({ needsReauth: true });
    const item = await seedQueueItem();

    await processQueueItem(item, OPTIONS);

    const doc = await integration();
    // Gmail's needsReauth belongs to the OAuth pause/resume flow, not to us.
    expect(doc.needsReauth).toBe(true);
    expect(doc.lastSyncErrorCode).toBeUndefined();
  });
});
