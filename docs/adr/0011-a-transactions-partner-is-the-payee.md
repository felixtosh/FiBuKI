# A Transaction's Partner is the payee

_Status: accepted (2026-10-03), decided in #550. Replaces the "File wins" Partner sync,
which was never an ADR. Builds on [ADR-0003](0003-partner-is-the-supplier.md)._

A Transaction's Partner is the **payee**: the business the money went to, as the bank
line identifies it. A File's Partner stays the supplier, the business that did the work
(ADR-0003). Connecting a File never overwrites a Transaction's Partner. It may fill an
empty one, and only when every File connected to the Transaction names the same Partner.
A Partner the User set on the Transaction by hand is never changed by a File.

Nothing flows the other way. A File without a Partner is not given the Transaction's: the
payee is not evidence of the supplier. That File waits for Partner matching or a person.

## Why

The two Partners are different facts, and FiBuKI stored them in one field. Until this
decision, the last File connected rewrote the Transaction's Partner to its own ("the File
wins"), keeping the old one aside. Two cases showed that this was wrong:

- **Marketplace orders.** One Amazon charge covered three sellers' documents: an invoice
  from a Polish VAT ID at 0 % and two non-EU Receipts. Whichever seller's File was
  connected last became the bank line's Partner, so the Transaction showed an arbitrary
  seller as the business that was paid.
- **Uber.** The money goes to Uber; the File's Partner is the taxi operator (ADR-0003).
  The sync rewrote the bank line to the operator, so the Transactions list no longer read
  like the bank statement.

Each File keeps its own supplier, so the input VAT trail still follows the supplier's UID.
The Transaction keeps the payee, so Partner filters, learned patterns and billing cycles
describe payments, which is what they are keyed on.

## Every writer applies the same rule

The connect step, auto-connect, the tool surface's connect and the File Partner match all
used to sync a File's Partner onto its Transaction, each with its own conflict rule. They
now ask one rule. The outcome does not depend on which of them ran last: a Transaction
whose Files name the same Partner gets it once the last File's Partner is known, and one
whose Files disagree stays empty.

## The BMD Export's Personenkonto

The export used to book each line to the Transaction's Partner, which under "the File
wins" was usually the supplier. To keep one-supplier lines unchanged before the October
filing export, a line books to the Partner every connected File names when they agree,
and to the Transaction's Partner (the payee) otherwise, including when no File has a
Partner. Whether a multi-supplier payment should book per supplier instead is a question
for the Tax Advisor; the payee is the conservative choice until then.

## Consequences

- Existing Transactions keep the Partner they have. A pass that re-derives the payee for
  old lines is a follow-up.
- Matching that awards points when a File's Partner equals the Transaction's sees fewer
  such pairs on marketplace and platform charges. That is a matching question, not a
  reason to merge the two facts again.
