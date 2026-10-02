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
import { VICTIM } from "./victim";

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

// The worker's agent loop needs a model; what is under test is everything the
// route does around it, so the loop finishes at once with no messages.
vi.mock("@/lib/agent/worker-graph", () => ({
  streamWorkerGraph: async function* () {
    return;
  },
}));

// /api/agent's graph needs a model. The stub proposes one confirmation-gated
// call and records what a confirmation actually resumes with.
const resumed: unknown[] = [];
vi.mock("@/lib/agent/graph", () => ({
  runAgentGraph: async () => ({
    messages: [],
    pendingConfirmation: {
      toolName: "updateTransaction",
      toolCallId: "call-1",
      args: { transactionId: "a-tx-1", description: "as proposed" },
    },
  }),
  continueAfterConfirmation: async (input: { pendingToolCall: unknown; confirmed: boolean }) => {
    resumed.push({ ...(input.pendingToolCall as object), confirmed: input.confirmed });
    return { messages: [], pendingConfirmation: null };
  },
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

describe("worker trigger context", () => {
  async function attackerNotifications(): Promise<string> {
    const snap = await getFirestore().collection(`users/${ATTACKER}/notifications`).get();
    return JSON.stringify(snap.docs.map((d) => d.data()));
  }

  const run = async (triggerContext: Record<string, unknown>, workerType = "receipt_search") => {
    const { POST } = await import("@/app/api/worker/route");
    return POST(
      asUser(ATTACKER, "/api/worker", {
        body: { workerType, initialPrompt: "go", triggeredBy: "auto", triggerContext },
      }),
    );
  };

  it("positive control: my own Transaction's name reaches my notification", async () => {
    const res = await run({ transactionId: A.transaction });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await attackerNotifications()).toContain("Mine");
  });

  const attacks: Array<[string, Record<string, unknown>, string?]> = [
    ["transactionId", { transactionId: V.transaction }],
    ["fileId", { fileId: V.file }],
    ["fileIds", { fileIds: [A.file, V.file] }],
    ["partnerId", { partnerId: V.partner, fileIds: [A.file] }, "partner_file_batch"],
    ["partner batch file", { partnerId: A.partner, fileIds: [V.file] }, "partner_file_batch"],
    ["path-shaped id", { transactionId: `../transactions/${V.transaction}` }],
  ];
  for (const [label, ctx, type] of attacks) {
    it(`refuses another user's ${label}`, async () => {
      const res = await run(ctx, type);
      await expectRefused(res, `worker(${label})`);
      assertNoLeak(await attackerNotifications(), `worker(${label}) notifications`);
      const runs = await getFirestore().collection(`users/${ATTACKER}/workerRuns`).get();
      expect(runs.size, "no run is created for a refused context").toBe(0);
    });
  }

  it("refuses a partner batch whose queued state names another user's File", async () => {
    // The batch state lives under the attacker's own user doc; a planted
    // queued id must not become the run's context.
    await getFirestore().doc(`users/${ATTACKER}/partnerBatchStates/${A.partner}`).set({
      userId: ATTACKER,
      partnerId: A.partner,
      status: "pending",
      queuedFileIds: [V.file],
      inflightFileIds: [],
    });
    const res = await run({ partnerId: A.partner, fileIds: [A.file] }, "partner_file_batch");
    await expectRefused(res, "worker(planted batch state)");
    assertNoLeak(await attackerNotifications(), "worker(planted batch state) notifications");
  });
});

describe("/api/agent confirmations run only what the server proposed", () => {
  beforeEach(() => {
    resumed.length = 0;
  });

  async function propose(uid: string): Promise<string> {
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(asUser(uid, "/api/agent", { body: { messages: [{ role: "user", content: "hi" }] } }));
    const body = await res.json();
    expect(body.pendingConfirmation?.token).toMatch(/^[0-9a-f]{64}$/);
    return body.pendingConfirmation.token;
  }

  async function confirm(uid: string, confirmation: Record<string, unknown>) {
    const { POST } = await import("@/app/api/agent/route");
    return POST(asUser(uid, "/api/agent", { body: { messages: [], confirmation } }));
  }

  it("a client-chosen tool and args are never run", async () => {
    const res = await confirm(ATTACKER, {
      confirmed: true,
      toolName: "createSource",
      toolCallId: "forged",
      args: { name: "forged", iban: "AT00" },
    });
    expect(res.status).toBe(409);
    expect(resumed).toEqual([]);
  });

  it("an issued token resumes the proposed call, ignoring args in the body, exactly once", async () => {
    const token = await propose(ATTACKER);
    const res = await confirm(ATTACKER, { confirmed: true, token, toolName: "createSource", args: { name: "forged" } });
    expect(res.status).toBe(200);
    expect(resumed).toEqual([
      { toolName: "updateTransaction", toolCallId: "call-1", args: { transactionId: "a-tx-1", description: "as proposed" }, confirmed: true },
    ]);
    const replay = await confirm(ATTACKER, { confirmed: true, token });
    expect(replay.status).toBe(409);
    expect(resumed).toHaveLength(1);
  });

  it("another user's token is refused and stays usable by its owner", async () => {
    const token = await propose(VICTIM);
    const stolen = await confirm(ATTACKER, { confirmed: true, token });
    expect(stolen.status).toBe(409);
    expect(resumed).toEqual([]);
    const own = await confirm(VICTIM, { confirmed: true, token });
    expect(own.status).toBe(200);
    expect(resumed).toHaveLength(1);
  });
});
