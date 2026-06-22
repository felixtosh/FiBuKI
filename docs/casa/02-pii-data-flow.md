# 02 — PII Data Flow Map

**Application:** FiBuKI
**Operator:** Infinity Vertigo GmbH (joint controller for product data, processor for accounting data)
**Last updated:** 2026-06-21

This document maps every category of personal data FiBuKI handles: where it enters the system, where it lives, who can read it, and how long it stays.

## 1. Data classification

| Class | Examples | Sensitivity |
| --- | --- | --- |
| **A — Authentication secrets** | Firebase password hashes, OAuth refresh tokens, encryption key | Critical |
| **B — Google user data** | Gmail message headers, attachments, sender info | High (restricted scope) |
| **C — Financial data** | Bank-transaction records, partner names, amounts, IBANs | High |
| **D — Account identity** | Email address, display name, locale | Medium |
| **E — Behavioural** | Usage logs (function calls), AI usage logs | Low |

## 2. Entry points

| Entry point | Data class | Origin | Controls |
| --- | --- | --- | --- |
| Sign-up form | D | User | TLS 1.3, Firebase Auth |
| Google Sign-In | D | Google OIDC | OAuth 2.0, `id_token` verified server-side |
| Gmail consent (`/api/gmail/authorize`) | A, B | Google OAuth | Random `state`, server-side callback |
| Gmail API calls (`searchGmailCallable`, `downloadAttachmentCallable`) | B | Google Gmail | App Check + ID token, per-request authz |
| Open Banking aggregation (TrueLayer/finAPI) | C | Bank | PSD2-licensed aggregator, OAuth |
| CSV bank import | C | User upload | Server-side validation, per-user storage path |
| Receipt upload | C | User | Mime sniff, AV scan (Cloud Storage), per-user path |
| Email forward to dedicated inbox | C | User | DKIM/SPF verified, sender allow-list |

## 3. Storage map

| Data | Location | Class | Encryption at rest | Access path |
| --- | --- | --- | --- | --- |
| Firebase password hash | Firebase Auth | A | Google-managed AES-256 (scrypt internal) | Firebase Auth API only |
| Gmail refresh token | `emailIntegrations/{id}` (Firestore) | A | App-layer AES-256-GCM + Google-managed AES-256 | Cloud Functions only (rule: `false` for clients) |
| Gmail encryption key | Firebase Secret Manager | A | Google KMS | Cloud Functions runtime env |
| Email metadata (subject, sender, date) | **Not stored** — fetched on each request | B | n/a | Transit only |
| Email body | **Not stored** — only inspected for invoice heuristics in memory | B | n/a | Transit only |
| Attachment content | `files/{id}` (Firestore) + Cloud Storage `/users/{uid}/files/{id}` | B → C | Google-managed AES-256 | Authenticated user only |
| Bank transactions | `transactions/{id}` (Firestore) | C | Google-managed AES-256 | Authenticated user only |
| Partners | `partners/{id}` (Firestore) | C | Google-managed AES-256 | Authenticated user only |
| Account profile | `users/{uid}` (Firestore) | D | Google-managed AES-256 | Authenticated user only |
| Function invocation logs | `functionCalls/{id}` (Firestore) | E | Google-managed AES-256 | Admin only |
| AI usage logs | `aiUsage/{id}` (Firestore) | E | Google-managed AES-256 | Admin + owner |

All data resides in `europe-west1` (Firestore, Cloud Storage, Cloud Functions). Frontend hosting is in `europe-west4` (Firebase App Hosting). No cross-region replication outside the EU is configured.

## 4. Access control matrix

| Principal | A (secrets) | B (Gmail) | C (financial) | D (identity) | E (logs) |
| --- | --- | --- | --- | --- | --- |
| End user (Firebase Auth) | — | Own only | Own only | Own | Own AI usage |
| Cloud Function (service account) | Read in memory | Read on user behalf | Read/write on user behalf | Read/write | Write |
| Admin (Firebase custom claim) | — | — | — | — | Read |
| Anonymous | — | — | — | — | — |

Firestore rules enforce this at the database layer; bypassing the rules is not possible from a client SDK. Cloud Functions use the Admin SDK and enforce the same model in code (`createCallable()` injects `ctx.userId`).

## 5. Egress / sharing

| Destination | Data class | Purpose | Legal basis |
| --- | --- | --- | --- |
| Google Gmail API | A (token), B (request) | Fulfil user-initiated search | User consent (OAuth) |
| Google Vertex AI (Gemini) | B (attachment bytes), C (transaction text) | Document extraction, CSV column matching, partner matching | Legitimate interest; DPA in place with Google |
| Anthropic Claude API | B (chat content), C (transaction text) | Chat / agent feature | Consent; Anthropic DPA in place |
| LangFuse | Trace metadata (redacted) | Observability | Legitimate interest; EU-hosted |
| Stripe | D (email), C (subscription metadata) | Billing | Contract |
| SendGrid | D (email) | Transactional email | Legitimate interest |
| TrueLayer / finAPI / Plaid | C (bank credentials proxy) | Open Banking | User consent (PSD2) |

No PII is sold or shared for advertising. Gmail-derived data specifically is **never** used to train any model, never shared, and never used outside the user-visible feature it was acquired for (per [03-oauth-scope-justification.md](./03-oauth-scope-justification.md)).

## 6. PII data-flow diagram (Gmail path)

```
USER BROWSER ──TLS 1.3──▶ /api/gmail/authorize ──redirect──▶ google.com/oauth
                                                                  │
                                                                  │ user consents
                                                                  ▼
                          /api/gmail/callback ◀────state+code─────┘
                                  │
                                  │ (server-side only)
                                  ▼
                          exchange code → tokens
                                  │
                                  ▼
                          encrypt(refresh_token, key) → AES-256-GCM
                                  │
                                  ▼
                          emailIntegrations/{id}      ── Firestore (eu-west1)
                                  │
USER ACTION (search) ──ID token + App Check──▶ searchGmailCallable
                                  │
                                  │ load token, decrypt in memory
                                  ▼
                          Gmail API (transit only)
                                  │
                                  ▼
                          metadata + attachment refs ──▶ USER
                                                          │
USER ACTION (download) ───────────────────────────────────┘
                                  │
                                  ▼
                          downloadAttachmentCallable
                                  │
                                  ▼
                          Cloud Storage /users/{uid}/files/{id}
                                  │
                                  ▼
                          Firestore files/{id} (metadata)
```

## 7. Retention

See [04-data-retention-policy.md](./04-data-retention-policy.md). Highlights:

- Refresh tokens: deleted immediately on disconnect.
- Email metadata: not persisted.
- Attachment content: kept while the user keeps the file; soft-deleted on user delete, hard-deleted after 30 days.
- Full account deletion: removes all classes A–E within 30 days.

## 8. Subject rights

Per GDPR, users can exercise access, rectification, erasure, restriction, portability, and objection rights through the in-app settings page or by contacting `hello@fibuki.com`. Most rights are self-service; identity is verified via Firebase Auth.

## Evidence pointers

- `firestore.rules` — access matrix enforcement
- `lib/crypto/encryption.ts`, `functions/src/utils/encryption.ts` — refresh-token encryption
- `app/api/gmail/callback/route.ts` — token-encryption write path
- `functions/src/utils/createCallable.ts` — per-user authz injection
