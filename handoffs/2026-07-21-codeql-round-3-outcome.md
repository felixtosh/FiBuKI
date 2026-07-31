# CodeQL round 3 outcome — 51 bulk mediums fixed on branch

**Status:** continues `2026-07-21-codeql-round-3.md`. Both tasks done on
branch `codeql/round-3-bulk-mediums` (off `main`, independent of PR #9,
which was still open at session start). Awaiting Stefan push + PR.

## What was fixed

### url-substring-sanitization ×26 (#40–#65) — commit e0de72f1

Per-file `hostMatches(url, host)` helpers: parse with `new URL`, compare
`hostname === host || hostname.endsWith("." + host)`. Flagged sites only;
path/query heuristics (`apis-secure/doc`, `doc=`, `billing`) untouched.

- `content.js` ×17: most sites became `locationHostMatches(host)` (reads
  `window.location.hostname` directly). The decoded `hostOrigin` param
  check uses `hostMatches` (with a bare-hostname fallback that prefixes
  `https://`). The href/search fallback at old :115-116 became
  `urlParamsReferenceHost(href, "admin.google.com")` — scans query param
  values instead of raw substring; slight narrowing (no longer matches the
  hostname embedded in the path), accepted as the point of the fix.
- `background.js` ×6: `hostMatches(url, "payments.google.com")`; the
  `doc=`/`apis-secure` substring halves of each condition kept.
- `lib/url-utils.js`: `shouldTrackRequest` host gate; `hostMatches`
  exported. Generic `doc=` check stays host-independent (existing test
  depends on it).
- `dev-extractor.js`: local helper for the `admin.google.com` check.
- `hooks/use-browser-learn-mode.ts` :197: `accounts.google.com` check.
- **Manifest stays 0.0.3** — no GitHub Release published since 0.0.3 was
  merged (`gh release list` empty), so no bump per RELEASING.md.

### log-injection ×25 — commit 8e49a843

Per-file `sanitizeForLog()` (Error-aware: uses `stack || message`, then
strips `[\r\n]` → space) wrapping only the tainted args at each flagged
site. Same messages/levels. Note: `%s` args are NOT accepted for
js/log-injection (the already-`%s` site finapi-connections :437 was still
flagged) — that lesson applied only to tainted-format-string in round 1.

## Verification done here

- `node --check` on all four extension JS files: clean.
- Standalone assertions against the rewritten `url-utils.js` (exact host,
  subdomain, path-embedded, lookalike, unparseable, doc= preservation):
  all pass (`scratchpad/check-url-utils.js`, plain node).
- Scoped `npx -y -p typescript tsc --noEmit --skipLibCheck --ignoreConfig`
  (TS 6 needs `--ignoreConfig`; repo `node_modules` is EMPTY on this box,
  plain `npx tsc` yields a troll placeholder package) on all 13 changed TS
  files: only environment noise (TS2307/TS2591 process/Buffer, TS2503,
  TS7006 — no tsconfig/types in CLI mode), zero errors touching the new
  helpers or edited lines.
- **Not run:** extension jest suite. It was bulk-moved to
  `extensions/taxstudio-browser-tests/` (commit d1022f34) where its
  `require("../lib/url-utils")` no longer resolves and jest isn't
  installed — the suite is currently unrunnable/unwired anywhere. Test
  file updated anyway (hostMatches coverage + path-embedded
  shouldTrackRequest case). Flag for Stefan: rewire or move back.

## After merge

- Re-query branch analysis before merging:
  `alerts?ref=refs/heads/codeql/round-3-bulk-mediums&state=open` — all 51
  should be closed there.
- Remaining open security alerts should then be exactly #35/#36
  (system-prompt-injection), closed by PR #9 when it merges.
- Task 3 (quality noise ×166: suite switch vs cleanup round, path
  exclusions) is Stefan's decision — not started.

## External follow-ups (unchanged from round-3 doc)

- Felix: functions deploy for round-2 fixes + `@fibukiapp/cli` 0.1.1 npm
  publish — verify Stefan's batched ask went out.
- Chrome Web Store: 0.0.3 ships on next published GitHub Release.
