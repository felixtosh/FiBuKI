#!/usr/bin/env node
// Daily changelog for the Telegram announcements channel.
//
// Collects the PRs merged into main since the last scheduled run, has Gemini
// turn the user-visible ones into a short English digest, and posts it as the
// bot. Run by .github/workflows/changelog-telegram.yml; see the header there.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, GEMINI_API_KEY, TELEGRAM_BOT_TOKEN,
// TELEGRAM_ANNOUNCEMENTS_CHAT_ID. DRY_RUN=1 prints instead of posting.
// SINCE=<ISO date> overrides the window start.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY || "felixtosh/FiBuKI";
const WORKFLOW = "changelog-telegram.yml";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
// The geminiLite role, read from the one place model ids live (CLAUDE.md:
// never inline a model id). A digest of a dozen PR titles needs no more.
const MODEL = readFileSync(new URL("../functions/src/utils/models.ts", import.meta.url), "utf8")
  .match(/geminiLite:\s*"([^"]+)"/)[1];
const MAX_BODY_CHARS = 1500;

// PRs that never reach the channel, before the model sees them.
const SKIP_TITLE = /^(docs|chore|ci|test|tests|build|refactor|deps)(\(.*?\))?:|\bsecurity\b|\bcve\b|\bvuln/i;
const SKIP_LABEL = /security|internal|no-changelog/i;
// Last line of defence on the model's output: drop any item that talks about
// security, even if the prompt was ignored.
const UNSAFE_ITEM =
  /secur|vulnerab|exploit|\bcve\b|xss|csrf|inject|\brls\b|token|secret|password|credential|leak|attack|bypass|privilege|exposure|pentest|encrypt/i;

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

// Window start: the last successful scheduled run, so a failed day is caught
// up the next day. Manual (dry) runs never move the window.
function windowStart() {
  if (process.env.SINCE) return new Date(process.env.SINCE);
  const out = gh([
    "run", "list", "-R", REPO, "--workflow", WORKFLOW, "--event", "schedule",
    "--status", "success", "-L", "1", "--json", "createdAt", "--jq", ".[0].createdAt // empty",
  ]).trim();
  return out ? new Date(out) : new Date(Date.now() - 24 * 3600 * 1000);
}

function mergedPrs(since) {
  const out = gh([
    "pr", "list", "-R", REPO, "--state", "merged", "--base", "main", "-L", "200",
    "--search", `merged:>=${since.toISOString().slice(0, 19)}Z`,
    "--json", "number,title,body,labels,mergedAt",
  ]);
  return JSON.parse(out)
    .filter((pr) => new Date(pr.mergedAt) >= since)
    .filter((pr) => !SKIP_TITLE.test(pr.title))
    .filter((pr) => !pr.labels.some((l) => SKIP_LABEL.test(l.name)))
    .sort((a, b) => a.number - b.number);
}

const PROMPT = `You write the daily changelog for FiBuKI, a pre-accounting web app for Austrian one-person businesses (bank transactions, receipts, partners, VAT). Readers are its users, not developers.

Below are today's merged pull requests. Pick only changes a user would notice or care about: new features, visible improvements, fixed bugs they could have hit. Merge related PRs into one item. Leave out:
- anything about security, vulnerabilities, access control, authentication internals, tokens, secrets, encryption or attacks. Do not hint at them either.
- internal work: refactors, tests, CI, docs, dependencies, infrastructure, migrations, performance work users cannot feel.
- PR numbers, file names, code identifiers, people's names.

Write plain, friendly English, one short sentence per item (max 20 words), each starting with one fitting emoji. Use no em dashes. At most 8 items, most important first.

Answer with JSON only: {"items": [{"emoji": "✨", "text": "..."}]}. If nothing qualifies, answer {"items": []}.`;

async function summarize(prs) {
  const list = prs
    .map((pr) => `### ${pr.title}\n${(pr.body || "").slice(0, MAX_BODY_CHARS)}`)
    .join("\n\n");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PROMPT }] },
      contents: [{ role: "user", parts: [{ text: list }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "{}";
  return JSON.parse(text).items || [];
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function format(items) {
  const day = new Date().toLocaleDateString("en-GB", {
    timeZone: "Europe/Vienna", day: "numeric", month: "long",
  });
  const lines = items.map((i) => `${i.emoji} ${escapeHtml(i.text.replace(/\s*—\s*/g, ", "))}`);
  return `🚀 <b>New in FiBuKI</b> · ${day}\n\n${lines.join("\n")}`;
}

async function post(text) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_ANNOUNCEMENTS_CHAT_ID,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
}

const since = windowStart();
const prs = mergedPrs(since);
console.log(`Window from ${since.toISOString()}: ${prs.length} candidate PRs`);
prs.forEach((pr) => console.log(`  #${pr.number} ${pr.title}`));
if (prs.length === 0) process.exit(0);

const items = (await summarize(prs)).filter((i) => {
  const ok = i?.text && !UNSAFE_ITEM.test(i.text);
  if (i?.text && !ok) console.log(`  dropped (filter): ${i.text}`);
  return ok;
});
if (items.length === 0) {
  console.log("Nothing user-facing today; no post.");
  process.exit(0);
}

const message = format(items);
console.log(`\n${message}\n`);
if (DRY_RUN) {
  console.log("DRY_RUN: not posted.");
} else {
  await post(message);
  console.log("Posted.");
}
