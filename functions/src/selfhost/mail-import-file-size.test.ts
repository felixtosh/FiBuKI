/**
 * #722: a File imported over IMAP recorded the size of the encoded mail part.
 *
 * An IMAP server's BODYSTRUCTURE reports a part's size as it sits in the
 * message: base64 at 4/3, plus a CRLF every 76 characters. The provider hands
 * back the decoded bytes, and those are what FiBuKI stores, so the File's size
 * is their length, whatever the Mail Provider reported.
 *
 * Driven through the sync worker against the self-host Firestore and storage
 * shims; only the mailbox is stubbed.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const h = vi.hoisted(() => ({
  box: {
    encodedPart: "",
    reportedSize: 0,
  },
}));

// An IMAP-shaped mailbox: the attachment's size is the encoded part's length,
// as imapflow reads it from BODYSTRUCTURE, and getAttachment decodes the part.
vi.mock("../mail", async (importActual) => {
  const actual = await importActual<typeof import("../mail")>();
  return {
    ...actual,
    makeProvider: () => ({
      search: async () => ({ messages: [{ id: "uid-1" }], nextPageToken: undefined }),
      getMessage: async () => ({
        id: "uid-1",
        messageId: "<invoice-1@acme.example>",
        from: "Acme GmbH <billing@acme.example>",
        subject: "Rechnung 2026-001",
        date: new Date("2026-08-10T00:00:00Z"),
        attachments: [
          {
            attachmentId: "2",
            filename: "rechnung.pdf",
            mimeType: "application/pdf",
            size: h.box.reportedSize,
          },
        ],
      }),
      getAttachment: async () => Buffer.from(h.box.encodedPart, "base64"),
      close: async () => {},
    }),
  };
});

vi.mock("../utils/encryption", () => ({
  decrypt: () => "app-password",
  encrypt: (plaintext: string) => ({ encrypted: `enc:${plaintext}`, iv: "iv" }),
}));

import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { _resetStorageForTests } from "./storage-shim";
import { processQueueItem } from "../gmail/gmailSyncQueue";

const db = getFirestore();
const USER = "u-722";
const INTEGRATION = "integration-722";
const QUEUE_ITEM = "queue-item-722";

const OPTIONS = {
  clientId: "client-id",
  clientSecret: "client-secret",
  encryptionKey: "encryption-key",
};

/** Base64 wrapped at 76 characters with CRLF, as a MIME part carries it. */
function mimeBase64(bytes: Buffer): string {
  return (bytes.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

async function seed() {
  await db.collection("emailIntegrations").doc(INTEGRATION).set({
    userId: USER,
    provider: "imap",
    email: "user@example.com",
    isActive: true,
    imapHost: "mail.example.test",
    imapPort: 993,
    imapSecure: true,
    imapMailbox: "INBOX",
  });
  await db.collection("emailTokens").doc(INTEGRATION).set({
    integrationId: INTEGRATION,
    userId: USER,
    provider: "imap",
    secret: "cipher",
    secretIv: "iv",
  });
  const now = Timestamp.now();
  const item = {
    id: QUEUE_ITEM,
    userId: USER,
    integrationId: INTEGRATION,
    type: "manual" as const,
    status: "processing" as const,
    dateFrom: Timestamp.fromDate(new Date("2026-08-01T00:00:00Z")),
    dateTo: Timestamp.fromDate(new Date("2026-08-20T00:00:00Z")),
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

const prevStorage = process.env.FIBUKI_STORAGE;

beforeEach(async () => {
  process.env.FIBUKI_STORAGE = "memory";
  _resetStorageForTests();
  await __whenShimIdle();
  await __resetFirestoreShim();
});

afterAll(() => {
  if (prevStorage === undefined) delete process.env.FIBUKI_STORAGE;
  else process.env.FIBUKI_STORAGE = prevStorage;
  _resetStorageForTests();
});

describe("mail import — the File's size (#722)", () => {
  it("records the decoded length of a base64, line-wrapped IMAP attachment", async () => {
    // 3000 bytes: 4000 base64 characters over 53 lines, 52 CRLFs between them.
    const bytes = Buffer.alloc(3000, 0x25);
    const encodedPart = mimeBase64(bytes);
    h.box.encodedPart = encodedPart;
    h.box.reportedSize = encodedPart.length;
    expect(encodedPart.length).toBe(4104);

    const item = await seed();
    await processQueueItem(item, OPTIONS);

    const files = await db.collection("files").where("userId", "==", USER).get();
    expect(files.size).toBe(1);
    expect(files.docs[0].data()?.fileSize).toBe(bytes.length);
  });

  it("keeps the size a Gmail-shaped provider reports, which is already the decoded length", async () => {
    // The Gmail API reports an attachment's decoded size; the File records the same.
    const bytes = Buffer.alloc(3000, 0x25);
    h.box.encodedPart = bytes.toString("base64");
    h.box.reportedSize = bytes.length;

    const item = await seed();
    await processQueueItem(item, OPTIONS);

    const files = await db.collection("files").where("userId", "==", USER).get();
    expect(files.size).toBe(1);
    expect(files.docs[0].data()?.fileSize).toBe(3000);
  });
});
