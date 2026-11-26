# Fiscal Years: tracked, closed and open stretches

_Status: proposed (2026-11-25), from the #800 spec and the #794 decision._

A User arrives with years of bank history nobody wants to work on, or moves from another
tool with years whose tax returns are filed. Both want those years in FiBuKI, out of the
way of today's work, and the filed ones safe from change.

## The rule

Each User has three settings, each with the month as its unit:

- a **fiscal year start month**, January by default;
- **Tracked From**, the first month FiBuKI holds data for;
- **Closed Through**, the last closed month, or none.

They split time into three stretches, always in this order, with no gaps:

1. **Untracked**, before Tracked From.
2. **Closed**, from Tracked From through Closed Through.
3. **Open**, after that.

One check answers "which stretch is this date in, for this User". Every guard and every
skip calls it.

## The order

Tracked From is on or before the month after Closed Through. A change that would put a
gap between closed and open time, or a closed stretch inside untracked time, is refused,
and so the order untracked, closed, open holds by construction: there is no way to write
an open stretch before a closed one.

Moving Tracked From later is refused when the months it would leave behind hold
Transactions or Files. FiBuKI never hides what it stores; months that should be out of the
way are closed instead.

Neither month may lie after the current one: nothing is tracked or closed ahead of time.

The default is stored on the User's first read, with an `initial` change record, so it does
not move when a new year begins. Any read stores it: the settings screen, `get_fiscal_years`,
and every guard or Import that checks a date against the settings. So a User who never opens
the settings still has a stored default, and its `initial` record, from the first write that
consulted them. It is the first month of the current Fiscal Year, or the
first month of the Fiscal Year holding the User's earliest Transaction or dated File when
that is earlier. A new User tracks only the current year; a User who had data before Fiscal
Years existed finds none of it untracked. A File in the bin does not count, and neither
does a File without a date: its date is known only after the Extraction, so an undated
File never sets the default or holds a month against moving Tracked From.

## The lock

A Transaction dated in the Closed stretch cannot be edited or deleted. The refusal names
Closed Through and how to lift it. It sits at every writer a User or a client reaches: the
Transaction edit whitelist (both update callables and the tool surface's update, which a
rollback goes through), the Partner, No-document Category and ruling writers, Booking
Accounts, a suggestion's rejection, deleting or remapping an Import, the delete of a Bank
Account's contents, a bank disconnect, a re-sync that would replace them, and a Cash
Payment's correction and delete. The orphan cleanups keep a closed orphan. The browser
writes no Transaction at all, so the data plane refuses every write to one.

Inserts are not refused. A User moving from another tool imports old years into the
Closed stretch with the normal tools.

Locking Files and File Connections, keeping the Closed stretch out of the work lists and
the digest, and keeping automation off it are their own tickets; they call the same check.

## The lift

There is no reopen mode. To correct a record in the Closed stretch, the User moves Closed
Through back, makes the change, and moves it forward again. Every change of any of the
three settings writes one append-only record: who, when, the old values and the new ones,
and whether the settings page, an MCP client or the chat made it. The record is never
changed, like a UVA Filed Record.

## The skip

The Import writer skips Transactions dated before Tracked From and returns how many it
skipped per Fiscal Year: the CSV Import, `import_transactions` and the bank syncs. A sync
never stops to ask; no Import moves a setting. Files are never skipped, because their date
is known only after the Extraction.

A CSV file that starts before Tracked From still states its opening balance at its first
row. The stored opening carries that balance past the skipped rows: it is the file's opening
plus their amounts, dated at Tracked From, so the balance at any later date adds only rows
FiBuKI holds.

## Asking first

Only the User brings history in. After the columns of a CSV Import are matched, and before
anything is written, the preview counts the rows before Tracked From per Fiscal Year and asks:
track them as closed, track them as open, or skip them. Tracking moves Tracked From back to
the start of the earliest such Fiscal Year. As closed, while nothing is closed yet, Closed
Through moves to the month before the old Tracked From too, so every month that was untracked
is closed rather than left open in between. As open is offered only while nothing is closed,
because an open stretch never lies before a closed one. Skip changes nothing, and the result
counts what was left out. The chosen change goes through the one settings writer and leaves
its change record; the Import itself is unchanged.

First setup asks the same question as a choice of Fiscal Years, each untracked, closed or open,
the current one open. Its picks always keep the order, and it saves only when the User changed
them, so a User whose stored default already reaches back keeps it.

A File dated before Tracked From is kept and left out of the work lists, and named once in one
hint ("3 documents from 2021, a year you don't track"). Dismissing the hint stores what it
showed; it comes back only for documents that arrive later.

## Considered options

- **One Closing Date per User.** The first decision on #794. Replaced because it said
  nothing about the history a new User does not want, which Tracked From covers with the
  same check.
- **Closed ranges, a fiscal year at a time.** Rejected: ranges allow an open year between
  closed ones, and every guard would have to reason about a list.
- **Close a period when its UVA is marked filed.** Rejected: the UVA is filed monthly or
  quarterly, long before the year's return. Marking a UVA filed changes no setting.
- **Refuse every write in a closed year.** Rejected: old years must be importable after
  closing, so inserts stay open.
