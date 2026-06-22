# 01 — Security Architecture

**Application:** FiBuKI
**Operator:** Infinity Vertigo GmbH
**Last updated:** 2026-06-21

## 1. Purpose

FiBuKI is a bookkeeping pre-accounting application that helps small business owners and freelancers match receipts and invoices to bank transactions. The Gmail integration searches the user's mailbox for invoice attachments. This document describes the trust boundaries, authentication flows, and defence-in-depth layers that protect Google user data once a user has connected their account.

## 2. System overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER                                      │
│  Browser (fibuki.com)              Mobile (PWA, no native app yet)  │
└────────────┬────────────────────────────────────────────────────────┘
             │ TLS 1.3
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  EDGE — Firebase App Hosting (europe-west4)         │
│  Next.js 15 SSR + static assets, HSTS, CSP, COOP                    │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│         APPLICATION — Firebase Cloud Functions (europe-west1)       │
│  • createCallable() wrapper: auth check, usage log, error handler   │
│  • App Check enforced on all callables                              │
│  • Per-user authorization in every handler (ctx.userId)             │
└────────────┬────────────────────────────────────────────────────────┘
             │ Admin SDK (service account)
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│              DATA — Firestore + Cloud Storage (europe-west1)        │
│  Encryption at rest (Google-managed AES-256)                        │
│  Per-user data isolation enforced by Firestore rules                │
│  OAuth tokens encrypted with AES-256-GCM before storage             │
└────────────┬────────────────────────────────────────────────────────┘
             │ OAuth refresh / mail.google.com (TLS 1.3)
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   THIRD PARTY — Google APIs                         │
│  Gmail API (read-only), OAuth 2.0                                   │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Trust boundaries

| Boundary | Crossing | Controls |
| --- | --- | --- |
| Internet → Edge | Inbound HTTPS | TLS 1.3 only, HSTS preload, COOP, CSP |
| Edge → Application | Authenticated callable | Firebase ID token + App Check token verified by `createCallable()` |
| Application → Data | Admin SDK | Service-account principal, scoped to project, per-user filters in every query |
| Application → Google APIs | OAuth refresh + API call | Refresh token decrypted in memory only, never logged; access token cached <= 1 h |
| Data → Backup | Daily PITR | Google-managed, encrypted at rest, EU residency |

## 4. Authentication and session management

| Component | Mechanism |
| --- | --- |
| End-user authentication | Firebase Auth (email/password + Google Sign-In) |
| Account recovery | Firebase Auth email link |
| Multi-factor authentication | Available via Firebase Auth (TOTP / SMS) |
| Session tokens | Firebase ID tokens (JWT, RS256), 1-hour lifetime, refreshed by SDK |
| OAuth state | Cryptographically random `state` parameter per authorization request (CSRF protection in `app/api/gmail/authorize/route.ts`) |
| OAuth code exchange | Server-side only in `app/api/gmail/callback/route.ts`, code never reaches the browser |
| Refresh tokens | Encrypted with AES-256-GCM (`lib/crypto/encryption.ts`, `functions/src/utils/encryption.ts`) before being persisted to Firestore |
| Access tokens | Held in memory by the Cloud Function for the duration of a single request; never written to Firestore |

## 5. Authorization

| Layer | Mechanism |
| --- | --- |
| API surface | Every callable in `functions/src/**` is wrapped by `createCallable()`, which throws `UNAUTHENTICATED` if `ctx.userId` is missing |
| Database | Firestore rules in `firestore.rules` enforce `request.auth.uid == resource.data.userId` on every user-scoped collection; sensitive collections (`emailTokens`, `passkeys`) are server-only (`allow read, write: if false`) |
| File storage | Cloud Storage rules enforce per-user path isolation |
| Admin operations | Gated by Firebase custom claim `admin: true`; super admin grant flows through `SUPER_ADMIN_EMAIL` env var |

## 6. Cryptography

