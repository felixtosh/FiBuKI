# An instalment auto-connects only on printed evidence

_Status: accepted (2026-10-05, Stefan), settled in the #615 grilling. The File-side mirror
of [ADR-0008](0008-remainder-auto-connect-is-same-day-only.md)._

One File is sometimes paid by several Transactions: instalments, a deposit and a final
payment, a charge the bank splits in two. Each payment used to be scored against the
File's full total, so it read as an amount mismatch and was never suggested with
confidence. The **Remainder** already solved the other direction (several Files for one
Transaction); this is its mirror.

The rules:

1. **A File has an Outstanding amount.** The File's total minus what its connected
   Transactions pay. It exists once a File has at least one payment connected and is not
   yet fully paid. Before that there is nothing Outstanding.
2. **A further payment is scored against the Outstanding amount**, never against the full
   total. A payment that closes it is a Match, not an amount mismatch. The scoring lives in
   the one matcher (#613), so every surface gets it.
3. **Two signals say a payment is an instalment, and only these two:**
   - **the File prints it**: a deposit, an instalment or a payment schedule (Anzahlung,
     Teilzahlung, Rate n/m, due dates with amounts), read by the Extraction;
   - **the bank line cites it**: its reference or Payment Code carries the File's invoice
     number.

   They are what let the *first* payment be proposed at all, when nothing is Outstanding
   yet.
4. **An instalment connects itself only when all of these hold:**
   - its amount equals an instalment the File prints, or exactly closes the Outstanding
     amount;
   - the Partner agrees;
   - the Confidence clears `AUTO_MATCH_THRESHOLD`;
   - no Transaction in the same scoring run that holds **no** Files scores at or above it
     (ADR-0008's guard).

   Fail any one and the Match stays a suggestion.

## Why printed evidence

For the same reason ADR-0008 settled on the day: auto-connect writes a File Connection
nobody reviews, so it may act only on what the documents themselves state. An invoice that
prints "Rate 2/3: EUR 400 due 1 March" states the instalment. A EUR 400 payment against a
EUR 1 200 invoice from the same Partner states nothing: it may be an instalment, a
different invoice, or a wrong amount.

A bank line that cites the invoice number is strong evidence of *which* document is paid,
so it may raise a payment to a suggestion. It says nothing about whether the amount is
right, which is why rule 4 still asks for a printed instalment or an exact close.

## The UVA is already right

The UVA claims a partly paid document's Vorsteuer in proportion to the payment, with the
claimed fraction capped so a File's instalments never claim more than the whole (R2 in
`calculateUva.ts`). #571 removed the case where a Receipt beside its invoice read as a
50 % instalment. Nothing in this ADR changes the UVA.

## Considered options

- **Suggestion only, never automatic.** Rejected: an invoice that prints its own schedule
  is as strong as evidence gets, and clicking each instalment through is the work FiBuKI
  removes.
- **Like any Match: auto above the threshold.** Rejected: the score alone cannot tell an
  instalment from a wrong amount.
- **The Partner's billing pattern as a signal** (this Partner was paid in instalments
  before). Rejected: it is learned, not printed, and a learned guess must not write an
  unreviewed Connection.
- **Scorer input only, no domain word.** Rejected: the detail panel needs to say
  "EUR 400 of 1 200 outstanding", and a figure the User sees needs a name.

## Consequences

- The Extraction gains a field for printed instalments or a schedule.
- The matcher's scoring inputs gain the File's Outstanding amount, read through the same
  connected-payments summary Coverage uses, so the Receipt Link's "a pair counts once"
  holds here too.
- Auto-connects made under rule 4 carry their own reason, `instalment`, beside
  `remainder_same_day` and `paired`, so they are findable as a class, whichever surface
  makes them (the upload trigger, Partner matching, find-receipt).
- A middle instalment is no mismatch against what is left. Once a payment is connected,
  the paid instalments are the earliest printed rows whose amounts add up to what is paid
  (within 1 EUR); the others are unpaid. A further payment is judged against the
  Outstanding amount or the nearest unpaid printed instalment, whichever fits better, and
  rule 4's "equals a printed instalment" means the one it was judged against. When no rows
  add up to what is paid, no printed row is known to be unpaid, and only the Outstanding
  amount counts.
- A later instalment is paid months after the invoice, on the day the schedule names. So a
  payment judged as a printed instalment, or closing the Outstanding amount of a File that
  prints instalments, has its date scored against that instalment's printed due date, and
  the File is matched within the usual window around each printed due date too. A File
  printing no instalments keeps its own dates and window. A printed due date more than a
  month before the File's date, or more than a year after it, is taken for a misread and
  counts for neither.
- Equal instalments that qualify in one run are no rivals when each is dated against a
  different printed due date: each connects, as long as together with what is paid they
  do not exceed the File's total (else none does). Only payments dated against the same
  due date fall under the tie rule: the nearest wins, an exact tie connects nothing. Every
  surface that auto-connects (the upload trigger, Partner matching, find-receipt) applies
  the same judgement.
- The File detail panel shows the Outstanding amount, and an overpayment beside "paid in
  full": Outstanding never goes below zero, but what the payments came to beyond the File
  stays visible.
