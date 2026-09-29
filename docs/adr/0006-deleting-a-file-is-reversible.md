# Deleting a File is reversible; only a Purge destroys

_Status: accepted. The reversible default landed with #258, so deleting from the UI now
hides a File whatever its source. The Purge itself, and the deleted-files view that reaches
it, are #268._

Deleting a File hides it and can be undone. The stored document is destroyed only by a
**Purge**, which is reachable from the deleted-files view and from nowhere else — not from
the normal Files list, and not from the MCP surface at all, whose `delete_file` has no
parameter that could reach it.

Two reasons. A Beleg is a retention-relevant record under Austrian rules, so an
irreversible default on the surface people click fastest is the wrong default; and for a
File that arrived by Sync the deleted record is load-bearing, because the deduplication
that stops the next run re-creating it matches on the record that a destroy would remove.

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

## Exception: un-issuing a misclicked invoice (#272)

One path destroys a generated invoice document, and it is not a delete: **undo issue**
(`undoIssueInvoice`, MCP `undo_issue_invoice`) returns an invoice to an editable draft and
destroys the PDF the issue produced. It is allowed only while nobody outside can hold a
copy and taking the number back leaves the § 11 UStG sequence gapless:

- the invoice is `issued`, never sent and never paid (its document is connected to no
  Transaction);
- no share link of it was ever opened, revoked links included;
- it was issued in the current year;
- no invoice with a higher number was issued in that year. Drafts do not count, since they
  hold no frozen number.

The draft keeps its number, so issuing it again gives the same one. Every other case is a
Storno through `cancel_invoice`. Decided by Felix on 2026-09-28.
