---
status: accepted
date: 2026-08-24
---

# The Partner is the supplier, and the invoicing agent is a named field

§ 11 Abs 2 UStG lets a third party write an invoice in the name of the business that did
the work. Uber Austria GmbH does this for licensed taxi operators, and the Extraction read
two byte-identical Uber Files two different ways — one stored the operator, one stored Uber
and Uber's own UID lifted from the page footer. 15 rows were wrong (fork #150).

**The Partner is always the Leistungserbringer** — the business that supplied the service.
The Vorsteuer trail follows that business and its UID. The business that wrote the document
is an **Invoicing Agent**: recorded on the Extraction under a fixed field name, with its
UID, and never used to resolve a Partner, match a Transaction, or support a deduction.

## Consequences

The agent stops living in `extractedAdditionalFields`, where nothing controlled its label —
the same two runs called it `Issuer Platform` and `Service Provider`. A fixed field makes
that drift impossible and makes "which template is this" answerable later.

Keeping the agent rather than discarding it costs one field and buys the explanation: a
user who reads "Uber" on the document and sees a taxi company in FiBuKI has something that
says why. Making the agent a second Partner with a role was rejected — it would push the
supplier/issuer question out into every consumer, which is the confusion this decision
exists to remove.
