# 08 — DAST Remediation Report

**Application:** FiBuKI
**Status:** First DAST run complete (2026-06-29)
**Last updated:** 2026-06-30

This report records dynamic-scan findings against a live FiBuKI environment and the remediation evidence supplied for revalidation.

## 1. Scan configuration

| Field | Value |
| --- | --- |
| Primary tool | OWASP ZAP (baseline + active scan) |
| Secondary tool | Fluid Attacks CLI |
| Auxiliary checks | Qualys SSL Labs, securityheaders.com, mozilla/observatory |
| Target | `https://fibuki.com` (production) |
| Scan scope | Baseline (unauthenticated) — `/`, `/robots.txt`, `/sitemap.xml`, public marketing routes |
| Auth method | None (baseline scan) |
| Run date | 2026-06-29 06:33 UTC (scheduled) |
| Workflow run | https://github.com/felixtosh/FiBuKI/actions/runs/28353237092 |
| Commit at scan time | `0b83c483` (CASA: record CodeQL scan result) |

## 2. How to reproduce

### 2.1 OWASP ZAP baseline (unauthenticated) — automated in CI

The baseline runs automatically via `.github/workflows/zap-baseline.yml`:
- Weekly on Monday 05:00 UTC
- On demand via the `workflow_dispatch` trigger (Actions → ZAP Baseline Scan → Run workflow)

Findings are stored as the `zap-baseline-report` artifact and the workflow opens GitHub issues for new findings.

For ad-hoc local runs use:

```sh
./scripts/run-zap-local.sh https://fibuki.com
# Reports written to build/zap/zap-baseline-<timestamp>.{html,json}
# Rule tuning lives in .zap/rules.tsv (accepted-risk row format)
```

### 2.2 OWASP ZAP full active scan (authenticated)

```sh
# Provide ZAP_AUTH_TOKEN via env to the authentication hook script.
docker run --rm -t -v "$PWD/scans:/zap/wrk" \
  zaproxy/zap-stable zap-full-scan.py \
  -t https://staging.fibuki.com \
  -z "-config replacer.full_list(0).description='auth' \
       -config replacer.full_list(0).enabled=true \
       -config replacer.full_list(0).matchtype=REQ_HEADER \
       -config replacer.full_list(0).matchstr=Authorization \
       -config replacer.full_list(0).replacement=Bearer $ZAP_AUTH_TOKEN" \
  -r /zap/wrk/zap-full-report.html
```

### 2.3 Fluid Attacks CLI

```sh
docker run --rm -v "$PWD":/src fluidattacks/cli scan --target /src
```

### 2.4 Qualys SSL Labs (browser)

https://www.ssllabs.com/ssltest/analyze.html?d=fibuki.com — re-run before submission; expect **A** or **A+**.

### 2.5 securityheaders.com (browser)

https://securityheaders.com/?q=fibuki.com — re-run before submission; expect **A**.

## 3. Findings summary

ZAP baseline scan 2026-06-29 against `https://fibuki.com`:

| Severity | Open | Accepted | Total |
| --- | --- | --- | --- |
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 3 | 0 | 3 |
| Low | 4 | 0 | 4 |
| Informational | 0 | 4 | 4 |

## 4. Findings detail

### 4.1 CSP: script-src `'unsafe-eval'`

| Field | Value |
| --- | --- |
| Tool | OWASP ZAP baseline |
| ZAP rule | 10055 |
| Severity | Medium |
| Endpoint | `/`, `/robots.txt`, `/sitemap.xml` (3 instances) |
| Description | `script-src` includes `'unsafe-eval'`, which lets script use `eval`-family APIs and weakens CSP's XSS defenses. |
| Status | Open (CSP runtime verification pending — see CASA checklist item 4) |
| Root cause | Initial CSP shipped with `'unsafe-eval'` to avoid breaking Next.js dev / production runtime. Confirm whether Next 14 + our deps actually require it; remove if not. |
| Verification plan | Exercise prod (OAuth popup, file upload, PDF preview, chat agent) with a tightened CSP in staging; remove `'unsafe-eval'` from `next.config.ts` if no console violations. Re-run ZAP. |

### 4.2 CSP: script-src `'unsafe-inline'`

| Field | Value |
| --- | --- |
| Tool | OWASP ZAP baseline |
| ZAP rule | 10055 |
| Severity | Medium |
| Endpoint | `/`, `/robots.txt`, `/sitemap.xml` (3 instances) |
| Description | `script-src` includes `'unsafe-inline'`. Inline scripts cannot be CSP-validated. |
| Status | Open |
| Root cause | Next 14 inlines a hydration bootstrap; removal usually requires the nonce-based CSP middleware path. |
| Verification plan | Migrate to nonce-based CSP via Next middleware; verify hydration still works; re-run ZAP. Tracked separately from the immediate CASA submission since it requires app-wide code change. |

### 4.3 CSP: style-src `'unsafe-inline'`

