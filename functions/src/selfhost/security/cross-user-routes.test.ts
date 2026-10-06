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
  VICTIM,
  A,
  V,
  CANARY,
  seedAccounts,
  victimRows,
  assertVictimUntouched,
  assertNoLeak,
} from "./victim";
import { asUser, anonymous, enableInternalAuth } from "./routes";

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

// The PDF renderer is stubbed. A connect goes to the real callable, as the
// user whose bearer token the route forwards (#612): the File Connection
// writer is what decides whether the Transaction is theirs.
vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: async (name: string, data: unknown, token?: string) => {
    if (name === "connectFileToTransaction") {
      const { connectFileToTransactionCallable } = await import("../../files/connectFileToTransaction");
      const uid = (token ?? "").replace(/^Bearer /, "");
      try {
        return await (connectFileToTransactionCallable as unknown as { run: (r: unknown) => Promise<unknown> }).run({
          data,
          auth: { uid, token: {} },
        });
      } catch (err) {
        // The shape the real helper throws on an HTTP error.
        throw new Error(
          `Firebase function ${name} failed: 400 - ${JSON.stringify({ error: { message: (err as Error).message } })}`
        );
      }
    }
    return {
      success: true,
      pdfBase64: Buffer.from(`%PDF rendered ${Math.random()}`).toString("base64"),
      pageCount: 1,
    };
  },
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

