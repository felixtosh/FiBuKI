/**
 * Community chat membership: only a linked, paying Telegram account (or staff)
 * gets in, and a token links exactly one Telegram account, once.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { createLinkToken, handleUpdate, sweepLapsedMembers, getLinkByUser } from "../community/membership";
import { readTelegramConfig, type TelegramClient } from "../community/telegram";

const db = getFirestore();
const CHAT = -1001;
const cfg = {
  botToken: "t",
  botUsername: "fibuki_bot",
  communityChatId: CHAT,
  staffIds: new Set([999]),
  webhookSecret: "s",
};

function fakeTg(status: string | null = "member") {
  const tg = {
    sendMessage: vi.fn(async () => {}),
    createJoinRequestLink: vi.fn(async () => "https://t.me/+abc"),
    approveJoinRequest: vi.fn(async () => {}),
    declineJoinRequest: vi.fn(async () => {}),
    removeMember: vi.fn(async () => {}),
    memberStatus: vi.fn(async () => status),
  };
  return tg satisfies TelegramClient;
}

const payingSub = { plan: "pro", stripeSubscriptionStatus: "active" };
const start = (token: string, fromId: number) => ({
  message: { text: `/start ${token}`, chat: { id: fromId, type: "private" }, from: { id: fromId, username: "u" } },
});
const join = (fromId: number) => ({ chat_join_request: { chat: { id: CHAT }, from: { id: fromId } } });

beforeEach(async () => {
  await __resetFirestoreShim();
  process.env.FIBUKI_TIER = "cloud";
});

describe("community telegram", () => {
  it("links a token once and hands a paying user a join link", async () => {
    await db.collection("subscriptions").doc("u1").set(payingSub);
    const token = await createLinkToken("u1");
    const tg = fakeTg();
    await handleUpdate(start(token, 5), cfg, tg);
    expect(tg.createJoinRequestLink).toHaveBeenCalled();
    expect((await getLinkByUser("u1"))?.telegramUserId).toBe(5);

    // Replay by someone else gets nothing.
    const tg2 = fakeTg();
    await handleUpdate(start(token, 6), cfg, tg2);
    expect(tg2.createJoinRequestLink).not.toHaveBeenCalled();
    expect((await getLinkByUser("u1"))?.telegramUserId).toBe(5);
  });

  it("links but gives no link to a non-paying user, and declines their join request", async () => {
    await db.collection("subscriptions").doc("u2").set({ plan: "free", stripeSubscriptionStatus: "none" });
    const tg = fakeTg();
    await handleUpdate(start(await createLinkToken("u2"), 7), cfg, tg);
    expect(tg.createJoinRequestLink).not.toHaveBeenCalled();
    await handleUpdate(join(7), cfg, tg);
    expect(tg.declineJoinRequest).toHaveBeenCalledWith(CHAT, 7);
    expect(tg.approveJoinRequest).not.toHaveBeenCalled();
  });

  it("approves paying users and staff, declines strangers", async () => {
    await db.collection("subscriptions").doc("u1").set(payingSub);
    const tg = fakeTg();
    await handleUpdate(start(await createLinkToken("u1"), 5), cfg, tg);
    await handleUpdate(join(5), cfg, tg);
    await handleUpdate(join(999), cfg, tg);
    await handleUpdate(join(1234), cfg, tg);
    expect(tg.approveJoinRequest).toHaveBeenCalledWith(CHAT, 5);
    expect(tg.approveJoinRequest).toHaveBeenCalledWith(CHAT, 999);
    expect(tg.declineJoinRequest).toHaveBeenCalledWith(CHAT, 1234);
  });

  it("ignores join requests for other chats", async () => {
    const tg = fakeTg();
    await handleUpdate({ chat_join_request: { chat: { id: -5 }, from: { id: 5 } } }, cfg, tg);
    expect(tg.approveJoinRequest).not.toHaveBeenCalled();
    expect(tg.declineJoinRequest).not.toHaveBeenCalled();
  });

  it("sweeps lapsed members but never staff or group admins", async () => {
    await db.collection("subscriptions").doc("u1").set({ plan: "free", stripeSubscriptionStatus: "canceled" });
    await db.collection("telegramLinks").doc("5").set({ userId: "u1", telegramUserId: 5 });
    await db.collection("telegramLinks").doc("999").set({ userId: "u1", telegramUserId: 999 });
    const tg = fakeTg("member");
    expect(await sweepLapsedMembers(cfg, tg)).toBe(1);
    expect(tg.removeMember).toHaveBeenCalledWith(CHAT, 5);
    expect(tg.removeMember).not.toHaveBeenCalledWith(CHAT, 999);

    const admin = fakeTg("administrator");
    expect(await sweepLapsedMembers(cfg, admin)).toBe(0);
  });

  it("is off until configured, and parses staff ids", () => {
    expect(readTelegramConfig({})).toBeNull();
    const c = readTelegramConfig({
      TELEGRAM_BOT_TOKEN: "x", TELEGRAM_BOT_USERNAME: "@b", TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_COMMUNITY_CHAT_ID: "-100123", TELEGRAM_STAFF_IDS: "1, 2,x",
    });
    expect(c?.botUsername).toBe("b");
    expect([...c!.staffIds]).toEqual([1, 2]);
  });
});
