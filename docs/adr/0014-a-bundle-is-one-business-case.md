# A Bundle is one business case

_Status: accepted (2026-10-05, Stefan), settled in the #570 grilling. The German word is
still to be confirmed._

Several Files often belong to one business case: a marketplace order paid with one card
charge arrives as one invoice per seller; a job starts with an **Offer**, the customer
signs it, an **Order Confirmation** follows, then a deposit invoice and a final one. Today
nothing records that they belong together. So the matcher sees each File alone: an Offer
or Order Confirmation sits in the unmatched list as noise, one part of an order can
connect itself to an unrelated Transaction of the same amount before its siblings arrive,
and nobody is told that a signed Offer was never invoiced.

A **Bundle** records the business case. It is less about the accuracy of one Transaction
than about **less noise in matching** and **more for the User to chase missing documents
with**.

The rules:

1. **A Bundle is one business case with one counterparty**, from Offer to last payment.
   It may span several invoices and several payments. "Explains one payment" is one thing
   a Bundle can show, not what it is.
2. **Members in the first version:** Offers and signed Offers (both directions: the User's
   own and a supplier's), Order Confirmations, invoices and Receipts. Delivery notes and
   contracts are not members yet.
3. **A Bundle forms by key, before any payment.** Two keys:
   - a printed order number;
   - one File citing another's invoice, order or Offer number ("laut Angebot Nr. …").

   Same issuer and same day is not a key. Two purchases at one shop on one day are exactly
   the collision ADR-0008 guards against.
4. **Offers and Order Confirmations are never a Match.** They are never suggested for, or
   connected to, a Transaction. They sit only in their Bundle, out of the unmatched list,
   and their printed numbers help find the Bundle's invoices.
5. **Invoices in a Bundle are matched together.**
   - The sum of its unconnected invoices is scored against a Transaction, as one Match for
     the whole order.
   - While a known invoice member is still unconnected, a single member does not connect
     itself to a Transaction that matches only its own amount. It stays a suggestion.
6. **A Bundle raises three chase prompts:**
   - a signed Offer from the User's customer, and no Invoice issued in the Bundle: "Send a
     first invoice?";
   - an Order Confirmation or a payment, and no invoice received: chase the supplier;
   - an invoice still **Outstanding** after its Due Date.
7. **When FiBuKI is wrong, the User rules.**
   - Removing a member is a standing ruling, like a **Rejection**. That File is never put
     back into that Bundle automatically, and the ruling survives re-extraction.
   - A File can be added by hand, for a member the key missed.
   - A Bundle whose invoices end up on different Transactions that are not its payments is
     shown as a conflict to resolve.
8. **A Copy is never a member**; its original is (ADR-0010). A Bundle is complete for
   payment when its Transaction's Remainder reaches zero, as Coverage already says.

## Why a domain concept and not a scorer input

The smaller option was to let the matcher know about siblings without naming them: no
store, no UI, nothing to undo. It covers the collision and nothing else. The chase prompts
need a thing that exists before any payment and holds non-invoice documents, and a wrong
grouping needs somewhere to keep the User's "this File does not belong here". Both need a
stored concept with one writer.

## Why "Bundle"

The word was on Split's Avoid list, as prose for one PDF holding several invoices. That is
the opposite case: one File, several documents. It is retired there so the word has one
meaning. *Sammelbeleg* is not the German word, because it names the Split case.

## Considered options

- **Matcher input only.** Rejected; see above.
- **A Bundle tied to one payment.** Rejected: a deposit and a final invoice are one
  business case, and a Bundle that exists only once connected cannot guard against a
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
- A Bundle store with one writer, its member rulings, and the matcher's eligibility, sum
  scoring and guard.
- Scope: these prompts *read* documents the User already has. Writing Offers in FiBuKI is
  not part of this; see `docs/who-is-this-for.md` and #577.
