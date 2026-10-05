# An Invoice is locked once paid, and free until then

_Status: accepted (2026-10-05, Stefan), settled in the #577 grilling on Felix's
Freefinance comparison. Rule 3's reuse of a sent number awaits the § 11 check in the
research ticket the spec names._

FiBuKI is pre-accounting. Felix's point: Austrian tools let you simply change an invoice,
FiBuKI's UX must be at least as good, and Revisionssicherheit is something FiBuKI informs
about, not a wall it enforces. Freefinance draws the line at the payment: an invoice is
yours to change until it is mapped to a Transaction.

The rules:

1. **Paid is the line.** An Invoice is paid exactly when its File is connected to a
   Transaction; unlinking that payment makes it unpaid again.
   - **Unpaid** (issued, sent or shared): the User may edit it or take it back to a draft,
     whatever its position in the sequence. Editing a sent Invoice regenerates its PDF in
     place; no earlier version is kept.
   - **Paid**: locked. To change it, the User unlinks the payment first, or issues an
     **Invoice Correction**.
2. **Taking back (undo-issue) asks only "never paid".** The conditions "never sent",
   "share link never opened", "highest issued number" and "issued this year" are dropped.
3. **The number.**
   - A taken-back draft keeps its number, and issuing it again reuses that number.
   - When the draft is deleted, its number goes to the next Invoice only if no newer
     Invoice was issued in the meantime; otherwise it stays a gap.
   - This holds even when the deleted Invoice had been sent (Stefan's ruling).
   - One number is never held by two Invoices at once (#578 stands).
4. **FiBuKI says it once, at the moment.** One line in the confirm dialog, never a block
   and never an extra click, when the User:
   - edits or takes back a sent Invoice ("your customer still holds the old version");
   - deletes a draft whose number then becomes a gap or is given out again;
   - takes back an Invoice dated in a UVA period marked filed.
5. **"Sent" no longer gates anything.** It stays a fact FiBuKI shows and warns on.

## Why paid, and not sent

"Sent" was the obvious line: after the document leaves the building, a change should leave
a trace. It fails the User: an invoice sent with a typo, or sent to the wrong address, is
exactly when the User wants to fix it, and the customer usually wants the fixed one. The
payment is different. Once money has moved against an invoice, the invoice is part of the
books: the UVA has claimed or owed from it, and the BMD Export has booked it. That is where
an edit stops being a correction of a draft and starts rewriting a record.

This is **stricter than the code was** in one place. A paid Invoice could be edited in
place, number included, and its PDF silently overwritten. It is **looser** in the rest:
undo-issue refused almost everything after the first send.

## Considered options

- **Paid only blocks taking back; edits stay free.** Rejected: the paid document could
  still change silently under a booked line.
- **Paid locks, and an edit after sending keeps the earlier PDF.** Rejected for now as
  friction without a buyer. Revisit if a Tax Advisor asks for it.
- **A released number always stays a gap.** Rejected: a misclick on the newest Invoice
  should not leave a hole.
- **"Not if it was sent" for number reuse.** Rejected by Stefan; see the status line.
- **Keep the same-year limit.** Rejected: the filed-period warning covers the real risk.
- **Silent, or only in the handover.** Rejected: the moment of the act is when the User
  can still choose otherwise.

## Consequences

- `updateInvoice` and `regenerateInvoicePdf` refuse a paid Invoice, naming the unlink.
- `undoIssueInvoice` checks only "never paid", and the draft keeps its `numberSeq` as it
  already does. ADR-0006's one exception, undo-issue destroying the generated document,
  now reaches sent and shared Invoices too.
- Deleting a draft frees its number only while it is the newest issued. Drafts hold no
  number for `assertInvoiceNumberFree`, and `nextInvoiceNumberSeq` draws after the
  highest `numberSeq` any of the year's invoices holds, drafts included. So this is what
  the allocator already does.
- The confirm dialogs gain the one-line notes, in both languages.
- The glossary's Invoice entry no longer says "immutable once issued".
