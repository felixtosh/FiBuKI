# A Remainder Match auto-connects only on same-day evidence

_Status: accepted. Landed with #242, on top of the Remainder scoring #239 introduced._

A **Remainder Match** — a Match whose amount was judged against what a Transaction still has
open, rather than against its full amount — may connect itself only when all four hold:

1. The candidate File's **extracted date** equals the extracted date of **every** File already
   connected to that Transaction. Not the Transaction's booking date.
2. The candidate's amount closes the Remainder to within `REMAINDER_CLOSE_TOLERANCE`.
3. The Confidence clears `AUTO_MATCH_THRESHOLD`, as for any auto-connect.
4. No Transaction in the same scoring run that holds **no** Files scores at or above it.

Fail any one and the Match stays a suggestion, which is what #239 made every Remainder Match.
Coverage's existing block is untouched: past `COVERAGE_RATIO` nothing connects itself at all.

Two facts shape the rule. The same-day split is the case an Austrian EPU meets constantly —
one card payment, two Belege from one afternoon — and clicking it through by hand is exactly
the work FiBuKI removes. And auto-connect onto a partly documented Transaction is not new:
below `COVERAGE_RATIO` it has always been permitted, and it merely stayed dormant while the
score compared against the full amount. #239 woke that path; this is the tightening.

## Why the day, and whose day

The **candidate's date against the connected Files' dates**, because those are the two
documents claiming to explain one payment, and a document states its own day. The bank's day
is the wrong reference: a card payment books one to three days after the receipt is printed,
so requiring it would refuse the honest cases while letting nothing safer through.

**Unknown is not same-day.** A File with no extracted date never qualifies, and neither does
one whose Transaction holds a dateless File. The rule is "these documents are from one day",
and a missing date cannot say that.

The day is read in UTC, which is where the Extraction puts a printed day — midnight of that
day, with no time to lose. Reading it back in the host's zone would make the same pair
same-day or not depending on where the container runs.

**Partners need not agree.** A Sammelbuchung legitimately mixes them, and the
fee-document-beside-the-supplier's-invoice pair is one of the two cases #162 exists for.

## Why the guard

Same day makes the dangerous case *more* likely, not less: two receipts from one shop on one
day, and two card Transactions from that day. Scoring is per-File and greedy, so receipt B can
land on Transaction A's Remainder while B's own Transaction sits empty beside it — an error
nobody is looking for, on a line that already looks documented.

So before a Remainder Match connects itself, it is compared against the same run's other
candidates: if any Transaction holding no Files scores at or above it, the auto-connect is
skipped. Ties go to the empty Transaction — between a line that explains nothing yet and one
already half explained, the unexplained line is the safer home. Every candidate was scored in
that run already, so this costs an in-memory comparison, not another query.

## Considered options

- **Leave every Remainder Match a suggestion (#239's state).** Rejected: it makes the split
  bank line permanently hand-worked, which is the case the Remainder scoring was built for.
- **A date window (± n days) instead of the day.** Rejected: a window is a dial with no honest
  setting. Two Belege from one payment carry one day; anything wider starts guessing, and the
  guess is unreviewable once it has written a Connection.
- **Require the same Partner across the Files on a Transaction.** Rejected: a Sammelbuchung
  mixes Partners by definition, and the fee-plus-invoice pair would fail it.
- **Pick the best home globally instead of per File.** Rejected here, not wrong: matching runs
  per File on extraction, and a global assignment is a different machine. The guard gets the
  same answer for the case that matters at the cost of one comparison.

## Consequences

- A Connection created this way stores `autoConnectReason: "remainder_same_day"`, alongside the
  `scoredAgainstRemainder` figure #239 already puts in the breakdown. When a wrong one appears
  — and it will be re-litigated the first hour one does — they are findable as a class, and a
  full-amount auto-connect is not caught in the same net.
- The Files already on a candidate are now loaded with their extracted dates, not just their
  total. Same read, one more field.
- A dateless File is strictly worse off than before in this one respect, which is a reason to
  care about extraction quality, not a reason to soften the rule.
