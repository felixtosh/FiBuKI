# A Receipt counts once with the invoice it pays

_Status: accepted (2026-10-04, Stefan), settled in the #571 grilling. Amends
[ADR-0001](0001-receipt-means-section-11-only.md) on what "Receipt" means._

A charge often arrives with two documents: the invoice, which states what is owed, and a
**Receipt**, which confirms the payment. GitHub and Stripe send both for every charge; a
restaurant hands over a Rechnung and the card terminal prints a slip carrying the tip.
Both are evidence, so both are connected to the Transaction. They are one charge, so they
are counted once.

The rules:

1. **A Receipt is linked to the invoice it pays.** The link sits on the Receipt and
   points at a File, with who set it (`auto`, `suggested-accepted`, `manual`). One
   Receipt pays one invoice; an invoice may have several Receipts (instalments, or a
   Stripe receipt beside a card slip). A pair a person declined is never linked or
   suggested again.
2. **The role decides, not the Document Type.** A Receipt that prints every § 11 element
   is classified `invoice`, and that is right; it is still the Receipt of its pair. A
   Receipt and its invoice are never a **Copy** of each other, whatever their numbers,
   amounts and days say.
3. **The system records the link only on a cited invoice number.** The Extraction
   transcribes the number of the invoice a document confirms payment for, apart from the
   document's own number. That number equal to another File's invoice number from the
   same issuer records the link. Same Partner, same extracted day and a Receipt total at
   or above the invoice's only suggest it. Amount alone never suggests. The check runs
   from both sides, so the order in which the two Files arrive decides nothing.
4. **A pair counts as one document.** Coverage, the UVA and the BMD Export read the
   invoice's figures. Its payment total is raised to the Receipt's when that is larger
   (the largest Receipt's, when there are several), and the difference is Trinkgeld:
   part of the payment, no part of the VAT base, judged by the same tip guards as a
   printed one. A Receipt smaller than its invoice adds nothing, and the existing
   partial-payment arithmetic claims the paid fraction. A pair in two currencies counts
   the invoice alone.
5. **A pair counts once only while both Files are live and connected to the same
   Transaction.** Derived on read, as a Copy is; otherwise each counts as an ordinary
   File. Unlinking one File never unlinks the other, and the link stays until a person
   removes it.
6. **The matcher follows the pair.** With one File of a pair connected, the other is
   connected to the same Transaction automatically, past the Coverage gate, since it
   adds only its surplus. The Connection Origin is auto, with the reason `paired`, so
   these Connections are findable as a class. Where the other File is already connected
   elsewhere nothing moves: moving a File Connection needs a person (ADR-0010).
7. **Both directions.** A payment confirmation for an Invoice the User issued pairs with
   it under the same rules.

## Why both stay connected

The alternative was the Copy's shape: the Receipt holds no File Connection and is only
shown beside its invoice, so "connected means counted" holds untouched. It does not stay
cheap. The Receipt's tip has to reach Coverage and the UVA, so every amount reader learns
about the pair anyway; the BMD Export would drop the payment evidence; and a Receipt that
arrived first would need a person to unlink it before its invoice could take over.

So this ADR relaxes ADR-0010's rule to "connected means counted, and a pair counts once".
The risk ADR-0010 named is a reader that forgets the exception and reports a wrong VAT
figure. It is contained by where the collapse happens: one pure function turns a
Transaction's connected Files into the documents it counts, and it is called at the two
places every amount reader already goes through: the summary of a Transaction's
connected Files that Coverage, the Remainder and the scorers read, and the UVA adapter
the BMD Export builds its rows from.

## Why a recorded link

Pairing could be derived on every read from issuer, amount and day. The live data says
no: every Transaction that held a Receipt and an invoice before this decision was a
Sammelbuchung of different charges (an Amazon order across three sellers, a platform's
fee beside a private purchase contract). A rule such as "on a line that holds an invoice,
Receipts count only for the excess" would have under-counted every one of them, and a
derivation has nowhere to keep a person's "these are two charges".

## What "Receipt" means now

ADR-0001 gave "Receipt" one meaning, the § 11 one: a document that is not an invoice.
That reading cannot name this role, because the Receipts that started this decision
(GitHub's, Stripe's) are § 11 invoices. The two questions come apart:

- **Receipt** says what a document is: it confirms that a payment was made. An invoice
  states what is owed.
- **Document Type** says how a File stands under § 11: `invoice` when it is
  § 11-sufficient, whatever it is titled; `receipt` for proof of spend that is not; then
  `other` and `unknown`. Most Receipts have Document Type `receipt`; some have `invoice`.

ADR-0001's other half stands: everything that meant "no document at all" keeps the
document words (No-document Category, `needs-document`).

## Considered options

- **The Copy's shape, the Receipt holding no File Connection.** Rejected; see above.
- **Derive the pairing on read.** Rejected; see above.
- **Only Files of Document Type `receipt` can pay.** Rejected: GitHub and Stripe Receipts
  are classified `invoice`, so the case that opened #571 would never pair, and the Copy
  check would keep recording them as Copies.
- **Count the invoice alone, the Receipt for nothing.** Rejected: an invoice printing no
  Trinkgeld beside a slip that does leaves the tip unexplained, and the UVA refuses the
  line as an amount mismatch.
- **A new word for the role** (Payment Confirmation). Rejected by Stefan: Receipt is what
  the documents call themselves, and the meaning is the one a reader brings.

## Consequences

- `File` gains the cited invoice number (Extraction) and the Receipt link with its
  provenance, suggestions and declined pairs, the shape the correction link has.
- Documentation State is unchanged: an invoice already outranks a Receipt. An Accepted
  Receipt ruling on the line goes stale on its own when the invoice joins.
- While a pair counts, both panels label its Files "Invoice" and "Receipt"; the
  Receipt's Document Type badge gives way to "Receipt for" its invoice, since nothing is
  claimed from it.
- The BMD Export books the pair as one document, ships both PDFs and names the invoice
  first.
- Stored Files carry no cited number until re-extracted. A one-off run of the suggestion
  check covers them; there is no re-extraction sweep.
