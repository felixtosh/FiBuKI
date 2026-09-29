# Deleting a File is reversible; only a Purge destroys

_Status: accepted. The reversible default landed with #258, so deleting from the UI now
hides a File whatever its source. The Purge and the deleted-files view that reaches it
landed with #268; the retention decision below (2026-09-27) settles #296 and extends
this record._

Deleting a File hides it and can be undone. The stored document is destroyed only by a
**Purge**, which is reachable from the deleted-files view and from nowhere else — not from
the normal Files list, and not from the MCP surface at all, whose `delete_file` has no
parameter that could reach it.

Two reasons. A Beleg is a retention-relevant record under Austrian rules, so an
irreversible default on the surface people click fastest is the wrong default; and for a
File that arrived by Sync the deleted record is load-bearing, because the deduplication
that stops the next run re-creating it matches on the record that a destroy would remove.

## Retention: a warning, not a refusal (2026-09-27, settles #296)

Purge is allowed for every File except a FiBuKI-generated invoice document, and the
retention question is answered with a warning instead of a refusal. Retention under
BAO § 132 (7 years) is the taxpayer's duty, not the software vendor's: FiBuKI informs,
it does not gatekeep.

The whole rule:

- **Purge is reachable from the deleted-files view only**, owner-only, with a
  confirmation naming the count. No other surface has it — not the normal Files list,
  not the MCP/tool surface, not the detail panel.
- **The confirmation carries an explicit retention warning** when a selected File was
  ever attached to a Transaction, or is classified invoice/receipt and dated within
  7 years: "you are legally required to keep this for 7 years (BAO § 132); purge
  anyway?" The user may proceed.
- **Junk purges without ceremony**: a File never attached and classified `other` or
  `unknown` gets the count-naming confirmation and nothing more.
- **There is no automatic sweep.** Soft-deleted Files are kept indefinitely until the
  owner purges them. The CASA data-retention policy used to describe a daily 30-day
  hard-delete scheduler that was never built (#296); the policy text is corrected to
  describe this reality rather than the job being built, because an automatic destroyer
  of retention-relevant records is the wrong default for exactly the reason the warning
  exists.
- The delete stamps `hadTransactionConnections` on a File that was attached when it was
  deleted, because deleting clears the attachment fields the warning would otherwise be
  computed from.

## Considered options

- **Keep hard delete as the UI default and merely clean up the stored bytes.** Rejected:
  it leaves one product answering "what does deleting a Beleg mean" two different ways
  depending on which surface asked, and the MCP answer is already soft.
- **Refuse Purge for Sync-sourced Files.** Rejected: it makes the bulk case — clearing out
  fifty misfiled attachments that were never documents — unusable on exactly the corpus it
  exists for.

## Consequences

- A Purge keeps a minimal record: the File's ID, its message and attachment IDs, and its
  content hash. Nothing of the document's content and none of its bytes survive. Without
  those keys the next Sync re-imports what was just purged, and the user learns that
  purging junk makes junk.
- FiBuKI-generated invoice documents cannot be deleted at all — not by an agent, not by a
  user in the UI, and not by a Purge. Deleting the PDF under an issued invoice is not a
  cheaper cancellation; cancelling one is its own accounting act with its own writer, and
  the UI is where someone is most likely to reach for the wrong one of the two.
- Hard delete stops being a thing the word "delete" can mean anywhere in the UI copy, the
  API or the tool descriptions. The glossary lists it under _Avoid_.
