/**
 * Minimal Telegram Bot API client for the community chat.
 *
 * Only the handful of methods the membership flow needs, behind an interface so
 * the logic is tested without the network. The Bot API is free: no plan, no
 * per-message fee.
 */

export interface TelegramClient {
  sendMessage(chatId: number, text: string): Promise<void>;
  /** A join-request invite link: joining only creates a request the bot approves. */
  createJoinRequestLink(chatId: number, name: string): Promise<string>;
  approveJoinRequest(chatId: number, userId: number): Promise<void>;
  declineJoinRequest(chatId: number, userId: number): Promise<void>;
  /** Kick without a lasting ban (ban, then unban), so a re-subscriber can come back. */
  removeMember(chatId: number, userId: number): Promise<void>;
  /** "creator" | "administrator" | "member" | "left" | ... or null if unknown. */
  memberStatus(chatId: number, userId: number): Promise<string | null>;
}

export interface TelegramConfig {
  botToken: string;
  botUsername: string;
  /** The private community supergroup (a negative number like -100123...). */
  communityChatId: number;
  /** Telegram user ids that always get in and are never removed. */
  staffIds: Set<number>;
  webhookSecret: string;
  /** Invite link of the open announcements channel, shown to everyone. */
  announcementsUrl: string | null;
}

/** Null when the bot is not set up; callers must treat that as "feature off". */
export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  const chatId = Number(env.TELEGRAM_COMMUNITY_CHAT_ID?.trim());
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!botToken || !botUsername || !webhookSecret || !Number.isFinite(chatId) || chatId === 0) {
    return null;
  }
  const staffIds = new Set(
    (env.TELEGRAM_STAFF_IDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
  const announcementsUrl = env.TELEGRAM_ANNOUNCEMENTS_URL?.trim() || null;
  return { botToken, botUsername, communityChatId: chatId, staffIds, webhookSecret, announcementsUrl };
}

export function createTelegramClient(botToken: string, fetchImpl: typeof fetch = fetch): TelegramClient {
  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: T; description?: string }
      | null;
    if (!json?.ok) {
      // Never include the URL: it carries the bot token.
      throw new Error(`telegram ${method} failed: ${json?.description ?? res.status}`);
    }
    return json.result as T;
  }

  return {
    async sendMessage(chatId, text) {
      await call("sendMessage", { chat_id: chatId, text });
    },
    async createJoinRequestLink(chatId, name) {
      const r = await call<{ invite_link: string }>("createChatInviteLink", {
        chat_id: chatId,
        name: name.slice(0, 32),
        creates_join_request: true,
        expire_date: Math.floor(Date.now() / 1000) + 60 * 60,
      });
      return r.invite_link;
    },
    async approveJoinRequest(chatId, userId) {
      await call("approveChatJoinRequest", { chat_id: chatId, user_id: userId });
    },
    async declineJoinRequest(chatId, userId) {
      await call("declineChatJoinRequest", { chat_id: chatId, user_id: userId });
    },
    async removeMember(chatId, userId) {
      await call("banChatMember", { chat_id: chatId, user_id: userId });
      await call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
    },
    async memberStatus(chatId, userId) {
      try {
        const r = await call<{ status: string }>("getChatMember", { chat_id: chatId, user_id: userId });
        return r.status;
      } catch {
        return null;
      }
    },
  };
}
