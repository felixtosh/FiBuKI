// Shared helpers for the scripts that post to Telegram as @bukibukibukibot
// (post-daily-changelog.mjs, post-dev-digest.mjs).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const REPO = process.env.GITHUB_REPOSITORY || "felixtosh/FiBuKI";
export const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

export function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

// Window start: the last successful scheduled run of `workflow`, so a failed
// day is caught up the next day. Manual (dry) runs never move the window.
export function windowStart(workflow) {
  if (process.env.SINCE) return new Date(process.env.SINCE);
  const out = gh([
    "run", "list", "-R", REPO, "--workflow", workflow, "--event", "schedule",
    "--status", "success", "-L", "1", "--json", "createdAt", "--jq", ".[0].createdAt // empty",
  ]).trim();
  return out ? new Date(out) : new Date(Date.now() - 24 * 3600 * 1000);
}

// The geminiLite role, read from the one place model ids live (CLAUDE.md:
// never inline a model id).
export const GEMINI_MODEL = readFileSync(
  new URL("../../functions/src/utils/models.ts", import.meta.url),
  "utf8",
).match(/geminiLite:\s*"([^"]+)"/)[1];

// One JSON-mode Gemini call; returns the parsed object.
export async function geminiJson(system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "{}");
}

export const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const viennaDay = () =>
  new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Vienna", day: "numeric", month: "long" });

// Posts `html` (Telegram HTML parse mode), or prints it under DRY_RUN.
export async function postTelegram(chatId, html) {
  console.log(`\n${html}\n`);
  if (DRY_RUN) {
    console.log("DRY_RUN: not posted.");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  console.log("Posted.");
}
