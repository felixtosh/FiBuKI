/**
 * Community chat membership: only a Telegram account linked to an existing
 * FiBuKI account (or staff) gets in, and a token links exactly one Telegram account, once.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetFirestoreShim, __rawSqlForTest } from "./firestore-shim";
import { getTenantId } from "./db/tenant";
import { getFirestore } from "./firestore-shim";
import { createLinkToken, handleUpdate, sweepOrphanedMembers, getLinkByUser } from "../community/membership";
import { readTelegramConfig, type TelegramClient } from "../community/telegram";

const db = getFirestore();
const CHAT = -1001;
const cfg = {
  botToken: "t",
  botUsername: "fibuki_bot",
  communityChatId: CHAT,
  staffIds: new Set([999]),
  webhookSecret: "s",
  announcementsUrl: "https://t.me/+news",
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

async function seedUser(uid: string) {
  await __rawSqlForTest(
    `INSERT INTO auth_users (tenant_id, id, name, email, "emailVerified", "customClaims", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, true, NULL, now(), now()) ON CONFLICT DO NOTHING`,
    [getTenantId(), uid, uid, `${uid}@test.invalid`],
    getTenantId(),
  );
}
async function dropUser(uid: string) {
  await __rawSqlForTest(`DELETE FROM auth_users WHERE tenant_id = $1 AND id = $2`, [getTenantId(), uid], getTenantId());
}
const start = (token: string, fromId: number) => ({
  message: { text: `/start ${token}`, chat: { id: fromId, type: "private" }, from: { id: fromId, username: "u" } },
});
const join = (fromId: number) => ({ chat_join_request: { chat: { id: CHAT }, from: { id: fromId } } });

beforeEach(async () => {
  await __resetFirestoreShim();
  await __rawSqlForTest(`DELETE FROM auth_users WHERE tenant_id = $1`, [getTenantId()], getTenantId());
});

describe("community telegram", () => {
  it("links a token once and hands the account holder a join link, on any plan", async () => {
    await seedUser("u1");
    await db.collection("subscriptions").doc("u1").set({ plan: "free", stripeSubscriptionStatus: "none" });
    const token = await createLinkToken("u1");
    const tg = fakeTg();
    await handleUpdate(start(token, 5), cfg, tg);
    expect(tg.createJoinRequestLink).toHaveBeenCalled();
    // The welcome DM carries both rooms: the support join link and the open announcements channel.
    const welcome = (tg.sendMessage.mock.calls as unknown as [number, string][]).at(-1)![1];
    expect(welcome).toContain("https://t.me/+abc");
    expect(welcome).toContain("https://t.me/+news");
    expect((await getLinkByUser("u1"))?.telegramUserId).toBe(5);

    // Replay by someone else gets nothing.
    const tg2 = fakeTg();
    await handleUpdate(start(token, 6), cfg, tg2);
    expect(tg2.createJoinRequestLink).not.toHaveBeenCalled();
    expect((await getLinkByUser("u1"))?.telegramUserId).toBe(5);
  });

  it("gives nothing to a token whose account is gone, and declines its join request", async () => {
    await seedUser("u2");
    const token = await createLinkToken("u2");
    await dropUser("u2");
    const tg = fakeTg();
    await handleUpdate(start(token, 7), cfg, tg);
    expect(tg.createJoinRequestLink).not.toHaveBeenCalled();
    await handleUpdate(join(7), cfg, tg);
    expect(tg.declineJoinRequest).toHaveBeenCalledWith(CHAT, 7);
    expect(tg.approveJoinRequest).not.toHaveBeenCalled();
  });

  it("approves linked account holders and staff, declines strangers", async () => {
    await seedUser("u1");
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

  it("sweeps members whose account was deleted, never staff or group admins or the still-registered", async () => {
    await seedUser("alive");
    await db.collection("telegramLinks").doc("5").set({ userId: "gone", telegramUserId: 5 });
    await db.collection("telegramLinks").doc("999").set({ userId: "gone", telegramUserId: 999 });
    await db.collection("telegramLinks").doc("6").set({ userId: "alive", telegramUserId: 6 });
    const tg = fakeTg("member");
    expect(await sweepOrphanedMembers(cfg, tg)).toBe(1);
    expect(tg.removeMember).toHaveBeenCalledWith(CHAT, 5);
    expect(tg.removeMember).not.toHaveBeenCalledWith(CHAT, 999);
    expect(tg.removeMember).not.toHaveBeenCalledWith(CHAT, 6);

    const admin = fakeTg("administrator");
    expect(await sweepOrphanedMembers(cfg, admin)).toBe(0);
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
