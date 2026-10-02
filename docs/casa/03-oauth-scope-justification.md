# 03 — OAuth Scope Justification

**Application:** FiBuKI
**Operator:** Infinity Vertigo GmbH
**Last updated:** 2026-10-02 (Google Drive added; DRAFT for review, see §8)

This document justifies each Google OAuth scope FiBuKI requests, demonstrates that no narrower scope is sufficient, and confirms compliance with the Google API Services User Data Policy (including the Limited Use requirements).

## 1. Requested scopes

| Scope | Sensitivity | Source file |
| --- | --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | Restricted | `app/api/gmail/authorize/route.ts` |
| `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive | `app/api/gmail/authorize/route.ts` |
| `https://www.googleapis.com/auth/userinfo.profile` | Non-sensitive | `app/api/gmail/authorize/route.ts` |
| `https://www.googleapis.com/auth/drive.readonly` | Restricted | `app/api/gdrive/authorize/route.ts` (see §8) |
| `https://www.googleapis.com/auth/userinfo.email` (Drive flow) | Non-sensitive | `app/api/gdrive/authorize/route.ts` |

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

## 8. `drive.readonly`: Google Drive Folder Integration (DRAFT)

_Status: drafted alongside ADR-0009. Not yet submitted for Google verification. Review the "narrower scope" claims in §8.2 against Google's current scope documentation before submitting._

### 8.1 User-visible feature it enables

The user connects Google Drive and chooses **one folder**. FiBuKI imports the receipts and invoices in it (PDF, images, and Google Docs, Sheets and Slides exported as PDF), checks it every 15 minutes for new, changed or removed documents, and matches the imported documents to bank transactions. Many users already collect invoices in a Drive folder (scanned paper, files shared by a bookkeeper, forwarded PDFs); without this, they download and re-upload every document by hand.

### 8.2 Why a narrower scope is insufficient

| Candidate | Why it does not work |
| --- | --- |
| `drive.file` | Covers only files the user opens or picks one by one with the Google Picker, or files the app created. It cannot enumerate a folder or see documents added later, which is the feature. (Verify before submission whether a folder picked in the Picker grants access to its children. Our understanding is that it does not.) |
| `drive.metadata.readonly` | Names and metadata only, no file content. The content is what FiBuKI needs. |
| `drive.appdata` | The app's own hidden folder. The user's documents are not in it. |
| Share a folder with a FiBuKI service account | Considered. Rejected: it needs a Google identity operated by FiBuKI that holds access to many users' folders, which is a larger blast radius than per-user tokens, and it is a harder setup for the user than a consent screen. |
| Have the user upload manually | The status quo. This integration exists to remove that step. |

`drive.readonly` is the narrowest scope that lists a folder and reads the files in it. FiBuKI makes no write, move, rename or delete call to Drive.

### 8.3 In-product minimisation

- **One folder.** Only the descendants of the chosen folder are listed and downloaded (`functions/src/folder-sync/gdrive/GoogleDriveProvider.ts`). The scope technically allows more; the code does not use it.
- **Only readable documents.** PDFs and images (and Docs, Sheets and Slides as PDF). Everything else is skipped and only counted. Files over 25 MB are skipped.
- **Folder picker.** While the user picks a folder, FiBuKI lists subfolder names one level at a time and returns them to that user only. They are not stored. Only the chosen folder's id and name are stored.
- **Tokens.** The refresh token is AES-256-GCM-encrypted before storage (`folderTokens/{id}`, server-only: the data policy denies clients). Access tokens are minted per sync run and live in memory only.
- **Isolation.** Every callable loads the integration by id and refuses one the caller does not own, with the same answer as for one that does not exist. The OAuth callback learns the user from a server-side state record, never from the browser.
- **Deletes.** Removing a document in Drive reversibly deletes FiBuKI's copy only if it is not connected to a transaction; a run that would remove many documents at once pauses for the owner's confirmation. See ADR-0009.

### 8.4 Limited Use compliance (Drive)

The table in §5 applies unchanged with "Drive files" for "Gmail data". Imported documents are processed like uploaded ones (text recognition and AI extraction via Vertex AI, Google DPA, EU region) and are not used to train models.

### 8.5 Revocation and known gaps

- In app: Settings > Integrations > Google Drive > Disconnect. This deletes the stored token and the sync state and marks the integration inactive. **Documents already imported are kept** (unlike Gmail disconnect, which soft-deletes unconnected files): they are the user's records, and the user deletes them in the Files list.
- At Google: https://myaccount.google.com/permissions.
- If Google returns `invalid_grant`, the integration is marked `needsReauth` and the page asks the user to reconnect.
- **Revocation at Google:** disconnect and account deletion call Google's revocation endpoint (`https://oauth2.googleapis.com/revoke`) with the refresh token before deleting it, which ends every access token minted from it (`functions/src/folder-sync/revoke.ts`). This is best effort: if Google cannot be reached the integration is still disconnected, the token is still deleted, and the user is told to remove FiBuKI under their Google account permissions. A token Google already invalidated counts as revoked. Covered by `functions/src/selfhost/security/folder-disconnect.test.ts`.

## Evidence pointers

- `app/api/gmail/authorize/route.ts:GMAIL_SCOPES` — exact scope list
- `app/api/gmail/callback/route.ts` — code exchange + encryption + persistence
- `lib/crypto/encryption.ts` — AES-256-GCM implementation
- `functions/src/selfhost/data-policy.ts` — `emailTokens` server-only access; `emailIntegrations` owner-only
- `app/api/gdrive/authorize/route.ts:GDRIVE_SCOPES`, `app/api/gdrive/callback/route.ts`: Drive scope list, code exchange, encryption
- `functions/src/folder-sync/`: folder-restricted listing, removal policy and circuit breaker
- `docs/adr/0009-folder-sync-is-read-only-and-never-destroys-a-connected-file.md`
- `https://fibuki.com/casa` — public mirror of this justification
