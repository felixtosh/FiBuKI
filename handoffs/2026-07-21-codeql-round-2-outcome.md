# CodeQL round 2 outcome — highs fixed, bulk mediums left for round 3

**Status:** branch `codeql/round-2-highs` implements the fix portion of
`2026-07-21-codeql-round-2.md` priorities 2–3 (24 alerts addressed by code).
Stefan pushes + opens the PR (paste blocks in session summary / below).
Prompt-injection (#35/#36) is analyzed but **not** implemented — decision
below. Bulk mediums (url-substring ×26, log-injection ×25) and quality
noise ×166 are round 3.

## What this branch fixes

- **regex-anchor ×8** (#115–#122): anchored the hostname-bearing login
  patterns to `^https?://` in `content.js` (LOGIN_URL_PATTERNS) and
  `lib/replay-engine.js` (AUTH_PATTERNS). Path-only patterns untouched.
  auth0 uses `([^/?#]+\.)?auth0\.com` so `evil.com/?a=.auth0.com` can't match.
- **incomplete-url-scheme-check ×2** (#38/#39): replaced
  `indexOf("javascript:")` checks with `new URL(...)` +
  http/https protocol allowlist in `getManualCandidateUrlFromElement` and
  the PDF-link collector (which also now reuses the parsed URL for the
  origin check).
- **bad-tag-filter ×3 + incomplete-multi-character-sanitization ×9**
  (#69–#80): HTML→text stripping now loops until fixpoint (CodeQL's
  documented remediation) with `<\/script[^>]*>`-style closers, in
  `analyze-email/route.ts`, `lookupCompany.ts`, `geminiSearchHelper.ts`.
  Sender-name extraction (`gmailSyncQueue.ts`, `precisionSearchQueue.ts`
  ×2) uses `from.split("<")[0]` instead of a tag regex. Ported domain
  logic changed minimally: same outputs on normal input (tested).
- **polynomial-redos ×2** (#83/#84): `parseFromHeader` in gmail
  attachment + convert-to-pdf routes rewritten — angle-bracket extraction
  first, then an unambiguous email regex, input capped at 1 KB (the old
  regex was quadratic; the rewrite tested fine on adversarial input, cap
  bounds it regardless). Behavior verified on normal headers incl. quoted
  display names.
- **insecure-randomness ×1** (#31): `generateSessionId` now
  `crypto.randomUUID()`; no consumer parses the old format (grepped).
- **manifest bumped 0.0.2 → 0.0.3** (extension code changed; RELEASING.md —
  Chrome Web Store upload happens only on a published GitHub Release).

Verification: `node --check` on extension JS, manifest JSON parse, scoped
`tsc --noEmit` on the 8 touched TS files (clean once cross-project
module-resolution noise is filtered), regex behavior tests incl.
attacker-shaped URLs and a 100 KB adversarial From header. Full CI runs
lint/typecheck/build on the PR.

Caveat: the fixpoint-loop pattern is CodeQL's own documented fix, but if
the multi-char-sanitization alerts don't auto-close after merge, treat the
loop as correct and dismiss with that rationale — don't re-litigate the code.

## Prompt-injection decision (#35/#36) — for Stefan

Round-2 investigation confirms round 1's analysis:

- `app/api/chat/route.ts` only unshifts SYSTEM_PROMPT when the client sent
  no system message → a client-sent `role:"system"` **replaces** the
  server prompt.
- `app/api/agent/route.ts` deserializes client system messages and
  serializes them back out (full round-trip).
- `components/chat/chat-provider.tsx` **never originates** a system
  message — lines 484/540/1045 only re-label stored session messages.

**Recommendation: option (a), server always owns the prompt.** Since the
UI never creates system messages, dropping `role:"system"` on ingest in
both routes + always unshifting SYSTEM_PROMPT + not serializing system
messages back is a no-behavior-change hardening for the legitimate client,
and closes both alerts properly instead of dismissing. Risk is limited to
non-UI clients that deliberately send a system role (none known).
Option (b) dismissal remains defensible (owner-scoped assistant), but (a)
is small and testable. Awaiting Stefan's call before touching chat flow.

## Round 3 backlog (after this merges)

1. Prompt-injection per Stefan's decision above.
2. **url-substring-sanitization ×26** (#40–#65): mostly extension
   (`content.js` ×18, `background.js` ×6, `dev-extractor.js`,
   `lib/url-utils.js`) + `hooks/use-browser-learn-mode.ts:197`. Formulaic
   fix: per-file `hostMatches(url, host)` helper (parse URL, hostname
   `===` or `.endsWith("." + host)`) replacing `.includes("host")`.
   Needs another manifest bump if it lands after 0.0.3 ships.
3. **log-injection ×25**: strip `\r\n` from (or JSON.stringify) tainted
   values in console.log calls across api routes, `lib/finapi/client.ts`,
   `lib/agent/worker-graph.ts`.
4. Quality noise ×166 + suite question (`security-extended` vs
   `security-and-quality`) — Stefan decision.

## Dismissals for Stefan (unchanged from round-2 doc)

- #295 http-to-file-access (re-keyed #87, by design) — command block in
  `2026-07-21-codeql-round-2.md`.
- #85/#86 user-controlled-bypass — verified this session: the flagged
  checks only pause/resume the invoice-pull overlay UX
  (`checkForLoginRedirect`/`resumeAfterLogin`); no authorization depends
  on them. Dismiss "won't fix" as UX flow control.
  **Dismiss after this PR merges** — re-check state first, moved lines may
  re-key alert numbers (the #87 → #295 lesson).

## External follow-ups (still open)

- Felix / @fibukiapp npm scope: 0.1.1 publish blocked on Felix (memory).
- Chrome Web Store: 0.0.3 ships on next published GitHub Release.
