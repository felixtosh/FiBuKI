# 04 — Data Retention Policy

**Application:** FiBuKI
**Operator:** Infinity Vertigo GmbH
**Last updated:** 2026-06-21

This policy specifies how long FiBuKI retains each category of personal data, the trigger for deletion, and the technical procedure used to delete it.

## 1. Retention principles

1. **Minimisation.** We do not persist data we do not need. Email metadata and message bodies are processed in memory and discarded; only attachments the user chooses to keep are stored.
2. **User control.** Users can delete any data class at any time from in-app settings; deletion is enforced server-side and not just hidden.
3. **Legal basis aware.** Accounting documents may be subject to commercial-law retention obligations (e.g. Austrian §132 BAO: 7 years). FiBuKI surfaces this to the user but does not unilaterally retain past the user's explicit storage choice.
4. **Defence in depth.** Two-stage deletion (soft + hard) protects against accidental loss, with a bounded hard-delete window.

## 2. Retention table

| Data | Trigger | Soft-delete window | Hard-delete | Backups purged |
| --- | --- | --- | --- | --- |
| Gmail refresh token | User clicks Disconnect or account deletion | none | Immediate | n/a (not in PITR-only backups beyond 7 days) |
| Gmail access token | End of each Cloud Function invocation | none | Immediate (memory only) | n/a |
| Gmail message metadata in transit | Always | n/a | Not persisted | n/a |
| Gmail message body | Always | n/a | Not persisted (in-memory inspection only) | n/a |
| Downloaded attachment | User deletes file or account | 30 days | Storage + Firestore object purged | 7-day PITR rolls off |
| Bank transactions | User deletes source (bank account) | n/a (source-level delete) | Immediate | 7-day PITR rolls off |
| Bank statement files | User deletes source | 30 days | Storage + Firestore purged | 7-day PITR rolls off |
| Partner records | User deletes partner | n/a | Immediate | 7-day PITR rolls off |
| User account | User clicks Delete account | 30 days | All collections under the user's UID purged | 7-day PITR rolls off |
| Firebase Auth credentials | Account deletion | n/a | Immediate via Auth API | n/a |
| Function invocation logs | Time-based | n/a | 90 days | 7-day PITR rolls off |
| AI usage logs | Time-based | n/a | 90 days | 7-day PITR rolls off |
| Cloud Logging entries | Time-based | n/a | 30 days | n/a |
| Stripe billing records | Time-based | n/a | 10 years (tax) | Stripe-managed |
| SendGrid transactional email | Time-based | n/a | 30 days at SendGrid | SendGrid-managed |

## 3. Deletion procedures

### 3.1 Gmail disconnect

1. User clicks Disconnect in `/settings/integrations`.
2. The browser calls `DELETE /api/gmail/disconnect?integrationId=…` (`app/api/gmail/disconnect/route.ts`).
3. OAuth tokens (encrypted refresh token + IV) are deleted from `emailTokens/{id}` and the integration is marked disconnected in `emailIntegrations/{id}`.
4. Files that were downloaded from Gmail and never connected to a transaction are soft-deleted; files in use are retained so the user does not lose attached invoices.
5. Cloud Logging entries that referenced the integration roll off normally; tokens were never logged.

### 3.2 File deletion

1. User soft-deletes a file in the UI.
2. Firestore document `files/{id}` flagged `deletedAt: <timestamp>`.
3. Cloud Scheduler job runs daily and hard-deletes any file with `deletedAt < now - 30d`:
   - Cloud Storage object removed.
   - Firestore document removed.
4. References from `transactions/{id}.fileIds` are pruned by Firestore trigger.

### 3.3 Account deletion

1. User confirms deletion in `/settings/sign-in-security`.
2. `scheduleAccountDeletionCallable` (`functions/src/user/scheduleAccountDeletionCallable.ts`) flags the account `pendingDeletionAt: <now + 30d>`. The user can revoke during this window via `cancelAccountDeletionCallable`.
3. The scheduled `processPendingDeletions` job (`functions/src/user/processPendingDeletions.ts`) runs daily and, for each account whose `pendingDeletionAt` is in the past:
   - Calls `deleteUserAccountCallable` (`functions/src/user/deleteUserAccountCallable.ts`), which iterates every user-scoped collection (`transactions`, `partners`, `sources`, `files`, `emailIntegrations`, `emailTokens`, …) and deletes documents where `userId == uid`.
   - Deletes all Cloud Storage objects under `/users/{uid}/`.
   - Calls Firebase Auth `deleteUser(uid)`.
   - Emits the deletion-completed event.
4. Backups containing the user's data roll off within the standard 7-day PITR window.

### 3.4 Bank source deletion

Per [CLAUDE.md](../../CLAUDE.md) and accounting-integrity rules, individual transactions cannot be deleted. The user deletes the whole source (bank account), which cascades:

- `deleteTransactionsBySourceCallable` removes every `transactions` document for that source.
- The source document is removed.
- File connections to those transactions are removed; the underlying files remain in the user's library.

## 4. Backups

- **Firestore PITR:** 7-day rolling window, Google-managed, EU-resident.
- **Cloud Storage versioning:** disabled (no historical-version backups for user files; deletions are immediate).
- **Code backups:** GitHub remote.

Backups are encrypted at rest by Google KMS. Users whose accounts have been hard-deleted will roll off backups within 7 days.

## 5. Legal hold

FiBuKI does not currently maintain a manual legal-hold mechanism. If an Austrian tax authority or court served a preservation order, the operator would freeze the affected account's deletion scheduler entry and notify the data subject as permitted by law. No such order has been received as of the date above.

## 6. User-facing surfaces

- Privacy Policy: https://fibuki.com/privacy (sections "Data Protection" and "Rights")
- Settings UI:
  - `/settings/integrations` → Disconnect Gmail
  - Files: per-file delete button + bulk delete
  - `/settings/account` → Delete account

## Evidence pointers

- `app/api/gmail/disconnect/route.ts` — Gmail disconnect (revokes tokens, soft-deletes orphaned files)
- `functions/src/files/deleteFile.ts` — file soft/hard delete
- `functions/src/user/scheduleAccountDeletionCallable.ts` — initiate 30-day account deletion
- `functions/src/user/cancelAccountDeletionCallable.ts` — abort deletion during grace period
- `functions/src/user/processPendingDeletions.ts` — scheduled job that processes due deletions
- `functions/src/user/deleteUserAccountCallable.ts` — actual user-scoped purge
- `functions/src/transactions/deleteTransactionsBySource.ts` — bank-source cascade delete
- `firestore.rules` — proves the user-scoped delete operations are gated by ownership