// The TrueLayer routes use the client Firestore SDK server-side. Here it is
// pointed at the same shim database, with no rules in between, so what is
// tested is the routes' own checks rather than the indirect protection a
// rules engine happens to give them today.
vi.mock("firebase/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
vi.mock("firebase/firestore", async () => {
  const shim = await import("../firestore-shim");
  const db = () => shim.getFirestore();
  const wrap = (snap: { id: string; exists: boolean; data: () => Record<string, unknown> | undefined }) => ({
    id: snap.id,
    exists: () => snap.exists,
    data: () => snap.data(),
  });
  return {
    getFirestore: () => ({}),
    connectFirestoreEmulator: () => {},
    Timestamp: shim.Timestamp,
    doc: (_db: unknown, coll: string, id: string) => db().collection(coll).doc(id),
    collection: (_db: unknown, coll: string) => db().collection(coll),
    getDoc: async (ref: { get: () => Promise<never> }) => wrap(await ref.get()),
    updateDoc: (ref: { update: (d: unknown) => Promise<unknown> }, d: unknown) => ref.update(d),
    addDoc: (coll: { add: (d: unknown) => Promise<unknown> }, d: unknown) => coll.add(d),
    where: (f: string, op: string, v: unknown) => ({ f, op, v }),
    query: (coll: { where: (...a: unknown[]) => unknown }, ...ws: Array<{ f: string; op: string; v: unknown }>) =>
      ws.reduce((q: { where: (...a: unknown[]) => unknown }, w) => q.where(w.f, w.op, w.v) as never, coll),
    getDocs: async (q: { get: () => Promise<{ docs: unknown[] }> }) => q.get(),
  };
});

// The real module pulls in the browser Firebase config; only the hash is used.
vi.mock("@/lib/import/deduplication", () => ({
  generateDedupeHash: async (...parts: unknown[]) => parts.map(String).join("|"),
  normalizeIban: (iban: string) => iban.replace(/\s/g, "").toUpperCase(),
}));

const trueLayerTokensUsed: string[] = [];
vi.mock("@/lib/truelayer", () => ({
  getAccountIban: (account: { account_number?: { iban?: string } }) => account.account_number?.iban,
  getTrueLayerClient: () => ({
    getTransactions: async (token: string) => {
      trueLayerTokensUsed.push(token);
      return [{ transaction_id: "tl-1", timestamp: "2026-09-01T10:00:00Z", amount: 12.5, currency: "EUR", transaction_type: "DEBIT", description: "planted" }];
    },
    getAccount: async (token: string) => {
      trueLayerTokensUsed.push(token);
      return { account_id: "acc-1", currency: "EUR", account_number: { iban: "AT483200000012345864" } };
    },
    refreshToken: async () => {
      throw new Error("no refresh in tests");
    },
  }),
}));

// The two model-calling routes: count calls instead of spending money.
const modelCalls: string[] = [];
vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          modelCalls.push("generateContent");
          return { response: { candidates: [{ content: { parts: [{ text: '{"queries":["probe"],"commands":[],"isDone":true}' }] } }] } };
        },
      };
    }
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
  // These routes forward the caller's bearer token to the connect callable,
  // as the browser's requests carry it.
  const asBearer = (uid: string, url: string, init: { body?: unknown } = {}) =>
    asUser(uid, url, { ...init, headers: { Authorization: `Bearer ${uid}` } });

  const attachBody = (transactionId: string) => ({
    integrationId: A.integration,
    messageId: "m-1",
    attachmentId: "att-1",
    transactionId,
  });

  it("positive control: attaching to my own Transaction connects it", async () => {
    const { POST } = await import("@/app/api/gmail/attachment/route");
    const res = await POST(asBearer(ATTACKER, "/api/gmail/attachment", { body: attachBody(A.transaction) }));
    expect(res.status).toBe(200);
    const tx = (await getFirestore().doc(`transactions/${A.transaction}`).get()).data();
    expect(tx?.fileIds?.length).toBe(1);
  });

  it("positive control: converting a mail onto my own Transaction connects it", async () => {
    const { POST } = await import("@/app/api/gmail/convert-to-pdf/route");
    const res = await POST(
      asBearer(ATTACKER, "/api/gmail/convert-to-pdf", { body: { integrationId: A.integration, messageId: "m-1", transactionId: A.transaction } }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const tx = (await getFirestore().doc(`transactions/${A.transaction}`).get()).data();
    expect(tx?.fileIds?.length).toBe(1);
  });

  // Static imports per name: both the /gmail and the provider-neutral /mail twin.
  const ATTACH = {
    gmail: () => import("@/app/api/gmail/attachment/route"),
    mail: () => import("@/app/api/mail/attachment/route"),
  };
  const CONVERT = {
    gmail: () => import("@/app/api/gmail/convert-to-pdf/route"),
    mail: () => import("@/app/api/mail/convert-to-pdf/route"),
  };

  for (const route of ["gmail", "mail"] as const) {
    it(`/api/${route}/attachment refuses the victim's Transaction`, async () => {
      const { POST } = await ATTACH[route]();
      const res = await POST(asBearer(ATTACKER, `/api/${route}/attachment`, { body: attachBody(V.transaction) }));
      await expectRefused(res, `${route}/attachment`);
    });

    it(`/api/${route}/attachment refuses the victim's Transaction for an already-stored File`, async () => {
      // The dedup branch connects an existing File; it had its own unchecked write.
      const { POST } = await ATTACH[route]();
      const first = await POST(asBearer(ATTACKER, `/api/${route}/attachment`, { body: { ...attachBody(A.transaction), attachmentId: "same" } }));
      expect(first.status).toBe(200);
      const res = await POST(asBearer(ATTACKER, `/api/${route}/attachment`, { body: { ...attachBody(V.transaction), attachmentId: "same" } }));
      await expectRefused(res, `${route}/attachment (existing file)`);
    });

    it(`/api/${route}/convert-to-pdf refuses the victim's Transaction`, async () => {
      const { POST } = await CONVERT[route]();
      const res = await POST(
        asBearer(ATTACKER, `/api/${route}/convert-to-pdf`, { body: { integrationId: A.integration, messageId: "m-1", transactionId: V.transaction } }),
      );
      await expectRefused(res, `${route}/convert-to-pdf`);
    });
  }

  it("a path-shaped or non-string Transaction id is refused the same way", async () => {
    const { POST } = await import("@/app/api/gmail/attachment/route");
    for (const transactionId of [`../transactions/${V.transaction}`, { id: V.transaction }, [V.transaction]]) {
      const res = await POST(asBearer(ATTACKER, "/api/gmail/attachment", { body: attachBody(transactionId as string) }));
      await expectRefused(res, `attachment(${JSON.stringify(transactionId)})`);
    }
  });

  it("a missing Transaction answers exactly like a foreign one (no existence oracle)", async () => {
    const { POST } = await import("@/app/api/gmail/attachment/route");
    const foreign = await POST(asBearer(ATTACKER, "/api/gmail/attachment", { body: attachBody(V.transaction) }));
    const missing = await POST(asBearer(ATTACKER, "/api/gmail/attachment", { body: attachBody("does-not-exist") }));
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

describe("TrueLayer routes check source and connection ownership", () => {
  let snapshot: Map<string, string>;
  const future = () => Timestamp.fromMillis(Date.now() + 3_600_000);

  beforeEach(async () => {
    trueLayerTokensUsed.length = 0;
    const db = getFirestore();
    const api = (connectionId: string) => ({ type: "api", apiConfig: { provider: "truelayer", connectionId, accountId: "acc-1" } });
    await db.doc(`truelayerConnections/v-tl-1`).set({ userId: VICTIM, accessToken: CANARY, refreshToken: CANARY, tokenExpiresAt: future(), providerId: "tl-bank", providerName: CANARY, providerLogo: "logo.png" });
    await db.doc(`truelayerConnections/a-tl-1`).set({ userId: ATTACKER, accessToken: "mine", refreshToken: "mine", tokenExpiresAt: future(), providerId: "tl-bank", providerName: "Mine", providerLogo: "logo.png" });
    await db.doc(`sources/${V.source}`).update(api("v-tl-1"));
    snapshot = await victimRows();
  });

  it("positive control: syncing my own TrueLayer source imports into it", async () => {
    await getFirestore().doc(`sources/${A.source}`).update({ type: "api", apiConfig: { provider: "truelayer", connectionId: "a-tl-1", accountId: "acc-1" } });
    const { POST } = await import("@/app/api/truelayer/sync/route");
    const res = await POST(asUser(ATTACKER, "/api/truelayer/sync", { body: { sourceId: A.source } }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(trueLayerTokensUsed).toEqual(["mine"]);
  });

  it("positive control: linking my connection to my own source rewrites it", async () => {
    const { POST } = await import("@/app/api/truelayer/accounts/route");
    const res = await POST(
      asUser(ATTACKER, "/api/truelayer/accounts", { body: { connectionId: "a-tl-1", accountId: "acc-1", sourceId: A.source } }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await getFirestore().doc(`sources/${A.source}`).get()).data()?.type).toBe("api");
  });

  it("sync refuses another user's source", async () => {
    const { POST } = await import("@/app/api/truelayer/sync/route");
    const res = await POST(asUser(ATTACKER, "/api/truelayer/sync", { body: { sourceId: V.source } }));
    before = snapshot;
    await expectRefused(res, "truelayer/sync(victim source)");
    expect(trueLayerTokensUsed).toEqual([]);
  });

  it("sync refuses my source pointing at another user's connection", async () => {
    await getFirestore().doc(`sources/${A.source}`).update({ type: "api", apiConfig: { provider: "truelayer", connectionId: "v-tl-1", accountId: "acc-1" } });
    const { POST } = await import("@/app/api/truelayer/sync/route");
    const res = await POST(asUser(ATTACKER, "/api/truelayer/sync", { body: { sourceId: A.source } }));
    before = snapshot;
    await expectRefused(res, "truelayer/sync(victim connection)");
    expect(trueLayerTokensUsed).not.toContain(CANARY);
  });

  it("linking my connection to another user's source is refused", async () => {
    const { POST } = await import("@/app/api/truelayer/accounts/route");
    const res = await POST(
      asUser(ATTACKER, "/api/truelayer/accounts", { body: { connectionId: "a-tl-1", accountId: "acc-1", sourceId: V.source } }),
    );
    before = snapshot;
    await expectRefused(res, "truelayer/accounts(victim source)");
  });
});

describe("routes that spend model money require a signed-in user", () => {
  const routes: Array<[string, string, Record<string, unknown>]> = [
    ["@/app/api/gmail/generate-queries/route", "/api/gmail/generate-queries", { transaction: { name: "probe", amount: -1, date: "2026-01-01" } }],
    [
      "@/app/api/browser/replay-agent/route",
      "/api/browser/replay-agent",
      { pageSnapshot: { url: "https://x.test", title: "t", buttons: [], links: [], headings: [], tables: 0, visibleText: "" }, currentUrl: "https://x.test", transactionInfo: { amount: 1, date: "2026-01-01", currency: "EUR" }, goal: "find_invoice" },
    ],
  ];
  for (const [mod, url, body] of routes) {
    it(`${url} answers 401 without a user and never calls the model`, async () => {
      modelCalls.length = 0;
      const { POST } = await import(mod);
      const res = await POST(anonymous(url, body));
      expect(res.status).toBe(401);
      expect(modelCalls).toEqual([]);
    });

    it(`${url} still works for a signed-in user`, async () => {
      modelCalls.length = 0;
      const { POST } = await import(mod);
      const res = await POST(asUser(ATTACKER, url, { body }));
      expect(res.status, await res.clone().text()).toBe(200);
      expect(modelCalls.length).toBe(1);
    });
  }
});

describe("/api/admin/replay serves the caller's own reports only", () => {
  // The internal-secret identity is never an admin (isServerUserAdmin reads the
  // verified token only), so through this door the route refuses outright and
  // leaks nothing. Which account an admin sees is replay-admin-route.test.ts.
  it("refuses a non-admin, with or without a pr", async () => {
    const { GET } = await import("@/app/api/admin/replay/route");
    for (const query of ["", "?pr=660", `?pr=../${VICTIM}`]) {
      const res = await GET(asUser(ATTACKER, `/api/admin/replay${query}`));
      expect(res.status).toBe(403);
      assertNoLeak(await res.text(), "admin/replay");
    }
  });
});
