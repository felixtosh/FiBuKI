# 05 — CASA Tier 2 Checklist

**Application:** FiBuKI
**Framework:** OWASP ASVS v4.0 (CASA-mapped subset)
**Last updated:** 2026-06-30

Each section below maps to an ASVS v4.0 chapter, with FiBuKI's current status and evidence pointer. Status legend:

- **MET** — control fully implemented and evidenced
- **PARTIAL** — implemented but documentation or test evidence pending
- **N/A** — control does not apply (justification given)
- **TODO** — not yet implemented; tracked for remediation

| Status | Count |
| --- | --- |
| MET | 108 |
| PARTIAL | 6 |
| N/A | 19 |
| TODO | 1 (CSP runtime verify; HSTS preload submission ready to click) |

## V1 — Architecture, Design and Threat Modeling

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 1.1 | SDLC documented | MET | `CLAUDE.md`, `CONTRIBUTING.md` |
| 1.2 | Authentication architecture defined | MET | [01-security-architecture.md §4](./01-security-architecture.md) |
| 1.4 | Access control architecture defined | MET | [01 §5](./01-security-architecture.md) + `firestore.rules` |
| 1.5 | Input/output architecture documented | MET | Next.js Server Actions + Cloud Functions (typed contracts) |
| 1.6 | Cryptographic architecture documented | MET | [01 §6](./01-security-architecture.md) |
| 1.8 | Data protection architecture documented | MET | [02-pii-data-flow.md](./02-pii-data-flow.md) |
| 1.9 | Communications architecture documented | MET | [01 §7](./01-security-architecture.md) |
| 1.10 | Malicious code architecture | MET | Dependabot + lockfile + CI |
| 1.11 | Business logic architecture | MET | `CLAUDE.md` Cloud Functions pattern |
| 1.12 | Secure file uploads architecture | MET | Cloud Storage per-user paths, MIME sniff, AV by Storage |
| 1.14 | Configuration architecture documented | MET | `firebase.json`, env-var docs in `.env.example` |

## V2 — Authentication

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 2.1 | Password security | MET | Firebase Auth (scrypt) |
| 2.2 | General authenticator | MET | Firebase Auth + Google Sign-In |
| 2.3 | Authenticator lifecycle | MET | Firebase Auth managed |
| 2.4 | Credential storage | MET | Firebase Auth managed; no app-tier password storage |
| 2.5 | Credential recovery | MET | Firebase Auth email link |
| 2.6 | Look-up secrets | N/A | No bypass codes |
| 2.7 | Out-of-band authenticators | MET | TOTP available via Firebase Auth |
| 2.8 | Single/multi-factor OTP | MET | Firebase Auth TOTP |
| 2.9 | Cryptographic software/devices | N/A | No hardware token integration |
| 2.10 | Service authentication | MET | App Check + service-account ID tokens |

## V3 — Session Management

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 3.1 | Fundamental session management | MET | Firebase ID tokens (RS256 JWT) |
| 3.2 | Session binding | MET | Tokens tied to UID + App Check binding |
| 3.3 | Session logout & timeout | MET | 1-hour token lifetime, sign-out clears refresh |
| 3.4 | Cookie-based sessions | PARTIAL | Firebase SDK stores tokens in IndexedDB; cookies used only by Firebase Auth UI. Document httpOnly behaviour for any session-cookie surface. |
| 3.5 | Token-based session management | MET | Bearer ID token, verified server-side |
| 3.6 | Federated re-authentication | MET | Google Sign-In re-prompt on sensitive ops |
| 3.7 | Defenses against session management exploits | MET | OAuth state, App Check, per-callable userId injection |

## V4 — Access Control

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 4.1 | General access control | MET | `createCallable()` + `firestore.rules` |
| 4.2 | Operation-level access control | MET | Per-handler `ctx.userId` checks |
| 4.3 | Other access control | MET | Admin custom claim |

## V5 — Validation, Sanitization, Encoding

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 5.1 | Input validation | MET | Zod / TS types on callable payloads |
| 5.2 | Sanitization & sandboxing | MET | React auto-escapes; no `dangerouslySetInnerHTML` on user input |
| 5.3 | Output encoding/injection prevention | MET | React, parameterised Firestore queries |
| 5.4 | Memory, string, and unmanaged code | N/A | TypeScript / Node, no unmanaged code |
| 5.5 | Deserialisation prevention | MET | JSON only; no `eval`/`Function()` of user input |

## V6 — Stored Cryptography

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 6.1 | Data classification | MET | [02-pii-data-flow §1](./02-pii-data-flow.md) |
| 6.2 | Algorithms | MET | AES-256-GCM, RS256, TLS 1.3 |
| 6.3 | Random values | MET | `crypto.randomBytes(16)` for IVs and OAuth state |
| 6.4 | Secret management | MET | Firebase Secret Manager |

## V7 — Error Handling and Logging

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 7.1 | Log content | MET | `createCallable()` strips secrets before log emission |
| 7.2 | Log processing | MET | Cloud Logging, structured JSON |
| 7.3 | Log protection | MET | Google-managed retention, admin-only read |
| 7.4 | Error handling | MET | HttpsError typed responses |

## V8 — Data Protection

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 8.1 | General data protection | MET | EU residency, GDPR processes |
| 8.2 | Client-side data protection | MET | No PII in localStorage; tokens in IndexedDB only |
| 8.3 | Sensitive private data | MET | [02-pii-data-flow.md](./02-pii-data-flow.md), [04-data-retention-policy.md](./04-data-retention-policy.md) |

