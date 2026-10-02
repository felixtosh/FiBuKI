# Finding the invoice for a payment

Read this in step 3 of `fibuki-belege`. It applies to whichever of Gmail, Outlook, Google Drive, OneDrive/SharePoint and Dropbox the user has connected to this assistant. Use only read-only search; never send, move or delete anything in the user's mailbox or drive.

## Build the search from the Transaction

A Transaction gives you a name, often a Partner, an amount in cents, and a date.

1. **Sender or vendor**: the Partner name if there is one, otherwise the cleaned bank text. Drop noise words and card-terminal prefixes: `POS`, `SEPA-LASTSCHRIFT`, `K1`, branch numbers, `GmbH`/`AG` suffixes on the second attempt. Try the vendor's domain as well when you can infer it (`a1.net`, `amazon.de`).
2. **Amount**: search the number both ways, `39,90` and `39.90`. Only the absolute value; the sign is the bank's view.
3. **Window**: from 10 days before the payment date to 45 days after. Invoices usually come before a direct debit and after a card payment.
4. **Words**: `Rechnung`, `Invoice`, `Beleg`, `Receipt`, `Rechnungsnummer`. Prefer messages with a PDF or image attachment.

Order of attempts per Transaction, stop at the first good hit:

1. vendor + amount + window
2. vendor + window + attachment
3. amount + `Rechnung`/`Invoice` + window (vendor name may be spelled differently on the invoice)
4. in cloud files: vendor + year/month in the file name, PDF or image only

## What counts as a hit

Accept a PDF or image where **sender or issuer, amount and date plausibly fit** the Transaction. Do not judge beyond that; FiBuKI scores the match after upload and may disagree.

Do not upload:

| Document | Why not |
|---|---|
| Newsletter, marketing mail | not a Beleg |
| Bestellbestätigung, Auftragsbestätigung, Angebot | not an invoice yet; the invoice comes later |
| Mahnung, Zahlungserinnerung | a reminder about an invoice, not the invoice |
| Gutschrift, Storno | a credit note reverses an expense; mention it to the user instead of attaching it to the original payment |
| Kontoauszug | a bank statement, not a Beleg for one payment |
| An invoice the user issued (their own name as issuer) | it documents income; FiBuKI's identity setup keeps these apart, so mention it, do not attach it to an expense |

When several attachments fit, take the one named like an invoice; a mail that has both an invoice and a receipt PDF: the invoice.

## Amounts that do not match exactly

- Foreign-currency payments: the card amount in EUR differs from the invoice. Accept a hit on vendor and date and let FiBuKI score it.
- One invoice paid in parts, or several invoices paid in one transfer: a Transaction can have several Files and a File can serve several Transactions. Upload once; FiBuKI proposes the Matches.
- Subscriptions: the same vendor monthly. One search per month, same recipe.

## Not in a mailbox

Some vendors only show invoices after login: telecom and utility portals (A1, Magenta, Wiener Netze), AWS, Google Ads, many SaaS billing pages. Do not search for them in rounds of mail. List them in the close-out with Partner, amount and month, and point to the FiBuKI browser extension (https://fibuki.com/integrations/browser), which records and replays those portals.

## Report what you did

After each round, one table: Transaction, where you looked, what you found (file name and sender) or "nothing found". The user must be able to tell "searched, not there" from "did not search".
