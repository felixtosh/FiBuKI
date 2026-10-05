# A Deal is one business case

_Status: accepted (2026-10-05, Stefan), settled in the #570 grilling. First named
"Bundle"; renamed the same day to Deal / Geschäftsfall._

Several Files often belong to one business case: a marketplace order paid with one card
charge arrives as one invoice per seller; a job starts with an **Offer**, the customer
signs it, an **Order Confirmation** follows, then a deposit invoice and a final one. Today
nothing records that they belong together. So the matcher sees each File alone: an Offer
or Order Confirmation sits in the unmatched list as noise, one part of an order can
connect itself to an unrelated Transaction of the same amount before its siblings arrive,
and nobody is told that a signed Offer was never invoiced.

A **Deal** records the business case. It is less about the accuracy of one Transaction
than about **less noise in matching** and **more for the User to chase missing documents
with**.

The rules:

1. **A Deal is one business case with one counterparty**, from Offer to last payment.
   It may span several invoices and several payments. "Explains one payment" is one thing
   a Deal can show, not what it is.
2. **Members in the first version:** Offers and signed Offers (both directions: the User's
   own and a supplier's), Order Confirmations, invoices and Receipts. Delivery notes and
   contracts are not members yet.
3. **A Deal forms by key, before any payment.** Two keys:
   - a printed order number;
   - one File citing another's invoice, order or Offer number ("laut Angebot Nr. …").

   Same issuer and same day is not a key. Two purchases at one shop on one day are exactly
   the collision ADR-0008 guards against.
4. **Offers and Order Confirmations are never a Match.** They are never suggested for, or
   connected to, a Transaction. They sit only in their Deal, out of the unmatched list,
   and their printed numbers help find the Deal's invoices.
5. **Invoices in a Deal are matched together.**
   - The sum of its unconnected invoices is scored against a Transaction, as one Match for
     the whole order.
   - While a known invoice member is still unconnected, a single member does not connect
     itself to a Transaction that matches only its own amount. It stays a suggestion.
6. **A Deal raises three chase prompts:**
   - a signed Offer from the User's customer, and no Invoice issued in the Deal: "Send a
     first invoice?";
   - an Order Confirmation or a payment, and no invoice received: chase the supplier;
   - an invoice still **Outstanding** after its Due Date.
7. **When FiBuKI is wrong, the User rules.**
   - Removing a member is a standing ruling, like a **Rejection**. That File is never put
     back into that Deal automatically, and the ruling survives re-extraction.
   - A File can be added by hand, for a member the key missed.
   - A Deal whose invoices end up on different Transactions that are not its payments is
     shown as a conflict to resolve.
8. **A Copy is never a member**; its original is (ADR-0010). A Deal is complete for
   payment when its Transaction's Remainder reaches zero, as Coverage already says.

## Why a domain concept and not a scorer input

The smaller option was to let the matcher know about siblings without naming them: no
store, no UI, nothing to undo. It covers the collision and nothing else. The chase prompts
need a thing that exists before any payment and holds non-invoice documents, and a wrong
grouping needs somewhere to keep the User's "this File does not belong here". Both need a
stored concept with one writer.

## Why "Deal" and "Geschäftsfall"

The German word came first: *Geschäftsfall* names exactly one business case with one
counterparty, in either direction. The English headword follows it. "Business case" is
the literal translation, but in English it means a justification for a project. "Deal" is
short, fits buying and selling alike, and collides with nothing in the glossary or the
code.

Rejected names:
- **Bundle**, the first name. It said "several Files" rather than "one business case",
  and Split's Avoid list already used it for one PDF holding several invoices.
- *Sammelbeleg*, which names the Split case.
- *Geschäftsvorfall*, which in bookkeeping is a single booked transaction.
- *Auftrag* / Engagement, which reads oddly for a purchase.
- *Vorgang* and *Belegkette*, which are generic ERP words. *Belegkette* names the
  documents, not the case.

## Considered options

- **Matcher input only.** Rejected; see above.
- **A Deal tied to one payment.** Rejected: a deposit and a final invoice are one
  business case, and a Deal that exists only once connected cannot guard against a
  premature auto-connect.
- **An Order Confirmation as a stand-in Match until the invoice arrives.** Rejected: more
  noise, and it carries no Vorsteuer anyway.
- **"Offer never signed" as a chase prompt.** Rejected: that is CRM, not pre-accounting.
- **A one-click "dissolve".** Not built: removing members covers it.

## Consequences

- `File` gains what business document it is (Offer, signed Offer, Order Confirmation,
  invoice, Receipt), read by the Extraction. This is a separate field from **Document
  Type**, which stays the § 11 axis: an Offer and an Order Confirmation are both `other`
  there.
- The Extraction reads the keys: order number, and the Offer, order or invoice numbers a
  File cites.
- A Deal store with one writer, its member rulings, and the matcher's eligibility, sum
  scoring and guard.
- Scope: these prompts *read* documents the User already has. Writing Offers in FiBuKI is
  not part of this; see `docs/who-is-this-for.md` and #577.
