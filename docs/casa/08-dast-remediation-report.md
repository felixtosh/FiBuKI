# 08 — DAST Remediation Report (Template)

**Application:** FiBuKI
**Status:** Template — populate after first DAST run
**Last updated:** 2026-06-21

This report records dynamic-scan findings against a live FiBuKI environment and the remediation evidence supplied for revalidation.

## 1. Scan configuration

| Field | Value |
| --- | --- |
| Primary tool | OWASP ZAP (baseline + active scan) |
| Secondary tool | Fluid Attacks CLI |
| Auxiliary checks | Qualys SSL Labs, securityheaders.com, mozilla/observatory |
| Target | `https://staging.fibuki.com` (mirrors prod, no real user data) |
| Scan scope | All public routes + authenticated user routes (using test user) |
| Auth method | Session cookie / Firebase ID token injected via ZAP authentication script |
| Run date | _TBD_ |
| Commit at scan time | _TBD_ |

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

| Severity | Open | Fixed | Accepted | False positive |
| --- | --- | --- | --- | --- |
| Critical | 0 | 0 | 0 | 0 |
| High | 0 | 0 | 0 | 0 |
| Medium | 0 | 0 | 0 | 0 |
| Low | 0 | 0 | 0 | 0 |

## 4. Findings detail

> One subsection per finding.

### 4.1 [example] Missing Content-Security-Policy header

| Field | Value |
| --- | --- |
| Tool | OWASP ZAP baseline |
| CWE | CWE-693 |
| Severity | Medium |
| Endpoint | `/` (all routes) |
| Description | No `Content-Security-Policy` header was returned. |
| Status | Fixed |
| Fix commit | `_TBD_` |
| Fix | Added CSP in `next.config.ts` with allow-list for Stripe, Google Identity, Firebase, fonts (self-hosted). |
| Verification | Re-ran ZAP baseline; finding cleared. Screenshot in `evidence/csp-after.png`. |

### 4.2 [example] HSTS not enforced

| Field | Value |
| --- | --- |
| Tool | securityheaders.com |
| Severity | Medium |
| Description | `Strict-Transport-Security` header missing. |
| Status | Fixed |
| Fix commit | `_TBD_` |
| Fix | `next.config.ts` adds `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`. |
| Verification | securityheaders.com grade went from D to A. |

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
