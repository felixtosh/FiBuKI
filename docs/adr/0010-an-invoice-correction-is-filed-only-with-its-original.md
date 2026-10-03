# An Invoice Correction is linked to the File it corrects, and is filed only with that original

_Status: accepted (2026-10-03, Stefan). Settles #563, decisions D8 and D20–D25; specified
in #564._

A refund is money coming back for something already booked. FiBuKI used to decide what a
bank line is from its sign alone, so a supplier's refund became negative revenue and the
User's refund to a customer became a purchase. § 16 Abs 1 says each side corrects what it
originally did: the buyer corrects the Vorsteuer it claimed (KZ 067), the seller the tax it
owed (KZ 000 and the rate field, overflowing to KZ 090). Nothing in FiBuKI said what that
original was.

The rules:

1. **An Invoice Correction is linked to the File it corrects.** The link points at a File,
   never at a Transaction; the Transaction that paid the original is found through that
   File's File Connections. An Invoice Correction or Cancel FiBuKI issues carries the link
   already. An original purchase File connected to the refund line directly counts as the
   link too, since the File then sits on both Transactions.
2. **The referenced invoice number decides first.** A number that matches a File of the
   same Partner links automatically. The sign of the document's amounts comes second (a
   negative "Gutschrift" is a correction; a positive one with no reference is a
   Self-billed Invoice). Partner and amount only ever suggest a link, and the User has the
   last word.
3. **A correction reverses what the original did, no more.** Refund ÷ original gross ×
   what the original claimed or owed, at the original's rates, in the period the money
   moves. All corrections of one original together are capped at what it claimed.
   An original that claimed nothing corrects nothing.
4. **No original, no filing.** A correction without a linked original is a blocker: Mark
   as filed and the FinanzOnline submission refuse the period until it is linked or
   reclassified. The preview keeps the safe default (unexplained money in is 20% revenue),
   so a blocked period never understates.

## Considered options

- **The bank sign decides.** Rejected: it is the bug. It books every supplier refund as
  negative revenue, and the BMD Export puts it on a Debitor.
- **The correction document alone decides, no link.** Rejected (it was the first
  recommendation, D3): it cannot know whether the original claimed any Vorsteuer, at which
  rate, or whether an earlier refund already took it back. A 0% marketplace purchase
  would be "corrected" at 20%.
- **Link optional, flag when missing.** Rejected by Stefan: a flag can be filed past. A
  refund FiBuKI cannot justify should not reach the Finanzamt.
- **An escape hatch for originals outside FiBuKI** (bought before the first Import).
  Rejected: the User imports that bank period. The original's claim is then known, not
  assumed.

## Consequences

- `File` gains a referenced invoice number (Extraction) and a correction link with its
  provenance (`auto`, `suggested-accepted`, `manual`).
- One function decides a Transaction's booking side (sale, sale correction, purchase,
  purchase correction) for the UVA and the BMD Export alike. The sign is only the
  fallback when no File says otherwise.
- The period run hands the original's claim and earlier corrections to the pure UVA
  calculation, as `priorClaimedFraction` already does. The calculation never queries.
- Money in with no File at all (a reversed card charge) is unaffected: it still takes the
  safe default or a No-document Category.
