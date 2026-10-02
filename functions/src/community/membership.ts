/**
 * Community chat membership: who may be in the private Telegram group.
 *
 * Rule: a Telegram account gets in only if it is linked to a FiBuKI account that
 * pays, or it is staff. Linking is proven by a one-time token minted for the
 * signed-in user and redeemed by the bot in a private chat, so the uid never
 * comes from anything the Telegram side (or the client) supplies.
 *
 * Collections (server-only: absent from data-policy.ts, so clients are denied):
 *   telegramLinkTokens/{sha256(token)}  { userId, expiresAt, usedAt? }
 *   telegramLinks/{telegramUserId}      { userId, telegramUserId, username?, linkedAt }
 */

import { createHash, randomBytes } from "crypto";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { resolvePlanId } from "../billing/config";
import { envPlanOverride } from "../billing/planSource";
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
 * "Proved they pay": a paid plan with an active Stripe subscription. Where the
 * environment dictates the plan (self-host lever) nobody is billed, so the
 * plan alone decides.
 */
export async function isPayingUser(userId: string): Promise<boolean> {
  const snap = await getFirestore().collection("subscriptions").doc(userId).get();
  const sub = snap.data() as { plan?: string; stripeSubscriptionStatus?: string } | undefined;
  const plan = resolvePlanId(sub?.plan as never);
  if (plan === "free") return false;
  return envPlanOverride() !== null || sub?.stripeSubscriptionStatus === "active";
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
  return link ? isPayingUser(link.userId) : false;
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

const HELP =
  "Hi! I'm the FiBuKI community bot. To join, open FiBuKI → Settings → Community and tap " +
  "\"Connect Telegram\" so I can check your account.";

export async function handleUpdate(update: TgUpdate, cfg: TelegramConfig, tg: TelegramClient) {
  const jr = update.chat_join_request;
  if (jr) {
    if (jr.chat.id !== cfg.communityChatId) return;
    const dm = jr.user_chat_id ?? jr.from.id;
    if (await mayBeInGroup(cfg, jr.from.id)) {
      await tg.approveJoinRequest(jr.chat.id, jr.from.id);
    } else {
      await tg.declineJoinRequest(jr.chat.id, jr.from.id);
      await tg.sendMessage(dm, HELP).catch(() => undefined);
    }
    return;
  }

  const msg = update.message;
  if (!msg?.text || msg.chat.type !== "private" || !msg.from) return;
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(msg.text);
  if (!match) return;

  const token = match[1];
  if (!token) {
    await tg.sendMessage(msg.chat.id, HELP);
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
    await tg.sendMessage(msg.chat.id, "Your account is linked, but the community is for paying FiBuKI users. Upgrade and send /start again from Settings → Community.");
    return;
  }
  const link = await tg.createJoinRequestLink(cfg.communityChatId, "FiBuKI member");
  await tg.sendMessage(msg.chat.id, `You're in. Join the community here (valid for 1 hour):\n${link}`);
}

/** Remove members whose subscription lapsed. Staff and group admins are never touched. */
export async function sweepLapsedMembers(cfg: TelegramConfig, tg: TelegramClient): Promise<number> {
  const links = await getFirestore().collection(LINKS).get();
  let removed = 0;
  for (const doc of links.docs) {
    const link = doc.data() as TelegramLink;
    if (cfg.staffIds.has(link.telegramUserId) || (await isPayingUser(link.userId))) continue;
    const status = await tg.memberStatus(cfg.communityChatId, link.telegramUserId);
    if (status === "creator" || status === "administrator") continue;
    if (status === "member" || status === "restricted") {
      await tg.removeMember(cfg.communityChatId, link.telegramUserId);
      await tg
        .sendMessage(link.telegramUserId, "Your FiBuKI subscription ended, so I removed you from the community. Resubscribe any time and reconnect in Settings → Community.")
        .catch(() => undefined);
      removed++;
    }
  }
  return removed;
}
