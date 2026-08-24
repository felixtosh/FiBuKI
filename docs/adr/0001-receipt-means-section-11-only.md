---
status: accepted
date: 2026-08-24
---

# "Receipt" means the § 11 sense only

"Receipt" carried three meanings at once: the `DocumentType` value for a document that is
*not* a § 11-complete invoice, the `noReceiptCategories` collection (a transaction with no
document at all), and `needs-receipt` / `receipt-only` states in between. The § 11 sense
is the one with legal weight and the one the extraction prompts have to get exactly right,
so it keeps the word. Everything that meant "no document at all" becomes **document**
language: **No-document Category**, VAT treatment **needs-document**.

## Consequences

The rename is vocabulary-first, storage-later. `noReceiptCategoryId` is a stored field on
transactions and `noReceiptCategories` a live collection — `noReceiptCategor*` alone
appears in 85 files — so renaming the identifiers today is a data migration for no
functional gain. Issues, specs, prompts, UI copy and new code use the glossary words
immediately; the field and collection names are renamed as part of the Firebase → Postgres
port, where the schema is rewritten anyway. Until then `CONTEXT.md` records the mapping,
and code that reads `needs-receipt` is reading the term now called `needs-document`.

## Considered and rejected

Keeping "receipt" as the everyday word for any incoming Beleg and renaming the
`DocumentType` value to `kassenbeleg` / `non-invoice`. Cheaper in field names, but it puts
imprecise language exactly where § 11 deductibility is decided.
