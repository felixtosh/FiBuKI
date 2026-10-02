# A Folder Integration reads one folder, never writes, and never deletes a connected File on its own

_Status: accepted (2026-10-02, Felix). Governs the Dropbox integration and the Google Drive
one that follows it._

A **Folder Integration** connects one folder in a cloud store (Dropbox, later Google Drive)
and keeps FiBuKI's Files in step with what is in it. The rules:

1. **One folder, recursive.** The user picks a single folder; its subfolders are included.
   The choice can be changed later, and changing it does not delete anything already
   imported.
2. **Read-only toward the provider.** FiBuKI never writes, moves, renames or deletes in the
   user's store. Scopes are the read-only ones only (`files.metadata.read` and
   `files.content.read` for Dropbox).
3. **The bytes are copied in.** An imported File is an ordinary File in FiBuKI storage with
   `sourceType` `dropbox` or `gdrive`, the integration id, the provider's file id and a
   link back. A File is never a live reference into the store, so extraction, matching,
   dedup, soft delete and Purge (ADR-0006) work on it unchanged.
4. **Only readable documents come in**: PDFs and images (and, for Drive, Google Docs
   exported as PDF). Anything else is skipped and counted, and the integration page shows
   the count.
5. **Dedup is by provider file id and by content hash.** A File already in FiBuKI, uploaded
   by hand or fetched from mail, is not imported a second time. A provider file whose id
   was imported before is never re-created, including after the File was deleted or purged
   (the kept dedup keys of ADR-0006 cover it).

## What happens when a file disappears from the folder

The sync notices a file that was deleted at the provider, or moved out of the chosen folder.
That File becomes **Gone at Source**. What FiBuKI does depends on whether the File is
documentation for a booking:

| File at FiBuKI | Default | With "also remove connected Files" on |
|---|---|---|
| Not connected to any Transaction | Deleted, the reversible delete of ADR-0006 | same |
| Connected to a Transaction | **Kept**, marked "no longer in Dropbox" | Deleted, still the reversible delete |

- **The default protects the booking.** A connected File is the Beleg behind a Transaction.
  Retention under BAO § 132 is the taxpayer's duty (ADR-0006), and someone tidying their
  Dropbox is not a decision to give up the documentation of years of bookings. An unconnected
  File documents nothing yet, so following the store costs nothing.
- **The toggle is opt-in, per integration, off by default**, worded as what it does: "Also
  delete Files that are connected to a Transaction when they are deleted in Dropbox". Turning
  it on shows the retention warning of ADR-0006.
- **Never a Purge.** Automatic removal is always the reversible delete. Only the deleted-files
  view destroys bytes, as before.
- **Not a FiBuKI-generated invoice document**, which cannot be deleted by anyone (ADR-0006).
  Those never come from a Folder Integration anyway.
- **A Gone File is un-gone by coming back.** If the provider file reappears (restored from
  the store's trash), the mark clears, and a File deleted for being Gone is restored, because
  the dedup key matches the same provider id.

## The circuit breaker

A folder that was renamed, unshared, disconnected or emptied looks, to a sync, exactly like
"everything was deleted". So automatic removal has a limit: if one sync run would remove more
than **10 Files, or more than 25 % of the Files the integration has imported**, whichever is
smaller but at least 3, the run **removes nothing**, marks the integration "paused: many Files
disappeared" and asks the owner to confirm. Marking Files Gone at Source (the "no longer in
Dropbox" note) is not removal and is not limited.

Authentication and permission errors, a missing folder and a reset cursor all abort the run
before any removal is considered. They are integration errors (`needsReauth`, `lastError`),
never "the files are gone".

## Considered options

- **Always follow the store, including connected Files.** Rejected: one accidental deletion in
  Dropbox silently removes the documentation behind bookings. The safe path costs a click; the
  unsafe one costs a tax audit.
- **Never delete, only mark.** Rejected: a user who removes a stray file in Dropbox expects
  FiBuKI's Files list to follow for the unconnected ones, and the Files list is the
  to-do list of the app.
- **Two-way sync (write back, move processed files).** Rejected for now: it needs write
  scopes, which are a heavier OAuth review for Drive and a bigger trust ask for the user, and
  it turns FiBuKI into a file manager, which it is not (docs/who-is-this-for.md).
- **Several folders per integration.** Deferred, not rejected: the model (integration owns a
  folder) allows a second integration on the same account, which covers the case without a
  list in v1.

## Consequences

- `File` gains Gone-at-Source state (`sourceGoneAt`, cleared when the file returns), on top of
  the `sourceIntegrationId`, `sourceExternalId` and `sourceExternalUrl` fields.
- A Folder Integration is its own register, beside the Mail Provider one: a provider says how
  to list changes since a cursor and how to download a file. The Sync worker and the removal
  policy are shared, so Drive adds a provider and no policy.
- Disconnecting, and deleting the account, revoke the grant at the provider before the token is deleted (Google `oauth2/revoke`, Dropbox `auth/token/revoke`). It is best effort: a provider that cannot be reached never blocks the disconnect, and the owner is told to remove FiBuKI in their provider account.
- The removal policy is a pure function (file state, integration settings, run size in; mark,
  delete or keep out), covered by tests before any provider exists.
