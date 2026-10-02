# What bank exports look like

The layouts below are the ones FiBuKI's own tests and samples use (`spikes/jev-eval`, `tests/fixtures/openai-plugin`). They are modelled on real exports but were written by hand. Banks change their exports without notice, so **always trust the headers and samples from `analyze`, not this list**. When a real export differs, say so and add an anonymised sample to `tests/fixtures/openai-plugin`.

## Layouts seen

| Layout | File | Date | Amount | Notes |
|---|---|---|---|---|
| George (Erste / Sparkasse) style | semicolon, Windows-1252 | `Buchungsdatum` `01.09.2026` | `Betrag` `-54,20`, `+3.412,55` (explicit plus on income) | Counterparty in `Partnername` and `Partner IBAN`; text in `Buchungstext`; `Saldo` is the running balance, **not** an amount; `Währung` is its own column |
| N26 style | comma, UTF-8 | `Date` `2026-09-01` | `Amount (EUR)` `-89.99` (dot decimal) | `Payee`, `Account number` (counterparty), `Payment reference`; a second `Amount (Foreign Currency)` column that is mostly empty |
| Soll/Haben style | semicolon | `Valuta` `22.09.26` (two-digit year) | two columns: `Soll` (debit) and `Haben` (credit), both positive | Use `--debit` and `--credit`; no counterparty column, the `Text` carries everything |

## Traps the script already handles

- **Encoding**: Windows-1252 files turn `ä ö ü ß` into garbage when read as UTF-8; the script detects it.
- **Delimiter**: `;` in German-language exports, `,` in English ones.
- **Decimal separator**: `1.234,56` (German) against `1,234.56` and `-89.99` (English). A dot as decimal in a column that looks German would read 89,99 as 8.999; FiBuKI's detector now breaks that tie by looking at where the separators sit.
- **Two-digit years** (`22.09.26`).
- **Swapped day and month**: refused, not guessed.
- **Decimal mark disagreeing with the values** on any amount column: refused, with the format to use instead.
- **Debit/credit in two columns**: combined into one signed amount.

## Traps you must handle

- **Which date.** If both a booking date and a value date (Valuta) exist, use the booking date, unless the user says otherwise.
- **Running balance columns** (`Saldo`, `Balance`) are never the amount, but pass them as `--balance`: the script then proves the amounts against the balance on every row.
- **Several accounts in one file** (some banks export all accounts together, with an IBAN column per row): ask the user to split the file or tell you which IBAN to import; one Bank Account per import.
- **Credit cards** often show the amount as positive for spending. If the file has a balance column, `--balance` exposes the wrong sign (the balance falls while the amounts are positive). Otherwise check the first rows against what the user remembers. Either way, tell the user rather than flipping the sign silently.
- **Header lines before the table** (account holder, period): the script reads the first line as the header. If `analyze` shows nonsense headers, count the lines above the real header and pass `--skip N` to `analyze` and `convert`.
- **Currency**: `--currency` for a single-currency file, `--currency-col` when the file has one per row.
