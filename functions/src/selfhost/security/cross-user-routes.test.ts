/**
 * Cross-user isolation, Next API routes: each route an audit found trusting a
 * caller-supplied id, called as the attacker with the victim's ids.
 *
 * Mail providers and the PDF renderer are stubbed at their module seams so
 * the routes reach the code that decides what to write. The stubs only ever
 * answer for the attacker's own mailbox: what is under test is whether the
 * route then lets that mailbox's attachment land on someone else's
 * Transaction.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { __resetFirestoreShim, getFirestore, Timestamp } from "../firestore-shim";
import { __resetTriggerShim } from "../trigger-shim";
import {
  ATTACKER,
  A,
  V,
  CANARY,
  seedAccounts,
  victimRows,
  assertVictimUntouched,
  assertNoLeak,
} from "./victim";
import { asUser, enableInternalAuth } from "./routes";

vi.mock("@/lib/gmail/resolve-integration", () => {
  class GmailResolutionError extends Error {
    constructor(message: string, public status: number, public code: string) {
      super(message);
    }
  }
  return {
    GmailResolutionError,
    resolveGmailIntegration: async () => ({
      integrationId: "a-mail-1",
      accessToken: "access",
      refreshToken: "refresh",
      integration: { email: "attacker@mail.test" },
    }),
  };
});

vi.mock("@/lib/email-providers/gmail-client", () => {
  class GmailClient {
    async getAttachmentData() {
      const data = new TextEncoder().encode(`%PDF attacker bytes ${Math.random()}`);
      return { data, mimeType: "application/pdf", filename: "attacker.pdf", size: data.length };
    }
  }
  return { GmailClient, default: GmailClient };
});

vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: async () => ({
    success: true,
    pdfBase64: Buffer.from(`%PDF rendered ${Math.random()}`).toString("base64"),
    pageCount: 1,
  }),
}));

beforeAll(() => {
  enableInternalAuth();
  // The Gmail message read in convert-to-pdf goes straight to fetch.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          threadId: "t-1",
          snippet: "hello",
          payload: { mimeType: "text/html", headers: [{ name: "Subject", value: "Invoice" }, { name: "Date", value: "Tue, 1 Sep 2026 10:00:00 +0200" }], body: { data: Buffer.from("<p>hi</p>").toString("base64") } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
});

let before: Map<string, string>;

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedAccounts();
  const db = getFirestore();
  // Search history lives under the transaction, with no userId of its own.
  await db.doc(`transactions/${V.transaction}/searches/v-search-1`).set({
    triggeredBy: CANARY,
    status: "completed",
    createdAt: Timestamp.now(),
    attempts: [{ strategy: CANARY, searchParams: { q: CANARY } }],
  });
  await db.doc(`transactions/${A.transaction}/searches/a-search-1`).set({
    triggeredBy: "manual",
    status: "completed",
    createdAt: Timestamp.now(),
  });
  before = await victimRows();
});

async function expectRefused(res: Response, label: string): Promise<void> {
  const text = await res.text();
  assertNoLeak(text, label);
  expect(res.status, `${label}: ${text}`).toBe(404);
  await assertVictimUntouched(before, label);
}

describe("mail attach routes: a Transaction id must be the caller's", () => {
  const attachBody = (transactionId: string) => ({
    integrationId: A.integration,
    messageId: "m-1",
    attachmentId: "att-1",
    transactionId,
  });

  it("positive control: attaching to my own Transaction connects it", async () => {
    const { POST } = await import("@/app/api/gmail/attachment/route");
    const res = await POST(asUser(ATTACKER, "/api/gmail/attachment", { body: attachBody(A.transaction) }));
    expect(res.status).toBe(200);
    const tx = (await getFirestore().doc(`transactions/${A.transaction}`).get()).data();
    expect(tx?.fileIds?.length).toBe(1);
  });

  it("positive control: converting a mail onto my own Transaction connects it", async () => {
    const { POST } = await import("@/app/api/gmail/convert-to-pdf/route");
    const res = await POST(
      asUser(ATTACKER, "/api/gmail/convert-to-pdf", { body: { integrationId: A.integration, messageId: "m-1", transactionId: A.transaction } }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const tx = (await getFirestore().doc(`transactions/${A.transaction}`).get()).data();
    expect(tx?.fileIds?.length).toBe(1);
  });

  for (const route of ["gmail", "mail"] as const) {
    it(`/api/${route}/attachment refuses the victim's Transaction`, async () => {
      const { POST } = await import(`@/app/api/${route}/attachment/route`);
      const res = await POST(asUser(ATTACKER, `/api/${route}/attachment`, { body: attachBody(V.transaction) }));
      await expectRefused(res, `${route}/attachment`);
    });

    it(`/api/${route}/attachment refuses the victim's Transaction for an already-stored File`, async () => {
      // The dedup branch connects an existing File; it had its own unchecked write.
      const { POST } = await import(`@/app/api/${route}/attachment/route`);
      const first = await POST(asUser(ATTACKER, `/api/${route}/attachment`, { body: { ...attachBody(A.transaction), attachmentId: "same" } }));
      expect(first.status).toBe(200);
      const res = await POST(asUser(ATTACKER, `/api/${route}/attachment`, { body: { ...attachBody(V.transaction), attachmentId: "same" } }));
      await expectRefused(res, `${route}/attachment (existing file)`);
    });

    it(`/api/${route}/convert-to-pdf refuses the victim's Transaction`, async () => {
      const { POST } = await import(`@/app/api/${route}/convert-to-pdf/route`);
      const res = await POST(
        asUser(ATTACKER, `/api/${route}/convert-to-pdf`, { body: { integrationId: A.integration, messageId: "m-1", transactionId: V.transaction } }),
      );
      await expectRefused(res, `${route}/convert-to-pdf`);
    });
  }

  it("a path-shaped or non-string Transaction id is refused the same way", async () => {
    const { POST } = await import("@/app/api/gmail/attachment/route");
    for (const transactionId of [`../transactions/${V.transaction}`, { id: V.transaction }, [V.transaction]]) {
      const res = await POST(asUser(ATTACKER, "/api/gmail/attachment", { body: attachBody(transactionId as string) }));
      await expectRefused(res, `attachment(${JSON.stringify(transactionId)})`);
    }
  });

  it("a missing Transaction answers exactly like a foreign one (no existence oracle)", async () => {
    const { POST } = await import("@/app/api/gmail/attachment/route");
    const foreign = await POST(asUser(ATTACKER, "/api/gmail/attachment", { body: attachBody(V.transaction) }));
    const missing = await POST(asUser(ATTACKER, "/api/gmail/attachment", { body: attachBody("does-not-exist") }));
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.text()).toBe(await missing.text());
  });
});

describe("precision search status", () => {
  it("positive control: my own Transaction's history comes back", async () => {
    const { GET } = await import("@/app/api/precision-search/status/route");
    const res = await GET(asUser(ATTACKER, `/api/precision-search/status?transactionId=${A.transaction}`));
    expect(res.status).toBe(200);
    expect((await res.json()).history).toHaveLength(1);
  });

  it("refuses another user's Transaction", async () => {
    const { GET } = await import("@/app/api/precision-search/status/route");
    const res = await GET(asUser(ATTACKER, `/api/precision-search/status?transactionId=${V.transaction}`));
    await expectRefused(res, "precision-search/status");
  });
});
