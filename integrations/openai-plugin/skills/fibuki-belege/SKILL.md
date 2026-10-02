---
name: fibuki-belege
description: Match a month of bank payments to their invoices and receipts in FiBuKI, find the missing ones in the user's connected mailbox and cloud files, and close the month for the Steuerberater. Use for "mach meinen Monat fertig", "welche Zahlungen haben keinen Beleg", "find my invoices", "match my receipts", or any request to document Transactions.
metadata:
  short-description: Match payments to invoices and chase the missing ones
---

# Belege: close a month

Goal: every Transaction in the period ends up with a Beleg (File), a Kategorie ohne Beleg, or a named reason it has none, so the Steuerberater gets clean data. FiBuKI does the reading and scoring; this skill drives the loop and asks the user once per batch.

Answer in the user's language. Use: Beleg (File), Vorschlag (Match), Zuordnung (File Connection), Deckung (Coverage), Kategorie ohne Beleg (No-document Category), Postfach (Mail Integration). Say "match confidence", never a bare "confidence". Amounts are integer cents (negative is an expense); show Euro with a decimal comma to German users (`12,34 €`).

## Hard rules

- **Never score or judge a match yourself.** The Vorschlag and its match confidence come from FiBuKI (`list_files`, `get_file`, `score_file_transaction_match`). You present them.
- **One confirmation per batch, never per item.** Show a compact table, ask once, then apply the whole batch. Nothing is written that the user has not confirmed in this turn.
- **Never delete a Transaction.** Transactions leave only with their whole Bank Account. Offer a Kategorie ohne Beleg instead.
- **A pair the user rejected stays rejected.** `connect_file_to_transaction` answers PAIR_REJECTED; do not lift it with `undismiss_transaction_suggestion` unless the user explicitly says the pairing is right.
- Plan limits: if a tool answers that a feature is not in the plan (`fileUpload`, `aiMatching`), say so once and continue with what is allowed.

## 0. Period

Default: the last full calendar month. If the user named one ("September", "Q3"), use it. If you do not know today's date, ask. Convert to `dateFrom` / `dateTo` (YYYY-MM-DD).

## 1. Status

`get_period_status` with `dateFrom`, `dateTo`: coverage per month (covered, still missing, on hold because of the plan), the newest missing lines, and how many Zuordnungen wait for a yes. Where the client supports widgets it draws a progress board; do not repeat the board in text, add one sentence with the point of it. If `truncated` is true the numbers describe the newest Transactions only; say so.

For the full list of missing lines page `list_transactions_needing_files`; for lines whose only document is a receipt without a § 11 invoice page `list_transactions_missing_invoice`. Keep the rows inside the period.

Then go straight on; do not ask whether to continue.

## 2. Harvest what FiBuKI already found

`list_pending_matches` (default confidence 85 and up, best first). Each row is a File, the Transaction FiBuKI proposes and FiBuKI's own match confidence. Where the client supports widgets it shows a review list with Übernehmen / Ablehnen per row and "alle übernehmen"; then stay out of the way. Without widgets show the pairs for the period as a table (Beleg, Partner, amount, date, payment, match confidence), highest first.

Ask once: "Diese N Zuordnungen übernehmen?" On yes, `connect_file_to_transaction` for each pair; a pair the user refuses goes through `dismiss_transaction_suggestion`. For a large clean batch, `auto_connect_file_suggestions` with `minConfidence` set to the bar you showed connects everything above it in one call; use it only when every pair you showed is above that bar, otherwise connect the confirmed pairs one by one.

Check `list_files` with `needsDirectionReview: true`. Files listed there are probably the user's own issued invoices or ones FiBuKI cannot place; tell the user, and fix with `update_file_extraction` (`invoiceDirection`) only on their say-so.

## 3. Find the missing Belege

For Transactions still without a Beleg, largest amounts first (input VAT is worth most there), search the apps the user has connected to this assistant. See `references/invoice-hunting.md` for the search recipe. Rules:

- Work in rounds of about 15 Transactions, then report and ask whether to continue.
- Stop at the first plausible hit per Transaction. A hit is a PDF or image whose sender, amount and date fit; ignore newsletters, order confirmations, Mahnungen and Gutschriften (see the reference).
- If no mailbox or file app is connected, say what is missing and suggest FiBuKI's own Postfach (https://fibuki.com/integrations/gmail), which keeps syncing in the background. Do not stall the loop on it.
- Login-only portals (A1, Magenta, Wiener Netze, AWS, Google Ads) are not in a mailbox. Name them in the close-out and point to the FiBuKI browser extension (https://fibuki.com/integrations/browser).

## 4. Upload and match

Get each found document into FiBuKI:

- **With a shell (Codex):** save the attachment to a temp folder, then run `node "${PLUGIN_ROOT}/scripts/fibuki-upload.mjs" <files...>` (needs `FIBUKI_API_KEY`). It prints one JSON result; `duplicate: true` means FiBuKI already had that exact file, which is fine.
- **Without a shell:** `upload_file` with `url` when the app gives a fetchable link. When it does not, tell the user which documents to drop into https://fibuki.com/files themselves, and carry on with the rest.

FiBuKI then reads the document and proposes the Match on its own; extraction can take up to about a minute. Re-read with `list_files` (`hasSuggestions: true`) or `get_file`, show the new Vorschläge as in step 2, and connect the confirmed ones. If extraction produced nothing usable (no total, no VAT amount), `retry_file_extraction` once.

## 5. Lines that have no document

For what is left, `list_no_receipt_categories`, then propose a Kategorie ohne Beleg per line where the nature is clear from the Transaction (bank fees, interest, transfers between the user's own accounts, social insurance, taxes, payroll). Show them as one batch with the reason per line, ask once, then `assign_no_receipt_category`. A Kategorie ohne Beleg is a stated reason no document exists, not a way to hide a missing one: leave anything unclear for the user.

## 6. Receipts without an invoice

For lines from `list_transactions_missing_invoice`, explain once: a receipt is proof of payment, but without an invoice that meets § 11 UStG there is no Vorsteuer. Per line the row lists which § 11 elements are missing. Offer to write a short request to the supplier that names them. Only if the user says no invoice can be obtained (for example a marketplace seller that charges no VAT) and gives the reason, record it with `accept_receipt_only`. The reason is the record; never invent it.

## 7. Close out

End with:

- what was connected, categorised, uploaded, in numbers;
- what is still open, one line each (Partner, amount, date) so the user can fetch it, including portal invoices and receipts without an invoice;
- one next step. If nothing is open: the month is ready, and the Steuerberater export is in FiBuKI (https://fibuki.com/integrations/bmd-export).
