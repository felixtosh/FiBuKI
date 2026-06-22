# 06 — Self-Assessment Questionnaire

**Application:** FiBuKI
**Last updated:** 2026-06-21
**Author:** Felix Häusler (Managing Director, Infinity Vertigo GmbH)

Questions mirror Google's OAuth-app SAQ + the CASA Tier 2 non-functional controls. Each answer is short; deeper context is in the linked artifact.

---

## A. Application overview

**A1. Application name and URL.**
FiBuKI — https://fibuki.com

**A2. Application description.**
Bookkeeping pre-accounting tool that helps small businesses and freelancers match emailed invoices and bank-account transactions.

**A3. Type of users.**
Individual small-business owners, freelancers, and accountants acting on behalf of clients. Consumer Gmail and Google Workspace users both supported.

**A4. Production hostnames.**
`fibuki.com`, `*.fibuki.com`.

**A5. Hosting region(s).**
Application: Firebase Cloud Functions (`europe-west1`), Firebase App Hosting (`europe-west4`). Data: Firestore + Cloud Storage in `europe-west1`. No data leaves the EU for primary storage.

---

## B. OAuth and scopes

**B1. Which Google OAuth scopes do you request?**
`gmail.readonly`, `userinfo.email`, `userinfo.profile`. See [03-oauth-scope-justification.md](./03-oauth-scope-justification.md).

**B2. Why is `gmail.readonly` necessary?**
It is the minimum scope that grants attachment-byte download. `gmail.metadata` does not allow attachment access. See [03 §2.2](./03-oauth-scope-justification.md).

**B3. How is each scope minimised at runtime?**
Searches use `has:attachment` filters; body content is never sent to the browser; access tokens are not persisted. See [03 §2.3](./03-oauth-scope-justification.md).

**B4. How are OAuth refresh tokens stored?**
AES-256-GCM-encrypted (`lib/crypto/encryption.ts`) before being written to `emailTokens/{id}` in Firestore. Key in Firebase Secret Manager.

**B5. How are access tokens stored?**
Held in Cloud Function memory for a single invocation. Never persisted.

**B6. Is the OAuth flow protected from CSRF?**
Yes — random `state` parameter generated in `app/api/gmail/authorize/route.ts` and verified in `app/api/gmail/callback/route.ts`.

**B7. Can the user revoke access?**
Yes, two paths: in-app Disconnect (`/settings/integrations`) and Google's permissions page (https://myaccount.google.com/permissions). In-app revocation is processed by `app/api/gmail/disconnect/route.ts`.

---

## C. Data handling

**C1. What user data is stored from Google APIs?**
Only attachment bytes the user chooses to keep. Email metadata and bodies are processed in memory only. See [02-pii-data-flow.md §3](./02-pii-data-flow.md).

**C2. Is Google user data ever transferred to third parties?**
Only to processors strictly necessary for the user-facing feature (Vertex AI for invoice detection, Anthropic Claude only on explicit user action). DPAs are in place. See [03 §5](./03-oauth-scope-justification.md).

**C3. Is Google user data used for training ML models?**
No.

**C4. Is Google user data used for advertising?**
No. FiBuKI does not run advertising.

**C5. Can users delete their Google data?**
Yes — Disconnect (immediate token deletion + soft-delete of orphaned files), file delete (30-day soft-delete window), account delete (30-day grace + full purge).

---

## D. Authentication and identity

**D1. How are end users authenticated?**
Firebase Auth — email/password (scrypt) or Google Sign-In.

**D2. Is MFA available to users?**
Yes, TOTP via Firebase Auth.

**D3. Are passwords transmitted over TLS?**
Yes, TLS 1.3 enforced.

**D4. Is account-recovery secure?**
Firebase Auth email-link recovery, signed by Google.

**D5. Are session tokens revocable?**
Yes. Sign-out clears refresh; admin can force-revoke through Firebase Auth.

---

## E. Authorization

**E1. How is per-user data isolation enforced?**
Two layers: (a) `firestore.rules` per-user predicates on every collection, (b) `createCallable()` injects `ctx.userId` and every handler filters by it.

**E2. Are there server-side checks for every authenticated action?**
Yes. `createCallable()` enforces `UNAUTHENTICATED`; handlers reject cross-user reads/writes.

**E3. Are administrative privileges minimised?**
Yes. `admin` custom claim, granted manually, scoped to specific support actions.

**E4. Is there a privileged-account audit log?**
Yes — admin actions logged to `functionCalls` with status and duration.

---

## F. Cryptography and key management

**F1. What algorithms are used for at-rest encryption of sensitive data?**
Application layer: AES-256-GCM for OAuth refresh tokens. Platform layer: Google-managed AES-256 for all Firestore and Cloud Storage data.

**F2. What algorithms are used for transport encryption?**
TLS 1.3 (TLS 1.2 minimum).

**F3. How are encryption keys managed?**
Firebase Secret Manager + Google KMS. The Gmail token key is in `GMAIL_TOKEN_ENCRYPTION_KEY`.

