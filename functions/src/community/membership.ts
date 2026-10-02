/**
 * Community chat membership: who may be in the private Telegram group.
 *
 * Rule: a Telegram account gets in only if it is linked to an existing FiBuKI
 * account (any plan, paying or not), or it is staff. Linking is proven by a one-time token minted for the
 * signed-in user and redeemed by the bot in a private chat, so the uid never
 * comes from anything the Telegram side (or the client) supplies.
 *
 * Collections (server-only: absent from data-policy.ts, so clients are denied):
 *   telegramLinkTokens/{sha256(token)}  { userId, expiresAt, usedAt? }
 *   telegramLinks/{telegramUserId}      { userId, telegramUserId, username?, linkedAt }
 */

import { createHash, randomBytes } from "crypto";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import type { TelegramClient, TelegramConfig } from "./telegram";

const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKENS = "telegramLinkTokens";
const LINKS = "telegramLinks";

export interface TelegramLink {
  userId: string;
  telegramUserId: number;
  username?: string | null;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * "Proved they have an account": the FiBuKI account exists. Any plan counts.
 * Throws on anything but "no such user", so a transient auth failure never
 * reads as "account gone" (the sweep would kick everyone).
 */
export async function hasAccount(userId: string): Promise<boolean> {
  try {
    await getAuth().getUser(userId);
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "auth/user-not-found") return false;
    throw err;
  }
}

export async function createLinkToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await getFirestore()
    .collection(TOKENS)
    .doc(hashToken(token))
    .set({ userId, expiresAt: Timestamp.fromMillis(Date.now() + TOKEN_TTL_MS) });
  return token;
}

/** Redeem a token exactly once. Returns the uid it was minted for, or null. */
async function redeemToken(token: string): Promise<string | null> {
  const db = getFirestore();
  const ref = db.collection(TOKENS).doc(hashToken(token));
  // runTransaction is optimistic and may rerun: no side effects inside it.
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as { userId: string; expiresAt: Timestamp; usedAt?: unknown } | undefined;
    if (!data || data.usedAt || data.expiresAt.toMillis() < Date.now()) return null;
    tx.update(ref, { usedAt: FieldValue.serverTimestamp() });
    return data.userId;
  });
}

export async function getLinkByUser(userId: string): Promise<TelegramLink | null> {
  const q = await getFirestore().collection(LINKS).where("userId", "==", userId).limit(1).get();
  return q.empty ? null : (q.docs[0].data() as TelegramLink);
}

async function getLinkByTelegramId(telegramUserId: number): Promise<TelegramLink | null> {
  const snap = await getFirestore().collection(LINKS).doc(String(telegramUserId)).get();
  return snap.exists ? (snap.data() as TelegramLink) : null;
}

async function mayBeInGroup(cfg: TelegramConfig, telegramUserId: number): Promise<boolean> {
  if (cfg.staffIds.has(telegramUserId)) return true;
  const link = await getLinkByTelegramId(telegramUserId);
  return link ? hasAccount(link.userId) : false;
}

/** Unlink a user's Telegram account and remove it from the group. */
export async function unlinkUser(userId: string, cfg: TelegramConfig | null, tg: TelegramClient | null) {
  const link = await getLinkByUser(userId);
  if (!link) return;
  await getFirestore().collection(LINKS).doc(String(link.telegramUserId)).delete();
  if (cfg && tg && !cfg.staffIds.has(link.telegramUserId)) {
    await tg.removeMember(cfg.communityChatId, link.telegramUserId).catch(() => undefined);
  }
}

interface TgUpdate {
  message?: {
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
  };
  chat_join_request?: {
    chat: { id: number };
    from: { id: number };
    user_chat_id?: number;
  };
}

const announcementsLine = (cfg: TelegramConfig) =>
  cfg.announcementsUrl ? `\n\nAnnouncements (open to everyone): ${cfg.announcementsUrl}` : "";

const help = (cfg: TelegramConfig) =>
  "Hi! I'm the FiBuKI community bot. To join the support group, open FiBuKI → Settings → Community and tap " +
  "\"Connect Telegram\" so I can check your account." +
  announcementsLine(cfg);

export async function handleUpdate(update: TgUpdate, cfg: TelegramConfig, tg: TelegramClient) {
  const jr = update.chat_join_request;
  if (jr) {
    if (jr.chat.id !== cfg.communityChatId) return;
    const dm = jr.user_chat_id ?? jr.from.id;
    if (await mayBeInGroup(cfg, jr.from.id)) {
      await tg.approveJoinRequest(jr.chat.id, jr.from.id);
    } else {
      await tg.declineJoinRequest(jr.chat.id, jr.from.id);
      await tg.sendMessage(dm, help(cfg)).catch(() => undefined);
    }
    return;
  }

  const msg = update.message;
  if (!msg?.text || msg.chat.type !== "private" || !msg.from) return;
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(msg.text);
  if (!match) return;

  const token = match[1];
  if (!token) {
    await tg.sendMessage(msg.chat.id, help(cfg));
    return;
  }

  const userId = await redeemToken(token);
  if (!userId) {
    await tg.sendMessage(msg.chat.id, "That link has expired or was already used. Create a new one in FiBuKI → Settings → Community.");
    return;
  }

  const db = getFirestore();
  // One Telegram account per FiBuKI account: moving it removes the old member.
  const previous = await getLinkByUser(userId);
  if (previous && previous.telegramUserId !== msg.from.id) {
    await unlinkUser(userId, cfg, tg);
  }
  await db.collection(LINKS).doc(String(msg.from.id)).set({
    userId,
    telegramUserId: msg.from.id,
    username: msg.from.username ?? null,
    linkedAt: FieldValue.serverTimestamp(),
  });

  if (!(await mayBeInGroup(cfg, msg.from.id))) {
    await tg.sendMessage(msg.chat.id, "Your account is linked, but that FiBuKI account no longer exists, so I cannot let you into the support group.");
    return;
  }
  const link = await tg.createJoinRequestLink(cfg.communityChatId, "FiBuKI member");
  await tg.sendMessage(msg.chat.id, `You're connected. Join the support group here (link valid for 1 hour):\n${link}${announcementsLine(cfg)}`);
}

/** Remove members whose FiBuKI account was deleted. Staff and group admins are never touched. */
export async function sweepOrphanedMembers(cfg: TelegramConfig, tg: TelegramClient): Promise<number> {
  const links = await getFirestore().collection(LINKS).get();
  let removed = 0;
  for (const doc of links.docs) {
    const link = doc.data() as TelegramLink;
    if (cfg.staffIds.has(link.telegramUserId)) continue;
    try {
      if (await hasAccount(link.userId)) continue;
    } catch {
      continue; // unknown is not "gone": try again tomorrow
    }
    const status = await tg.memberStatus(cfg.communityChatId, link.telegramUserId);
    if (status === "creator" || status === "administrator") continue;
    if (status === "member" || status === "restricted") {
      await tg.removeMember(cfg.communityChatId, link.telegramUserId);
      await tg
        .sendMessage(link.telegramUserId, "Your FiBuKI account was deleted, so I removed you from the support group. Create a new account and reconnect in Settings → Community to come back.")
        .catch(() => undefined);
      removed++;
    }
  }
  return removed;
}
