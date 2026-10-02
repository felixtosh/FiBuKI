# 04 — Data Retention Policy

**Application:** FiBuKI
**Operator:** Infinity Vertigo GmbH
**Last updated:** 2026-09-27

This policy specifies how long FiBuKI retains each category of personal data, the trigger for deletion, and the technical procedure used to delete it.

## 1. Retention principles

1. **Minimisation.** We do not persist data we do not need. Email metadata and message bodies are processed in memory and discarded; only attachments the user chooses to keep are stored.
2. **User control.** Users can delete any data class at any time from in-app settings; deletion is enforced server-side and not just hidden.
3. **Legal basis aware.** Accounting documents may be subject to commercial-law retention obligations (e.g. Austrian §132 BAO: 7 years). FiBuKI surfaces this to the user but does not unilaterally retain past the user's explicit storage choice.
4. **Defence in depth.** Two-stage deletion protects against accidental loss: deleting a file hides it reversibly, and destruction happens only through an explicit, owner-initiated Purge (no automatic hard-delete window).

## 2. Retention table

| Data | Trigger | Soft-delete window | Hard-delete | Backups purged |
| --- | --- | --- | --- | --- |
| Gmail refresh token | User clicks Disconnect or account deletion | none | Immediate | n/a (not in PITR-only backups beyond 7 days) |
| Gmail access token | End of each Cloud Function invocation | none | Immediate (memory only) | n/a |
| Gmail message metadata in transit | Always | n/a | Not persisted | n/a |
| Gmail message body | Always | n/a | Not persisted (in-memory inspection only) | n/a |
| Drive / Dropbox refresh token | User clicks Disconnect or account deletion | none | Immediate (`folderTokens/{id}`) | n/a |
| Drive / Dropbox access token | End of each sync run | none | Immediate (memory only) | n/a |
| Folder sync state (`folderEntries`) | Disconnect, folder change or account deletion | none | Immediate | n/a |
| Document imported from Drive / Dropbox | Same as any File: user deletes (reversible) or purges; disconnecting does **not** delete it | Indefinite until user Purge or account deletion | On Purge | as for any File |
| Downloaded attachment | User deletes file (reversible), or purges it from the deleted-files view | Indefinite until user Purge or account deletion | On Purge: storage object destroyed, Firestore record reduced to dedup keys | 7-day PITR rolls off |
| Bank transactions | User deletes source (bank account) | n/a (source-level delete) | Immediate | 7-day PITR rolls off |
| Bank statement files | User deletes file (files survive source deletion), or purges it | Indefinite until user Purge or account deletion | On Purge: storage object destroyed, Firestore record reduced to dedup keys | 7-day PITR rolls off |
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

### 3.1a Folder Integration disconnect (Drive, Dropbox)

1. User clicks Disconnect on the integration page; `disconnectFolderIntegration` (callable, owner-only) runs.
2. The encrypted refresh token and sync cursor (`folderTokens/{id}`) and the per-file sync state (`folderEntries`) are deleted; the integration is marked inactive.
3. Imported Files are **kept**. Gone-at-source handling stops with the sync. A deleted-at-source File is only ever deleted reversibly, never purged, and a connected File is kept unless the owner turned on "also delete connected Files" (ADR-0009).
4. Known gap: the grant is not revoked at the provider; the user can revoke it in their Google or Dropbox account.

### 3.2 File deletion and Purge

1. User deletes a file in the UI (or via the tool surface). The Firestore document
   `files/{id}` is flagged `deletedAt: <timestamp>`; the file is hidden, its
   connections to transactions are removed (`transactions/{id}.fileIds` pruned in the
   same operation), and the stored bytes are untouched. The delete is reversible via
   restore.
2. Deleted files are retained **indefinitely**. There is no scheduled hard-delete.
   (An earlier revision of this policy described a daily Cloud Scheduler job
   hard-deleting files 30 days after `deletedAt`. No such job was ever built, and the
   decision on issue #296 (2026-09-27) is that none will be: accounting documents are
   retention-relevant under § 132 BAO, and an automatic destroyer of such records is
   the wrong default. The policy is corrected to describe the implemented control.)
3. Destruction is the explicit, owner-initiated **Purge** (`purgeFiles` callable),
   reachable only from the deleted-files view in the UI and from no API/tool surface:
   - The Cloud Storage object is deleted and its absence verified.
   - The Firestore document is reduced to deduplication keys (content hash, source
     message/attachment IDs) so a purged file is not re-imported by a later sync;
     all content-bearing fields are removed.
   - Files that were attached to a transaction, or are classified invoice/receipt and
     dated within 7 years, get an explicit § 132 BAO retention warning in the
     confirmation; the user may proceed (retention is the taxpayer's duty, the
     software informs rather than gatekeeps).
   - Documents generated by FiBuKI for issued invoices are refused (see ADR-0006).
4. See `docs/adr/0006-deleting-a-file-is-reversible.md` for the full decision record.

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
- `functions/src/files/deleteFile.ts` — file delete: hides the file, leaves the stored object in place
- `functions/src/files/purgeFiles.ts` — owner-initiated Purge: destroys the stored object (verified) and reduces the record to dedup keys
- `functions/src/user/scheduleAccountDeletionCallable.ts` — initiate 30-day account deletion
- `functions/src/user/cancelAccountDeletionCallable.ts` — abort deletion during grace period
- `functions/src/user/processPendingDeletions.ts` — scheduled job that processes due deletions
- `functions/src/user/deleteUserAccountCallable.ts` — actual user-scoped purge
- `functions/src/transactions/deleteTransactionsBySource.ts` — bank-source cascade delete
- `functions/src/selfhost/data-policy.ts` and `functions/src/selfhost/security/` — user-scoped deletes are gated by ownership, and the attack suite proves it
