# A Cash Payment is the User's own entry, so the User may correct and delete it

_Status: proposed (2026-11-17), from the #786 spec. Review before the #790 code merges:
the spec names this exception its riskiest decision._

An imported Transaction cannot be deleted on its own, and its date, amount and name
change only through an import. The reason is agreement: every imported row stands for a
line on a bank statement, and a book that drops or rewrites one of those lines no longer
agrees with the statement it came from.

A Cash Payment has no statement. The User typed it, one payment at a time, from a paper
receipt or from memory. A typo in it is the User's typo, and a duplicate entry is the
User's duplicate. Locking it protects nothing and leaves the User with a wrong row
counting in the UVA and the BMD export.

The rules:

1. **A Cash Payment may be corrected.** Its day, its amount and direction (the sign), its
   name and its description. Its Partner, Files and No-document Category change as on
   any Transaction.
2. **A Cash Payment may be deleted.** Its File Connections are taken apart first, each
   File keeps a line in its activity log, and the Files stay: they go back to
   unmatched. Then the row goes.
3. **Only a Cash Payment.** The exception covers Transactions the User added by hand on
   a Cash Box. A row imported into a Cash Box from a CSV has a list behind it and stays
   as locked as every other import. Every other Transaction keeps the old rule: no
   single delete, and no edit of its bank figures.
4. **Never inside a filed UVA period.** When the row's day falls in a month or quarter
   the User has a filed UVA record for, correcting or deleting it is refused, and so is
   moving a row into such a period. The refusal names the period. A filed return must
   keep agreeing with the books; the way forward is a corrected UVA for that period,
   which is a filing, not an edit.
5. **Every correction is in the activity log**, before and after, by whom.
6. **Deleting stays a UI action.** No MCP or REST tool deletes a Cash Payment; a
   destructive single-row delete is the User's own click.

## Why not widen the existing Transaction edits

The existing Transaction updates refuse date, amount and name on every row (#621).
Teaching them "unless it is a Cash Payment" puts the exception into every path that
updates a Transaction, where one forgotten check lets it reach an imported row. The
correct and delete operations instead live beside the one writer that creates a Cash
Payment, so the exception is in one place and the general update paths stay as strict
as before.

## Considered options

- **Keep Cash Payments locked like imports; fix a typo by adding a counter-entry.**
  Rejected: a cash box has no bank to reconcile against, so a counter-entry is noise
  that doubles the rows the User and the Tax Advisor have to read.
- **Allow it everywhere on a Cash Box, CSV rows included.** Rejected: a CSV import has a
  source list it must keep agreeing with, like a bank statement.
- **Allow it in a filed period with a warning.** Rejected: unlike an Invoice's text
  (ADR-0015), a Cash Payment's amount is a figure the filed return was summed from, so a
  silent change makes the return wrong. The refusal says what to do instead.
- **Soft delete, with a restore.** Not now: a hand-typed row is cheap to type again,
  and the activity on its Files records that it existed.
