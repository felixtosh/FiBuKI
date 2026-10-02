/**
 * Community chat endpoints: the Telegram webhook, the daily sweep, and the
 * three callables behind Settings → Community. All of it is inert until the
 * TELEGRAM_* env is set (see docs/community-telegram.md).
 */

import { timingSafeEqual } from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { createCallable, HttpsError } from "../utils/createCallable";
import { createTelegramClient, readTelegramConfig } from "./telegram";
import {
  createLinkToken,
  getLinkByUser,
  handleUpdate,
    sweepOrphanedMembers,
  unlinkUser,
} from "./membership";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const telegramWebhook = onRequest({ region: "europe-west1", cors: false }, async (req, res) => {
  const cfg = readTelegramConfig();
  if (req.method !== "POST" || !cfg) {
    res.status(404).send("Not found");
    return;
  }
  const header = req.headers["x-telegram-bot-api-secret-token"];
  if (typeof header !== "string" || !safeEqual(header, cfg.webhookSecret)) {
    res.status(401).send("Unauthorized");
    return;
  }
  try {
    await handleUpdate(req.body ?? {}, cfg, createTelegramClient(cfg.botToken));
  } catch (err) {
    // Always 200: a 5xx makes Telegram retry the same update in a loop.
    console.error("[telegramWebhook]", err instanceof Error ? err.message : String(err));
  }
  res.status(200).send("ok");
});

export const communityMembershipSweep = onSchedule(
  { schedule: "30 4 * * *", region: "europe-west1", timeoutSeconds: 300 },
  async () => {
    const cfg = readTelegramConfig();
    if (!cfg) return;
    const removed = await sweepOrphanedMembers(cfg, createTelegramClient(cfg.botToken));
    console.log(`[communityMembershipSweep] removed ${removed} orphaned member(s)`);
  },
);

interface StatusResponse {
  available: boolean;
  linked: boolean;
  username: string | null;
  announcementsUrl: string | null;
}

export const getTelegramLinkStatusCallable = createCallable<Record<string, never>, StatusResponse>(
  { name: "getTelegramLinkStatus" },
  async (ctx) => {
    const link = await getLinkByUser(ctx.userId);
    return {
      available: readTelegramConfig() !== null,
      linked: link !== null,
      username: link?.username ?? null,
      announcementsUrl: readTelegramConfig()?.announcementsUrl ?? null,
    };
  },
);

export const createTelegramLinkCallable = createCallable<Record<string, never>, { url: string }>(
  { name: "createTelegramLink" },
  async (ctx) => {
    const cfg = readTelegramConfig();
    if (!cfg) throw new HttpsError("failed-precondition", "The community chat is not set up yet.");
    const token = await createLinkToken(ctx.userId);
    return { url: `https://t.me/${cfg.botUsername}?start=${token}` };
  },
);

export const unlinkTelegramCallable = createCallable<Record<string, never>, { success: boolean }>(
  { name: "unlinkTelegram" },
  async (ctx) => {
    const cfg = readTelegramConfig();
    await unlinkUser(ctx.userId, cfg, cfg ? createTelegramClient(cfg.botToken) : null);
    return { success: true };
  },
);
