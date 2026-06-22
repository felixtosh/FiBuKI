# 07 — SAST Remediation Report (Template)

**Application:** FiBuKI
**Status:** Template — populate after first SAST run
**Last updated:** 2026-06-21

This report records static-analysis findings and the fixes applied. Re-run for each major release; keep the most recent scan's report here, archive previous scans in `archive/`.

## 1. Scan configuration

| Field | Value |
| --- | --- |
| Tool | GitHub CodeQL (default queries: `security-extended`) |
| Alternative tools considered | Semgrep (`p/owasp-top-ten`, `p/javascript`), SonarCloud |
| Repository scope | `/app`, `/components`, `/hooks`, `/lib`, `/functions/src` |
| Languages | TypeScript, JavaScript |
| Branch | `main` |
| Run date | _TBD_ |
| Commit | _TBD_ |
| Scan ID / run URL | _TBD_ |

## 2. Findings summary

| Severity | Open | Fixed | Accepted (with justification) | False positive |
| --- | --- | --- | --- | --- |
| Critical | 0 | 0 | 0 | 0 |
| High | 0 | 0 | 0 | 0 |
| Medium | 0 | 0 | 0 | 0 |
| Low | 0 | 0 | 0 | 0 |

## 3. Findings detail

> Populate one entry per finding. Delete this guidance once first scan is recorded.

### 3.1 [FINDING-ID] — Short title

| Field | Value |
| --- | --- |
| Rule | `js/sql-injection` (example) |
| CWE | CWE-89 |
| Severity | High |
| File | `path/to/file.ts:42` |
| Description | Brief description of what the analyzer flagged. |
| Status | Fixed |
| Fix commit | `abcdef0` |
| Fix description | What the fix did. |
| Verification | How the fix was verified (manual, regression test, re-scan). |

## 4. Accepted risks

| Finding | Reason for acceptance | Compensating control | Re-review date |
| --- | --- | --- | --- |

## 5. Re-scan evidence

| Date | Tool | Commit | Findings count | Notes |
| --- | --- | --- | --- | --- |

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

Findings remediated to a level acceptable for CASA Tier 2 submission. Open findings (if any) are tracked in §4 with compensating controls.

— Felix Häusler, _date_
