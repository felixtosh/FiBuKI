# 03 — OAuth Scope Justification

**Application:** FiBuKI
**Operator:** Infinity Vertigo GmbH
**Last updated:** 2026-06-21

This document justifies each Google OAuth scope FiBuKI requests, demonstrates that no narrower scope is sufficient, and confirms compliance with the Google API Services User Data Policy (including the Limited Use requirements).

## 1. Requested scopes

| Scope | Sensitivity | Source file |
| --- | --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | Restricted | `app/api/gmail/authorize/route.ts` |
| `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive | `app/api/gmail/authorize/route.ts` |
| `https://www.googleapis.com/auth/userinfo.profile` | Non-sensitive | `app/api/gmail/authorize/route.ts` |

No other Google scopes are requested. No Google Workspace admin scopes are used.

## 2. `gmail.readonly` — restricted scope justification

### 2.1 User-visible feature it enables

FiBuKI helps users assemble the receipts and invoices needed for bookkeeping. Most invoices in 2026 arrive as **PDF attachments** to email (utilities, SaaS, advertising platforms, freelancer marketplaces, etc.). The Gmail integration lets a user:

1. Search their Gmail for invoice attachments matching a bank transaction (e.g. "AWS €124.50 on 2026-03-15").
2. Preview the email metadata and attached PDFs to verify the right invoice was found.
3. Download the relevant attachment into their FiBuKI file library so it can be matched to the transaction.

Without this capability, users must search Gmail manually, download attachments by hand, and upload them to FiBuKI — a workflow that defeats the product's value proposition for the ~80 % of bookkeeping pre-accounting that involves matching emailed invoices to bank lines.

### 2.2 Why a narrower scope is insufficient

| Candidate | Why it does not work |
| --- | --- |
| `gmail.metadata` | Returns headers/labels only. **Does not allow attachment content download**, which is the core of the feature. |
| `gmail.addons.current.message.readonly` | Limited to Gmail Add-on context (sidebar inside Gmail). FiBuKI is a standalone web app, not a Gmail Add-on. |
| `gmail.addons.current.action.compose` | Compose-time only; we never compose. |
| `gmail.send` / `gmail.modify` | Write scopes; we strictly do not need them. |
| Pickup via user-forward-to-inbox | Considered. Rejected because (a) it requires users to set up filters for every sender, (b) historical mail is unreachable, (c) most users do not change forwarding habits even when nudged. |
| Third-party email API (Nylas / Unipile / Aurinko) | Considered. Rejected because routing every user's mail through a third party expands the attack surface, adds per-account cost, and forces users into a second consent dialog with another vendor. |

The minimum scope that supports searching mail **and** downloading attachment bytes is `gmail.readonly`. FiBuKI does not use any write or modify capability that this scope nominally also grants (it is a read-only scope by definition).

### 2.3 In-product minimisation

Within the bounds of `gmail.readonly`, FiBuKI applies further runtime minimisation:

- Searches are filtered to messages with attachments (`has:attachment`) wherever the user's query allows.
- Only metadata and attachment references are returned to the browser; **email body text is never sent to the client**.
- Email body content is only inspected server-side in volatile memory to assist invoice-detection heuristics and is never persisted.
- Refresh tokens are AES-256-GCM-encrypted before storage; access tokens are held in memory only for the duration of a single Cloud Function invocation.
- The user can disconnect Gmail from `/settings/integrations`, which deletes the stored tokens immediately.

## 3. `userinfo.email`

| Aspect | Value |
| --- | --- |
| Sensitivity | Non-sensitive |
| Purpose | Identify the connected Gmail account and display it to the user in the integration settings so they can distinguish accounts and disconnect the correct one |
| Stored where | `emailIntegrations/{id}.email` |
| Shown where | `/settings/integrations` |

## 4. `userinfo.profile`

| Aspect | Value |
| --- | --- |
| Sensitivity | Non-sensitive |
| Purpose | Display the user's name in the integration settings for account identification |
| Stored where | Not persisted; rendered from the OAuth profile response at connect time and then discarded |

## 5. Limited Use compliance

FiBuKI's use and transfer to any other app of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

| Requirement | Compliance |
| --- | --- |
| Use limited to user-facing features | ✅ Gmail data is used only to power the user-initiated search/download flow described in §2.1 |
| No advertising | ✅ FiBuKI runs no ad network; Gmail data is never used for ad targeting |
| No third-party transfer except as necessary | ✅ Data passes only through (a) Google Gmail, (b) FiBuKI's own Cloud Functions, (c) Vertex AI for invoice detection (Google DPA, EU region), and (d) Anthropic Claude only if the user explicitly invokes the chat feature against an email attachment |
| No model training on Gmail data unrelated to user benefit | ✅ Gmail content is never used to train models. Vertex AI / Anthropic calls operate on the specific request only |
| Allow user deletion | ✅ Disconnect from `/settings/integrations` deletes tokens; account deletion removes all derived data; users can also revoke via Google's permissions page |
| Humans do not read user data except for security, legal, or with consent | ✅ Engineers do not access user mail; debugging is performed against synthetic test accounts only |

The same statement is also reproduced verbatim on the public Limited Use Disclosure section at https://fibuki.com/casa and https://fibuki.com/privacy.

## 6. Consent and revocation UX

- Consent screen: shown by Google at `/api/gmail/authorize` redirect.
- Granular permission: only `gmail.readonly` is requested as a restricted scope. Google's consent screen lets the user inspect and approve/deny the scope individually.
- Revocation in app: `/settings/integrations` → Disconnect.
- Revocation at Google: https://myaccount.google.com/permissions (user is reminded of this URL in the disconnect flow).
- Side-channel revocation handling: if the Gmail API returns `invalid_grant`, FiBuKI marks the integration as `status: "error"` and surfaces a reconnect prompt; encrypted tokens are deleted.

## 7. Tokens and key handling

| Property | Value |
| --- | --- |
| Encryption algorithm | AES-256-GCM |
| Key length | 256 bits (64 hex chars) |
| IV length | 128 bits, random per encryption |
| Auth tag length | 128 bits |
| Key storage | Firebase Secret Manager (`GMAIL_TOKEN_ENCRYPTION_KEY`) |
| Key rotation | Manual; rotation procedure documented internally |
| Token storage | `emailIntegrations/{id}` (refresh) — access tokens not persisted |
| Token transmission to client | **Never** |

## Evidence pointers

- `app/api/gmail/authorize/route.ts:GMAIL_SCOPES` — exact scope list
- `app/api/gmail/callback/route.ts` — code exchange + encryption + persistence
- `lib/crypto/encryption.ts` — AES-256-GCM implementation
- `firestore.rules` — `emailTokens` / `emailIntegrations` server-only access
- `https://fibuki.com/casa` — public mirror of this justification