| Use case | Algorithm | Key management |
| --- | --- | --- |
| OAuth refresh-token storage | AES-256-GCM (128-bit IV, 128-bit auth tag) | Single key in Firebase Secret Manager (`GMAIL_TOKEN_ENCRYPTION_KEY`), 64 hex chars |
| Transport | TLS 1.3 (TLS 1.2 minimum) | Google-managed certificates, auto-rotated |
| Data at rest | Google-managed AES-256 (Firestore, Cloud Storage) | Google KMS |
| Token signatures (Firebase ID tokens) | RS256 | Google-managed key rotation |
| Password storage | Firebase Auth (scrypt) | Managed by Google |

## 7. Network and platform controls

- **Region:** All compute and data live in `europe-west1` / `europe-west4` (Firebase App Hosting). No data is replicated outside the EU for primary storage.
- **Edge:** Firebase App Hosting fronts the Next.js app with Google Front End TLS termination.
- **Function ingress:** Cloud Functions are public-internet endpoints; authentication is enforced by `createCallable()` (Firebase ID token + App Check token).
- **CORS:** Origins allow-listed inside `createCallable()`; `Access-Control-Allow-Origin: *` is not used on application responses.
- **DDoS:** Mitigated by Google Front End and Cloud Armor (inherited from Firebase).
- **App Check:** Enforced for all callables to bind requests to verified app instances.

## 8. Defence in depth — Gmail data flow

```
1. User clicks "Connect Gmail" in /settings/integrations
2. /api/gmail/authorize generates CSRF state, redirects to Google
3. Google consent screen; user grants gmail.readonly
4. /api/gmail/callback:
     • Verifies state
     • Exchanges code → tokens (server side)
     • Encrypts refresh token (AES-256-GCM)
     • Writes emailIntegrations/{id} document
5. User triggers search → searchGmailCallable (Cloud Function):
     • Verifies Firebase ID token + App Check
     • Loads encrypted token, decrypts in memory
     • Refreshes access token if expired
     • Calls Gmail API with user query
     • Returns metadata + attachment refs to UI
     • Discards plaintext tokens at end of invocation
6. User clicks an attachment → downloadAttachmentCallable:
     • Same auth path
     • Streams attachment bytes to the user's file collection
     • Stored in Cloud Storage under /users/{uid}/files/{id}
```

## 9. Logging and monitoring

| Signal | Destination | Retention |
| --- | --- | --- |
| Cloud Function invocations | `functionCalls` collection (custom) | 90 days |
| Errors | Cloud Logging | 30 days |
| Auth events | Firebase Auth audit log | Default Google retention |
| AI usage | `aiUsage` collection | 90 days |
| Anomaly alerts | Email to security contact (configured) | n/a |

OAuth refresh tokens are **never** written to log sinks. The `createCallable()` wrapper strips sensitive fields before logging.

## 10. Software supply chain

- Source of truth: GitHub (this repo).
- CI: GitHub Actions (`.github/workflows/ci.yml`). All PRs require passing typecheck + tests before merge.
- Dependencies: `npm` lockfile committed; Dependabot enabled.
- Deployment:
  - Frontend: Firebase App Hosting auto-deploys from `main`.
  - Cloud Functions: Manual `firebase deploy --only functions` after PR merge.
- Secrets: Firebase Secret Manager + GitHub Actions encrypted secrets. No secrets are committed to the repo.

## 11. Inherited infrastructure assurance

The application runs entirely on Google Cloud / Firebase, which holds:

- SOC 1, SOC 2 Type II, SOC 3
- ISO/IEC 27001, 27017, 27018
- PCI DSS
- GDPR (EU data residency)

These cover physical, network, and hypervisor-layer controls.

## 12. Out of scope

This document covers the application-tier architecture. The following are inherited from Google Cloud / Firebase and are documented by Google:

- Physical data-centre security
- Hypervisor and host-OS hardening
- DNS infrastructure (Cloud DNS)
- TLS termination cipher-suite choice (Google Front End)

## Evidence pointers

- `lib/crypto/encryption.ts` — AES-256-GCM implementation
- `functions/src/utils/createCallable.ts` — auth/usage/error wrapper
- `firestore.rules` — per-user data isolation
- `app/api/gmail/authorize/route.ts` — OAuth state generation
- `app/api/gmail/callback/route.ts` — code exchange + token encryption
- `next.config.ts` — security response headers
