/**
 * The chat's choice cards and confirmations run only what the server proposed
 * (lib/agent/pending-choice.ts, lib/agent/choice-runner.ts).
 *
 * The browser sends the whole conversation and the click, so neither can
 * vouch for what runs. The server stored each proposal under a token when it
 * showed the card; a click presents the token and an option id, and only the
 * option stored with that token runs, once, for the User it was issued to.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { __resetFirestoreShim, getFirestore } from "../firestore-shim";
import { issueChoice } from "@/lib/agent/pending-choice";
import { runChoice } from "@/lib/agent/choice-runner";

const ATTACKER = "chat-choice-attacker";
const VICTIM = "chat-choice-victim";

const ran: Array<{ tool: string; args: unknown; userId?: string }> = [];
const spy = (name: string) => ({
  name,
  invoke: async (args: unknown, config?: unknown) => {
    const userId = (config as { configurable?: { userId?: string } })?.configurable?.userId;
    ran.push({ tool: name, args, userId });
    return { success: true };
  },
});
const TOOLS = ["bulkUpdateTransactions", "createSource", "connectFileToTransaction", "updatePartner"].map(spy);

function click(userId: string, token: string, optionId: string, feedback?: string) {
  return runChoice({ userId, authHeader: `Bearer ${userId}`, choice: { token, optionId, feedback }, tools: TOOLS });
}

function proposeBulk(userId: string) {
  return issueChoice(userId, {
    kind: "confirmation",
    toolCallId: "call-1",
    options: [
      { id: "approve", label: "approve", action: { tool: "bulkUpdateTransactions" as never, args: { transactionIds: ["t1"], isComplete: true } } },
      { id: "reject", label: "cancel" },
    ],
  });
}

beforeEach(async () => {
  ran.length = 0;
  await __resetFirestoreShim();
});

describe("a confirmation", () => {
  it("runs the proposed call as the User, exactly once", async () => {
    const token = await proposeBulk(ATTACKER);
    const out = await click(ATTACKER, token, "approve");
    expect(ran).toEqual([{ tool: "bulkUpdateTransactions", args: { transactionIds: ["t1"], isComplete: true }, userId: ATTACKER }]);
    expect(out.note).toContain("already run");
    const replay = await click(ATTACKER, token, "approve");
    expect(ran).toHaveLength(1);
    expect(replay.note).toContain("no longer open");
  });

  it("cancelled runs nothing", async () => {
    const token = await proposeBulk(ATTACKER);
    const out = await click(ATTACKER, token, "reject");
    expect(ran).toEqual([]);
    expect(out.note).toContain("cancelled");
  });

  it("another User's token runs nothing and stays usable by its owner", async () => {
    const token = await proposeBulk(VICTIM);
    await click(ATTACKER, token, "approve");
    expect(ran).toEqual([]);
    await click(VICTIM, token, "approve");
    expect(ran).toEqual([expect.objectContaining({ tool: "bulkUpdateTransactions", userId: VICTIM })]);
  });

  it("a forged token runs nothing", async () => {
    await click(ATTACKER, "a".repeat(64), "approve");
    await click(ATTACKER, "not-a-token", "approve");
    expect(ran).toEqual([]);
  });

  it("only holds a gated write: a stored confirmation of anything else never runs", async () => {
    const token = await issueChoice(ATTACKER, {
      kind: "confirmation",
      toolCallId: "call-2",
      options: [{ id: "approve", label: "approve", action: { tool: "updatePartner" as never, args: { partnerId: "p1" } } }],
    });
    await click(ATTACKER, token, "approve");
    expect(ran).toEqual([]);
  });
});

describe("a choice card", () => {
  async function show(userId: string) {
    return issueChoice(userId, {
      kind: "choice",
      toolCallId: "call-3",
      options: [
        { id: "a", label: "invoice-a.pdf", action: { tool: "connectFileToTransaction", args: { fileId: "f-a", transactionId: "t1" } } },
        { id: "b", label: "invoice-b.pdf", action: { tool: "connectFileToTransaction", args: { fileId: "f-b", transactionId: "t1" } } },
        { id: "mail", label: "Connect a mailbox", navigate: "/integrations" },
      ],
    });
  }

  it("runs the clicked option's stored write, and nothing else", async () => {
    const token = await show(ATTACKER);
    await click(ATTACKER, token, "b");
    expect(ran).toEqual([{ tool: "connectFileToTransaction", args: { fileId: "f-b", transactionId: "t1" }, userId: ATTACKER }]);
    await click(ATTACKER, token, "a");
    expect(ran).toHaveLength(1);
  });

  it("'None of these' runs nothing and hands the feedback to the model", async () => {
    const token = await show(ATTACKER);
    const out = await click(ATTACKER, token, "none", "it was paid in cash");
    expect(ran).toEqual([]);
    expect(out.note).toContain("none of the options");
    expect(out.note).toContain("it was paid in cash");
  });

  it("an option that would run a write a choice may not run never runs", async () => {
    const token = await issueChoice(ATTACKER, {
      kind: "choice",
      toolCallId: "call-4",
      options: [{ id: "a", label: "new account", action: { tool: "createSource" as never, args: { name: "x" } } }],
    });
    await click(ATTACKER, token, "a");
    expect(ran).toEqual([]);
  });

  it("stores the proposal server-side only, with the arguments as text", async () => {
    const token = await show(ATTACKER);
    const docs = (await getFirestore().collection("agentConfirmations").get()).docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].id).not.toBe(token);
    expect(typeof docs[0].data().options).toBe("string");
  });
});

describe("chat traces", () => {
  type Callable = { run: (req: { data: unknown; auth?: { uid: string; token: Record<string, unknown> } }) => Promise<unknown> };
  const barrel = () => import("../../index") as unknown as Promise<Record<string, Callable>>;
  const as = (uid: string, token: Record<string, unknown> = {}) => ({ uid, token });

  async function storeTurn(userId: string, turnId: string) {
    await getFirestore().collection("chatTraces").doc(`${userId}_${turnId}`).set({ userId, turnId, feedback: null, createdAt: new Date() });
  }

  it("a User rates their own turn, and cannot rate another User's", async () => {
    const { submitChatFeedback } = await barrel();
    await storeTurn(VICTIM, "turn-victim-1");
    await storeTurn(ATTACKER, "turn-attacker-1");
    await submitChatFeedback.run({ data: { turnId: "turn-attacker-1", rating: "down", comment: "wrong file" }, auth: as(ATTACKER) });
    const mine = await getFirestore().collection("chatTraces").doc(`${ATTACKER}_turn-attacker-1`).get();
    expect(mine.data()?.feedback).toMatchObject({ rating: "down", comment: "wrong file" });

    await expect(
      submitChatFeedback.run({ data: { turnId: "turn-victim-1", rating: "down" }, auth: as(ATTACKER) })
    ).rejects.toMatchObject({ code: "not-found" });
    const theirs = await getFirestore().collection("chatTraces").doc(`${VICTIM}_turn-victim-1`).get();
    expect(theirs.data()?.feedback).toBeNull();
  });

  it("only an admin lists traces, decided from the verified token", async () => {
    const { listChatTraces } = await barrel();
    await storeTurn(VICTIM, "turn-victim-2");
    await expect(listChatTraces.run({ data: {}, auth: as(ATTACKER) })).rejects.toMatchObject({ code: "permission-denied" });
    const res = (await listChatTraces.run({ data: {}, auth: as("admin-1", { admin: true }) })) as { traces: unknown[] };
    expect(res.traces).toHaveLength(1);
  });
});