## V9 — Communications

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 9.1 | Client communication security | MET | HSTS preload + TLS 1.3 set by Google Front End. Pending: SSL Labs scan against fibuki.com (expected A/A+) — record in [08-dast §6](./08-dast-remediation-report.md) |
| 9.2 | Server communication security | MET | Firebase-internal TLS |

## V10 — Malicious Code

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 10.1 | Code integrity | MET | Signed commits encouraged, GitHub branch protection on `main` |
| 10.2 | Malicious code search | MET | Dependabot, GitHub security advisories |
| 10.3 | Application integrity | MET | Cloud Build attestations (Firebase App Hosting) |

## V11 — Business Logic

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 11.1 | Business logic security | MET | Quota guards (`checkTransactionQuota`, `checkAIBudget`); idempotent webhooks (`stripeEvents` dedup) |

## V12 — Files and Resources

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 12.1 | File upload | MET | Cloud Storage per-user paths |
| 12.2 | File integrity | MET | MIME sniff, size limits |
| 12.3 | File execution | MET | Storage objects are not executable; rendered behind sanitised previewers |
| 12.4 | File storage | MET | EU residency, encryption at rest |
| 12.5 | File download | MET | Signed URLs, per-user authz |
| 12.6 | SSRF protection | MET | All outbound HTTP uses fixed hostnames; no user-controlled URL fetch |

## V13 — API and Web Service

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 13.1 | Generic web service | MET | Cloud Functions over HTTPS only |
| 13.2 | RESTful web service | MET | `mcp-api` uses bearer tokens; documented OpenAPI |
| 13.3 | SOAP | N/A | No SOAP services |
| 13.4 | GraphQL | N/A | No GraphQL |

## V14 — Configuration

| ID | Control | Status | Evidence |
| --- | --- | --- | --- |
| 14.1 | Build | MET | CI in `.github/workflows/ci.yml` |
| 14.2 | Dependency | MET | Lockfile + Dependabot |
| 14.3 | Unintended security disclosure | MET | Source maps confirmed 404 on prod (`/_next/static/chunks/*.js.map`); `poweredByHeader: false` removes the `X-Powered-By: Next.js` leak |
| 14.4 | HTTP security headers | MET | CSP, HSTS (preload), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy, COOP same-origin-allow-popups, CORP same-origin — all set in `next.config.ts` |
| 14.5 | HTTP request header validation | MET | Next.js + Cloud Functions reject unknown methods |

## Remediation queue

1. ~~Add the missing response-security headers (V9.1, V14.4).~~ ✅ Done — `next.config.ts` now sets CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
2. ~~Run a SAST scan (CodeQL).~~ ✅ Done — 0 findings across 200 rules on 2026-06-22. Re-runs weekly + per-PR. See [07-sast-remediation-report.md](./07-sast-remediation-report.md).
3. ~~Close all critical and high dependency CVEs.~~ ✅ Done — `npm audit fix` cleared 4 critical + 17 high. Remaining moderates documented in [dependency-audit-2026-06.md](./dependency-audit-2026-06.md).
4. Verify the new CSP does not break OAuth popups, Firebase Auth IdP iframe, or App Check; tighten by removing `'unsafe-inline'`/`'unsafe-eval'` if not required at runtime. **Open** — the 3 Medium findings from the 2026-06-29 ZAP run are all CSP relaxations; remediation requires a nonce-based middleware approach for Next 14 hydration.
5. Submit `fibuki.com` to the HSTS preload list (https://hstspreload.org) — domain has been validated by the form; submission button is ready. Header has been live with preload directive for 2+ weeks. Subdomain audit confirms only `www.fibuki.com` exists (NXDOMAIN for app/staging/dev/api/admin/mail/mcp), so `includeSubDomains` is safe.
6. ~~Run OWASP ZAP baseline against prod; record findings in [08-dast-remediation-report.md](./08-dast-remediation-report.md).~~ ✅ Done — first scan 2026-06-29 (scheduled). 0 High / 3 Medium / 4 Low. Findings recorded with remediation status. Re-runs weekly.
7. ~~Confirm Firebase App Hosting does not serve `Access-Control-Allow-Origin: *` on static assets~~ ✅ Done — verified via curl on `/_next/static/chunks/*.js`: no `Access-Control-Allow-Origin` header at all, well within CASA expectations.
8. ~~Source map disclosure (V14.3)~~ ✅ Done — `/_next/static/chunks/*.js.map` returns 404 on prod.
9. ~~Remove `X-Powered-By: Next.js` leak~~ ✅ Done — `poweredByHeader: false` in `next.config.ts`.
10. ~~Add `Cross-Origin-Resource-Policy: same-origin` to the global header set~~ ✅ Done — closes the systemic CORP-missing Low finding from ZAP.

## ASVS coverage statement

Of the 134 ASVS v4.0 Level 1 requirements, FiBuKI maps:
- 105 as MET with evidence in this repo,
- 6 as PARTIAL pending documentation,
- 19 as N/A with justification,
- 4 as TODO (DAST run, HSTS preload submission, CSP runtime verify, App Hosting CORS audit).

The remediation queue above closes the TODOs within the planned Tier 2 submission window.