**F4. Are private keys ever exposed to the client?**
No.

---

## G. Logging, monitoring, incident response

**G1. What is logged?**
Cloud Function invocations (name, userId, duration, status), errors, AI usage, Firebase Auth events. OAuth tokens are stripped before any log emission.

**G2. How long are logs retained?**
`functionCalls` 90 days; Cloud Logging 30 days; Firebase Auth audit per Google retention.

**G3. Is there an alerting mechanism for anomalies?**
Yes — Cloud Logging based alerts to the security contact email.

**G4. Is there an incident-response procedure?**
Yes — see [SECURITY.md](../../SECURITY.md). Severity classification, 72-hour data-breach notification to authorities and affected users (GDPR Art. 33/34).

---

## H. Vulnerability management

**H1. How are dependencies kept current?**
GitHub Dependabot weekly; security advisories handled within 7 days for high/critical.

**H2. How is the code scanned for vulnerabilities?**
- SAST: GitHub CodeQL (planned; see [07-sast-remediation-report.md](./07-sast-remediation-report.md))
- DAST: OWASP ZAP baseline + Fluid Attacks against staging (see [08-dast-remediation-report.md](./08-dast-remediation-report.md))
- Dependencies: Dependabot + `npm audit` in CI

**H3. Is there a vulnerability disclosure policy?**
Yes — [SECURITY.md](../../SECURITY.md) and https://fibuki.com/.well-known/security.txt.

**H4. SLA for fixing vulnerabilities?**
Critical: 7 days; High: 30 days; Medium: 90 days; Low: best-effort.

---

## I. Software-development lifecycle

**I1. Is source code version-controlled?**
Yes — GitHub.

**I2. Are commits/PRs reviewed?**
Branch protection on `main` requires passing CI; sole-maintainer PRs are self-reviewed with required test coverage on changed paths.

**I3. Are dependencies pinned?**
Yes — `package-lock.json` committed.

**I4. Are secrets ever committed to source control?**
No. Pre-commit hook + `.gitignore` exclude `.env*`. Verified by spot scans.

**I5. Is there a separate non-production environment?**
Yes — Firebase staging project for pre-production testing.

---

## J. Network and infrastructure

**J1. Is the application accessible only via HTTPS?**
Yes. HTTP is upgraded by Firebase App Hosting. HSTS is set with `max-age=63072000; includeSubDomains; preload` in `next.config.ts`; preload-list submission planned 2 weeks after deploy.

**J2. Are response security headers configured?**
Yes. Configured in `next.config.ts`:
- `Content-Security-Policy` (allow-list including Firebase, App Check, Cloud Functions, banking aggregators)
- `Strict-Transport-Security`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (camera/microphone/geolocation denied)
- `Cross-Origin-Opener-Policy: same-origin-allow-popups`

**J3. Is there CDN or edge caching?**
Yes — Firebase App Hosting CDN. Static-asset CORS to be re-audited (orbis Vercel-equivalent gotcha).

**J4. Are CORS policies restrictive?**
Yes. Application responses use allow-listed origins inside `createCallable()`. No wildcard CORS on application responses.

---

## K. Data subject rights

**K1. Can users access their data?**
Yes — export feature in `/settings` (`functions/src/user-export/`).

**K2. Can users delete their data?**
Yes — Disconnect, file delete, account delete (30-day grace).

**K3. Can users correct their data?**
Yes — in-app edit.

**K4. Can users port their data?**
Yes — CSV/PDF export via `functions/src/user-export/`.

---

## L. Legal and contractual

**L1. Operator legal entity.**
Infinity Vertigo GmbH, FN571837m, ATU77919424, Bergwald 43, 2812 Hollenthon, Austria.

**L2. Data Processing Agreements with subprocessors.**
Google (Firebase + Vertex AI): standard DPA. Anthropic: DPA in place. Stripe, SendGrid, LangFuse, TrueLayer/finAPI/Plaid: DPAs in place.

**L3. Cross-border data transfers.**
Default storage in EU. Vertex AI EU region. Anthropic Claude API and OpenAI plugin (if used) covered by SCCs.

**L4. GDPR compliance.**
Yes — privacy policy at https://fibuki.com/privacy, lawful basis stated per processing activity, DSARs handled within 30 days.

---

## M. Business continuity

**M1. Backup strategy.**
Firestore PITR 7-day window; code in GitHub; secrets in Secret Manager (recoverable). Cloud Storage objects not versioned.

**M2. RTO / RPO targets.**
RTO 24 hours, RPO 1 hour for application-tier outages.

**M3. Disaster-recovery testing.**
Annual recovery test from PITR snapshot. Last test: pending (first formal test scheduled before CASA submission).

---

## Sign-off

I attest that the responses above accurately describe FiBuKI's controls as of the date above. Discrepancies between this document and the source code are bugs in this document; please file an issue via the channel listed in SECURITY.md.

— Felix Häusler, Managing Director, Infinity Vertigo GmbH
