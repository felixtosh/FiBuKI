# 07 — SAST Remediation Report

**Application:** FiBuKI
**Status:** First scan complete — zero findings
**Last updated:** 2026-06-22

This report records static-analysis findings and the fixes applied. Re-run for each major release; keep the most recent scan's report here, archive previous scans in `archive/`.

## 1. Scan configuration

| Field | Value |
| --- | --- |
| Tool | GitHub CodeQL 2.25.6 |
| Query packs | `security-extended`, `security-and-quality` (200 rules total) |
| Alternative tools considered | Semgrep (`p/owasp-top-ten`, `p/javascript`), SonarCloud |
| Repository scope | `/app`, `/components`, `/hooks`, `/lib`, `/functions/src` |
| Languages | JavaScript, TypeScript |
| Branch / ref | `refs/pull/29/merge` (CASA-prep branch merged into main) |
| Run date | 2026-06-22 12:32 UTC |
| Commit | `cfd8c0dda607db22ee91a73670f33975992ee5fc` |
| Analysis ID | 1390779778 |
| Run URL | https://github.com/felixtosh/FiBuKI/actions/runs/27952747236 |
| SARIF ID | `6bfe6962-6e36-11f1-99ed-e8708e1499b0` |

## 2. Findings summary

| Severity | Open | Fixed | Accepted (with justification) | False positive |
| --- | --- | --- | --- | --- |
| Critical | 0 | 0 | 0 | 0 |
| High | 0 | 0 | 0 | 0 |
| Medium | 0 | 0 | 0 | 0 |
| Low | 0 | 0 | 0 | 0 |

**Result: 0 alerts across 200 rules.** The codebase passed CodeQL's `security-extended` + `security-and-quality` query sets with no findings.

## 3. Findings detail

No findings to record from this scan.

## 4. Accepted risks

| Finding | Reason for acceptance | Compensating control | Re-review date |
| --- | --- | --- | --- |

## 5. Re-scan evidence

| Date | Tool | Commit | Findings count | Notes |
| --- | --- | --- | --- | --- |
| 2026-06-22 | CodeQL 2.25.6 | `cfd8c0d` | 0 / 200 rules | First scan; analysis 1390779778; PR #29 merge ref |

## 6. CWE coverage map

For CASA Tier 2, every CWE listed in the CASA Accelerator export must be exercised. Track coverage here:

| CWE | Rule(s) ensuring coverage | Status |
| --- | --- | --- |
| CWE-79 (XSS) | `js/xss`, `js/reflected-xss`, `js/stored-xss` | Covered by `security-extended` |
| CWE-89 (SQL injection) | `js/sql-injection` | N/A — no SQL; Firestore only |
| CWE-200 (Sensitive info exposure) | `js/clear-text-storage-of-sensitive-information` | Covered |
| CWE-352 (CSRF) | `js/missing-token-validation` | Covered |
| CWE-601 (Open redirect) | `js/server-side-unvalidated-url-redirection` | Covered |
| CWE-915 (Mass assignment) | `js/prototype-pollution-utility` | Covered |
| _add others as CASA Accelerator requires_ | | |

## 7. How to reproduce

```sh
# CodeQL runs automatically via .github/workflows/codeql.yml:
#   - on push to main
#   - on every PR
#   - weekly on Monday 04:00 UTC
# Findings appear in GitHub → Security → Code scanning.

# Local Semgrep alternative for fast iteration:
docker run --rm -v "$PWD":/src returntocorp/semgrep \
  semgrep --config p/owasp-top-ten --config p/typescript /src
```

## 8. Sign-off

First CodeQL scan against the CASA-prep branch reported zero findings across 200 rules from the `security-extended` and `security-and-quality` query packs. Subsequent scans run weekly + per-PR via `.github/workflows/codeql.yml`; any new findings will be triaged and recorded above.

— Felix Häusler, 2026-06-22
