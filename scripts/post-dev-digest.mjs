#!/usr/bin/env node
// Daily digest for the Development Telegram group: issues opened and PRs
// opened (still open) since the last scheduled run, plus how many PRs are open
// in total. Internal audience, so no filtering beyond what fits in a message.
// Run by .github/workflows/dev-digest-telegram.yml.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, GEMINI_API_KEY, TELEGRAM_BOT_TOKEN,
// TELEGRAM_DEV_CHAT_ID. DRY_RUN=1 prints instead of posting.
// SINCE=<ISO date> overrides the window start.

import { gh, REPO, windowStart, geminiJson, escapeHtml, viennaDay, postTelegram } from "./lib/telegram.mjs";

const WORKFLOW = "dev-digest-telegram.yml";
const MAX_BODY_CHARS = 1200;
const MAX_ITEMS = 25;

const since = windowStart(WORKFLOW);
const sinceQ = since.toISOString().slice(0, 19) + "Z";

const issues = JSON.parse(
  gh([
    "issue", "list", "-R", REPO, "--state", "all", "-L", "100", "--search", `created:>=${sinceQ}`,
    "--json", "number,title,body,state,url,createdAt",
  ]),
)
  .filter((i) => new Date(i.createdAt) >= since)
  .sort((a, b) => a.number - b.number);

const openPrs = JSON.parse(
  gh(["pr", "list", "-R", REPO, "--state", "open", "-L", "200", "--json", "number,title,url,isDraft,createdAt,author"]),
);
const newPrs = openPrs.filter((p) => new Date(p.createdAt) >= since).sort((a, b) => a.number - b.number);

console.log(`Window from ${since.toISOString()}: ${issues.length} new issues, ${newPrs.length} new open PRs, ${openPrs.length} open PRs`);
if (issues.length === 0 && newPrs.length === 0) {
  console.log("Nothing new; no post.");
  process.exit(0);
}

const PROMPT = `Du fasst GitHub-Issues für das Entwicklerteam von FiBuKI (Vorbuchhaltung für österreichische EPUs) zusammen. Pro Issue ein deutscher Satz (max. 18 Wörter): worum geht es und was soll passieren. Keine Gedankenstriche. Antworte nur mit JSON: {"summaries": {"<nummer>": "<satz>"}}.`;

// One-line summaries; titles alone if Gemini is down, so the digest still goes out.
let summaries = {};
if (issues.length > 0) {
  try {
    const list = issues.map((i) => `### #${i.number} ${i.title}\n${(i.body || "").slice(0, MAX_BODY_CHARS)}`).join("\n\n");
    summaries = (await geminiJson(PROMPT, list)).summaries || {};
  } catch (err) {
    console.log(`Summaries failed, titles only: ${err.message}`);
  }
}

const link = (url, text) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
const parts = [`🛠 <b>Dev-Update</b> · ${viennaDay()}`];

if (issues.length > 0) {
  const lines = issues.slice(0, MAX_ITEMS).map((i) => {
    const icon = i.state === "OPEN" ? "🐞" : "✅";
    const summary = summaries[String(i.number)];
    return `${icon} ${link(i.url, `#${i.number}`)} ${escapeHtml(i.title)}${summary ? `\n     <i>${escapeHtml(summary.replace(/\s*—\s*/g, ", "))}</i>` : ""}`;
  });
  if (issues.length > MAX_ITEMS) lines.push(`… und ${issues.length - MAX_ITEMS} weitere`);
  parts.push(`<b>Neue Issues (${issues.length})</b>\n${lines.join("\n")}`);
}

if (newPrs.length > 0) {
  const lines = newPrs.slice(0, MAX_ITEMS).map(
    (p) => `${p.isDraft ? "📝" : "🔀"} ${link(p.url, `#${p.number}`)} ${escapeHtml(p.title)}`,
  );
  if (newPrs.length > MAX_ITEMS) lines.push(`… und ${newPrs.length - MAX_ITEMS} weitere`);
  parts.push(`<b>Neue offene PRs (${newPrs.length})</b>\n${lines.join("\n")}`);
}

parts.push(`📬 Offene PRs insgesamt: ${link(`https://github.com/${REPO}/pulls`, String(openPrs.length))}`);

await postTelegram(process.env.TELEGRAM_DEV_CHAT_ID, parts.join("\n\n"));