| Field | Value |
| --- | --- |
| Tool | OWASP ZAP baseline |
| ZAP rule | 10055 |
| Severity | Medium |
| Endpoint | `/`, `/robots.txt`, `/sitemap.xml` (3 instances) |
| Description | `style-src` includes `'unsafe-inline'`. |
| Status | Open |
| Root cause | Required by Tailwind v4 CSS-in-JS / Radix UI inline styles and Next.js critical-CSS inlining. |
| Verification plan | Same nonce-based approach as 4.2; bundled together. |

### 4.4 Cross-Origin-Embedder-Policy header missing

| Field | Value |
| --- | --- |
| Tool | OWASP ZAP baseline |
| Severity | Low |
| Endpoint | `/`, `/robots.txt` (2 instances) |
| Description | No `Cross-Origin-Embedder-Policy` (COEP) header. |
| Status | Accepted risk |
| Reason | Setting `COEP: require-corp` would break the Google OAuth popup, Firebase Auth iframe, and external image hosts (`*.googleusercontent.com`, `asset.brandfetch.io`) that don't serve CORP headers. CASA Tier 2 doesn't require COEP. |

### 4.5 Cross-Origin-Opener-Policy header missing (some pages)

| Field | Value |
| --- | --- |
| Tool | OWASP ZAP baseline |
| Severity | Low |
| Endpoint | 2 instances (likely `/robots.txt`, `/sitemap.xml` which return plain text without the layout headers) |
| Description | `Cross-Origin-Opener-Policy` is only set on HTML routes via `next.config.ts`. Plain-text public files miss it. |
| Status | Open (low priority) |
| Verification plan | Extend the COOP header to apply to all routes in `next.config.ts`. |

### 4.6 Cross-Origin-Resource-Policy header missing

| Field | Value |
| --- | --- |
| Tool | OWASP ZAP baseline |
| Severity | Low (systemic) |
| Description | No `Cross-Origin-Resource-Policy` (CORP) header on any response. |
| Status | Open (low priority) |
| Verification plan | Add `Cross-Origin-Resource-Policy: same-origin` to the global header set in `next.config.ts`. Keep `same-site` for resources that need to be embeddable (none currently). |

### 4.7 `X-Powered-By: Next.js` information leak

| Field | Value |
| --- | --- |
| Tool | OWASP ZAP baseline |
| Severity | Low (systemic) |
| Description | Response header advertises the framework + version. |
| Status | Open (trivial fix) |
| Verification plan | Set `poweredByHeader: false` in `next.config.ts`. |

## 5. Headers checklist

All headers configured in `next.config.ts` (commit pending verification in staging).

| Header | Target value | Status |
| --- | --- | --- |
| Strict-Transport-Security | `max-age=63072000; includeSubDomains; preload` | SET — preload submission pending 2-week soak |
| Content-Security-Policy | Allow-list (Firebase, App Check, Cloud Functions, TrueLayer, finAPI, Plaid, LangFuse) | SET — verify no console errors in staging |
| X-Frame-Options | `DENY` | SET |
| X-Content-Type-Options | `nosniff` | SET |
| Referrer-Policy | `strict-origin-when-cross-origin` | SET |
| Permissions-Policy | `camera=(), microphone=(), geolocation=(), payment=(self), interest-cohort=()` | SET |
| Cross-Origin-Opener-Policy | `same-origin-allow-popups` | SET |

## 6. TLS configuration

| Check | Expected | Actual | Status |
| --- | --- | --- | --- |
| Protocols enabled | TLS 1.2, TLS 1.3 only | _TBD_ | _TBD_ |
| Weak ciphers | None | _TBD_ | _TBD_ |
| HSTS | Enabled | _TBD_ | _TBD_ |
| Certificate chain | Valid, no missing intermediates | _TBD_ | _TBD_ |
| OCSP stapling | Enabled (provider-managed) | n/a | n/a |

## 7. Common-pitfalls audit

From [the orbis CASA Tier 2 retrospective](https://meetorbis.com/blog/how-we-passed-google-casa-tier-2-with-claude):

| Pitfall | Applies to FiBuKI? | Mitigation |
| --- | --- | --- |
| CDN serves `Access-Control-Allow-Origin: *` on static assets | TBD — audit Firebase App Hosting response headers | Override CORS for non-OAuth static routes if needed |
| Google Fonts CSS dynamic, no SRI | TBD — audit usage | Self-host fonts |
| TLS cipher suites on managed DB | n/a — Firestore is Google-managed | n/a |
| Source maps published in production | TBD — audit `npm run build` output | Disable `productionBrowserSourceMaps` in `next.config.ts` |

## 8. Accepted risks

| Finding | Reason | Compensating control | Re-review date |
| --- | --- | --- | --- |

## 9. Re-scan evidence

| Date | Tool | Findings count | Notes / report file |
| --- | --- | --- | --- |

## 10. Sign-off

Findings remediated to a level acceptable for CASA Tier 2 revalidation. Open findings (if any) are documented in §8 with compensating controls.

— Felix Häusler, _date_
