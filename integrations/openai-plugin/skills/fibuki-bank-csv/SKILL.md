---
name: fibuki-bank-csv
description: Import a bank CSV export (George/Erste, Raiffeisen, Bank Austria, BAWAG, N26, Revolut, Wise and others) into a FiBuKI Bank Account. Use when the user has a bank export file, says "import my bank CSV", "Kontoauszug importieren", or needs Transactions in FiBuKI before matching invoices.
metadata:
  short-description: Import a bank CSV into FiBuKI
---

# Import a bank CSV

Goal: the bank lines of one Bank Account arrive in FiBuKI once, with the right dates and amounts. The parsing is FiBuKI's own import code, packaged as a script, so **you never convert an amount or a date yourself**. A wrong decimal separator turns 89,99 into 8.999,00 and no one notices until the books are off.

Answer in the user's language. Amounts are integer cents; negative is an expense.

## Needs a shell

The steps below run `node "${PLUGIN_ROOT}/scripts/fibuki-csv.mjs"` (Node 18+). If this assistant has no shell (plain ChatGPT chat), do not convert the rows by hand: send the user to the web import at https://fibuki.com/sources (Bank Account, then Import), and offer to continue with `fibuki-belege` afterwards.

## 1. Look at the file

```
node "${PLUGIN_ROOT}/scripts/fibuki-csv.mjs" analyze <file.csv>
```

It prints the encoding (Windows-1252 is common for Austrian banks), delimiter, row count, and per column: a few sample values and, when it can tell, the date format or amount format. If the headers look like nonsense, the file has lines above the table (account holder, period): count them and add `--skip N` to every command. Read `references/austrian-bank-csvs.md` for the layouts to expect.

Choose the columns from the headers and samples:

- date: the booking date (Buchungsdatum), not the value date (Valuta), when both exist
- amount: one signed column, **or** separate debit (Soll) and credit (Haben) columns
- name: the booking text (Buchungstext); partner: the counterparty name; iban: the counterparty IBAN; reference: the payment reference
- balance: a running balance column (Saldo), if there is one. It is never the amount, but it is the best proof that the amounts are right (step 4)

If two columns could be the date or the amount and the samples do not settle it, ask the user which one. Do not guess.

## 2. Pick the Bank Account

`list_sources`. Ask which account the file belongs to; never assume. If none fits, ask for a name (and IBAN if they have it) and `create_source` (`accountKind`: `bank_account` or `credit_card`). A credit card export goes into a credit card account, not the current account.

## 3. Overlap with what is already there

FiBuKI decides what is a duplicate, on the server: it skips lines an earlier import already stored for the same Bank Account (same date, amount and reference) and reports how many. Re-sending an overlapping export is safe, so **do not filter rows yourself and do not compare against existing Transactions**.

- Use `--after YYYY-MM-DD` / `--before YYYY-MM-DD` only when the user wants just a period (for example one month of a longer export). `--before` includes that day.
- Identical lines inside one file (two coffees, same day, no reference) are all kept; only lines from an *earlier* import count as duplicates.
- Lines imported through the API before this check existed carry an older hash and are not recognised. If the user says they already sent the same period that way, import only the new period.

## 4. Dry run, show, confirm

```
node "${PLUGIN_ROOT}/scripts/fibuki-csv.mjs" convert <file.csv> \
  --date <col> --amount <col> --name <col> [--partner <col>] [--iban <col>] [--reference <col>] \
  [--balance <col>] \
  [--after YYYY-MM-DD] [--out ./fibuki-import]
```

For debit and credit columns use `--debit <col> --credit <col>` instead of `--amount`. A fixed currency other than EUR: `--currency CHF`, or `--currency-col <col>`.

Pass `--balance <col>` whenever the file has a running balance. The script then checks **every row**: each balance must equal its neighbour's balance plus its own amount (oldest-first or newest-first, it works out which). It prints `balanceCheck` (rows checked and matched) and, when the amounts do not add up, a `warnings` entry. Treat a warning as a stop sign: wrong sign (a credit card that lists spending as positive), wrong amount column, or wrong format. Show it to the user and settle it before importing.

It writes the converted rows into chunk files and prints a summary: rows read, valid, rows outside the range, rows skipped with the reason, first and last date, total income and total expense in cents, a five-row preview. Nothing is sent yet.

Show the user:

- the preview (date, amount in Euro, name);
- the row count and date range, and the totals, so they can compare with the bank's own statement;
- whether the balance check confirmed the amounts (say "alle N Buchungen stimmen mit dem Saldo überein" or the equivalent), or that the file has no balance column so only the totals back it up;
- every skipped row with its reason.

If the script says "Amount format looks wrong", every row's decimal mark disagrees with the detected format (it would import amounts 100 times too large or small). Re-run with the `--amount-format` it names, or ask the user; never override it silently. If the script says it could not detect the date format, the dates are ambiguous (every day is 12 or less, so 01.09. could be 1 September or 9 January). Ask the user which comes first and pass `--date-format de` (day first) or `--date-format de-mdy` (month first); never pick one yourself. If the script refuses with "Day and month look swapped", it found dates like 13/09 that prove the format is wrong. Re-run with the `suggestedDateFormat` it names.

Ask once: "N Buchungen von <date> bis <date> in <account> importieren? Was FiBuKI schon hat, wird übersprungen."

## 5. Import

Same command plus `--import --source <sourceId>`. It needs `FIBUKI_API_KEY` in the environment (`npx @fibukiapp/cli auth --format env` creates one). It sends the chunks in order under one import id, waits out rate limits, and prints `imported` (new lines) and `alreadyImported` (skipped by FiBuKI as duplicates).

If it stops with "Import stopped at chunk X", the earlier chunks **are** imported. Do not re-run the whole import. Tell the user what arrived and what is left; the message names the chunk file to resume from and the import id to pass again as `--import-job-id`, so the chunks still count as one import. A quota message means the plan's Transaction limit was reached; say so.

## 6. Afterwards

Report: imported N, already there M, skipped K unreadable rows, date range. Then offer `fibuki-belege` for the period just imported, since the next step is finding the invoices for these payments.
