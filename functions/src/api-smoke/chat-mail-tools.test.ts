/**
 * The chat assistant's mail tools search every Mail Integration the receipt
 * search reads, IMAP included (#746).
 *
 * Before, they read Gmail Mail Integrations only, so a User whose mailboxes
 * are all IMAP (every self-host User) was told "Gmail is not connected" next
 * to an integrations page listing the same mailboxes as connected.
 *
 * Covers repo-root lib/agent/tools/, so it runs under vitest.api-smoke.config.ts
 * ONLY (needs the root dependency tree for @langchain/core).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  state: {
    transactions: new Map<string, Record<string, unknown>>(),
    emailIntegrations: new Map<string, Record<string, unknown>>(),
  },
  callFirebaseFunction: vi.fn(),
}));

vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: (...args: unknown[]) => h.callFirebaseFunction(...args),
}));

vi.mock("@/lib/firebase/admin", () => {
  const snap = (id: string, data: Doc | undefined) => ({ id, exists: data !== undefined, data: () => data, ref: { id } });
  const collection = (name: string) => {
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      get: async () => {
        const store = name === "emailIntegrations" ? h.state.emailIntegrations : new Map<string, Doc>();
        const docs = [...store].map(([id, data]) => snap(id, data));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
      doc: (id: string) => ({
        id,
        get: async () => snap(id, name === "transactions" ? h.state.transactions.get(id) : undefined),
      }),
    };
    return query;
  };
  return { getAdminDb: () => ({ collection, getAll: async () => [] }) };
});

const { searchGmailAttachmentsTool, searchGmailEmailsTool } = await import("@/lib/agent/tools/search-tools");

const userId = "user-1";
const chatConfig = { configurable: { userId, authHeader: "Bearer test" } };

function imapMailbox(id: string, extra: Doc = {}) {
  h.state.emailIntegrations.set(id, {
    userId,
    email: `${id}@example.com`,
    provider: "imap",
    isActive: true,
    needsReauth: false,
    ...extra,
  });
}

function searchedIntegrationIds(): string[] {
  return h.callFirebaseFunction.mock.calls
    .filter(([name]) => name === "searchGmailCallable")
    .map(([, payload]) => (payload as { integrationId: string }).integrationId);
}

beforeEach(() => {
  h.state.transactions.clear();
  h.state.emailIntegrations.clear();
  h.state.transactions.set("tx-1", {
    userId,
    name: "ACME GmbH",
    amount: -12000,
    currency: "EUR",
    date: new Date("2026-03-05"),
    fileIds: [],
  });
  h.callFirebaseFunction.mockReset();
  h.callFirebaseFunction.mockImplementation(async (name: string) =>
    name === "searchGmailCallable" ? { messages: [] } : { scores: [] }
  );
});

describe("the chat's mail tools over IMAP Mail Integrations (#746)", () => {
  it("searchGmailEmails reaches the shared mail search for an IMAP-only User", async () => {
    imapMailbox("imap-1");

    const result = (await searchGmailEmailsTool.invoke({ query: "acme rechnung" }, chatConfig)) as Doc;

    expect(result.gmailNotConnected).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.integrationCount).toBe(1);
    expect(searchedIntegrationIds()).toEqual(["imap-1"]);
  });

  it("searchGmailAttachments reaches the shared mail search for an IMAP-only User", async () => {
    imapMailbox("imap-1");

    const result = (await searchGmailAttachmentsTool.invoke({ transactionId: "tx-1", query: "acme" }, chatConfig)) as Doc;

    expect(result.gmailNotConnected).toBeUndefined();
    expect(searchedIntegrationIds().every((id) => id === "imap-1")).toBe(true);
    expect(searchedIntegrationIds().length).toBeGreaterThan(0);
  });

  it("reports a mailbox that waits for credentials instead of searching it", async () => {
    imapMailbox("imap-ok");
    imapMailbox("imap-broken", { needsReauth: true });

    const result = (await searchGmailEmailsTool.invoke({ query: "acme" }, chatConfig)) as Doc;

    expect(searchedIntegrationIds()).toEqual(["imap-ok"]);
    expect(result.integrationsNeedingReauth).toEqual([
      { integrationId: "imap-broken", email: "imap-broken@example.com", needsReauth: true },
    ]);
  });

  it("says no mailbox is connected only when none is", async () => {
    imapMailbox("imap-off", { isActive: false });

    const result = (await searchGmailEmailsTool.invoke({ query: "acme" }, chatConfig)) as Doc;

    expect(result.gmailNotConnected).toBe(true);
    expect(String(result.error)).toMatch(/No mailbox is connected/);
    expect(searchedIntegrationIds()).toEqual([]);
  });
});
