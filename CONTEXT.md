# FiBuKI

Pre-accounting for Austrian one-person businesses (EPUs): turn the pile of Belege and
bank lines into something a Steuerberater can book without cleaning it up first.
This glossary is the project's ubiquitous language — issues, tests, UI copy and code
should use these words and avoid the listed synonyms.

Scope note: this file is a glossary, not a spec. Positioning lives in
[`docs/who-is-this-for.md`](docs/who-is-this-for.md), the rebuild plan in
[`docs/rewrite-goals.md`](docs/rewrite-goals.md), decisions in [`docs/adr/`](docs/adr/).

## People

**User**:
The Austrian EPU or freelancer whose books these are. Owns every record in the system;
all data is scoped to one user.
_Avoid_: customer, client, account holder

**Steuerberater**:
The user's tax advisor. Invited read-only, never charged, and never a tenant of their
own — a gatekeeper we must satisfy, not a buyer we sell to.
_Avoid_: accountant, advisor, Kanzlei user

**Partner**:
A business the user transacts with, as that user knows it — one record per user, holding
the IBANs, VAT ID, domains and learned patterns that identify it. On a File, the Partner
is always the business that **did the work** (the Leistungserbringer), never the business
that happened to write the document. See
[ADR-0003](docs/adr/0003-partner-is-the-supplier.md).
_Avoid_: vendor, supplier, merchant, counterparty, contact

**Global Partner**:
The cross-user record a Partner may link to, built from what many users contributed.
Suggests identifying data; never owns a user's decisions.
_Avoid_: master partner, global vendor

## Money coming in

**Source**:
An account transactions arrive from — a bank account, a credit card, or a depot. Every
Transaction belongs to exactly one.
_Avoid_: account, bank, connection, feed. (In matching code, "match source" is a
different thing: see **Match Source**.)

**Transaction**:
One booked line from a Source: date, amount in cents with a normalised sign (negative =
money out), booking text, counterparty text. The bank's words, kept as imported.
_Avoid_: booking, entry, payment, line item

**Import**:
One batch of Transactions taken in at once, from a CSV or a connector, retaining the raw
columns so a parse can be re-read later.
_Avoid_: upload, sync (a **Sync** is the mailbox side)

## Evidence coming in

**File**:
Something the user received or uploaded — the digital Beleg. The unit that gets extracted,
classified and matched. One word for one thing: a File whose Document Type is `other`, or
whose Extraction failed, is still a File.
_Avoid_: document, receipt, attachment, Beleg (in code and English copy). The single
exception is **Document Type**, where "document" names the File itself; the word appears
nowhere else in that sense. **Documentation State** is unrelated — see its entry.

**Document Type**:
What a File is under § 11 UStG: `invoice`, `receipt`, `other`, or `unknown`. Decides
whether the File can carry a VAT deduction. A reverse-charge document is an invoice.
_Avoid_: kind, category (a **Category** is the booking category)

**Receipt**:
A File that is a document but not a § 11-complete invoice — a Kassenbeleg. It proves the
spend and never carries a VAT deduction. "Receipt" has this one meaning and is never the
everyday word for an incoming document; that word is **File**. See
[ADR-0001](docs/adr/0001-receipt-means-section-11-only.md).
_Avoid_: receipt as a synonym for Beleg, voucher, proof of purchase

**§ 11 Element**:
One of the nine things § 11 UStG requires an invoice to print (issue date, supplier name
and address, description, Steuersatz, invoice number, supplier VAT ID, recipient,
recipient VAT ID). Their absence is what demotes a document to a receipt.

**Invoicing Agent**:
A business that writes a File in the name of another, as § 11 Abs 2 UStG permits (Uber
Austria GmbH for a taxi operator). Recorded on the Extraction under a fixed field name,
UID and all. Never a Partner, never matched against a Transaction, never part of a
Vorsteuer trail.
_Avoid_: issuer platform, service provider, billing partner

**Extraction**:
The structured facts read off a File — entities, dates, amounts, line items, rate groups
— together with how they were obtained. One File has one current Extraction.
_Avoid_: parse, OCR result, AI output

**Line Item**:
One priced row transcribed from a File's body.
_Avoid_: position, row, item

**Rate Group**:
One row of the VAT summary block the document itself prints (rate, net, VAT, gross). Read
off the document, never derived from Line Items.
_Avoid_: VAT breakdown, tax group, summary row

## Connecting the two

**Match**:
A candidate pairing of one File with one Transaction, carrying a Score and the reasons
behind it. A Match is a proposal, not a fact.
_Avoid_: link, hit, candidate

**Match Source**:
One reason a Match scored: IBAN, VAT ID, website, email domain, name, learned pattern, or
manual. Evidence, not a channel.

**Score**:
How strongly a Match is evidenced, 0-100. Above the auto threshold it becomes a File
Connection by itself; above the suggestion threshold it is shown to the user.
_Avoid_: confidence, probability, rating

**File Connection**:
An established pairing of a File and a Transaction — the record that says this document
documents this line.
_Avoid_: match (that is the candidate), attachment, link

**Rejection**:
The standing "this File and this Transaction do not belong together", whoever recorded it
— a click, an agent, an MCP call. Survives re-scoring and re-extraction; a rejected pair
is never proposed again. One list, one shape, one writer.
_Avoid_: dismissal, ignore, hide, snooze. (Stored as `dismissedTransactions` on the file
until the Postgres port renames it — see
[ADR-0002](docs/adr/0002-rejection-is-the-word.md).)

**Unlink**:
Taking apart an established File Connection. A separate act from a Rejection: unlinking
may record one, but a link can also be undone without saying the pair was wrong.
_Avoid_: disconnect, remove, detach, reject

**Learned Pattern**:
A rule the system inferred from the user's own corrections, stored on a Partner and used
as evidence in later Matches.
_Avoid_: rule, training data, heuristic

## Resolving a line

**Category**:
The booking category a Transaction is assigned, which is what the export ultimately
carries.
_Avoid_: account, tag, class

**No-document Category**:
How a Transaction that has no File is legitimately resolved — bank fees, interest,
internal transfers, payroll, taxes, private, and so on. A stated reason no document
exists, not an excuse for a missing one.
_Avoid_: no-receipt category, exception, uncategorised, missing-receipt flag.
(Stored as `noReceiptCategoryId` / collection `noReceiptCategories` until the Postgres
port renames it — see [ADR-0001](docs/adr/0001-receipt-means-section-11-only.md).)

**VAT Treatment**:
What a No-document Category means for the UVA: `exempt-class` (zero input VAT by law),
`documented-elsewhere` (outside the report's scope), or `needs-document` (still on the
chase list — an Eigenbeleg never creates a VAT deduction). Stored today as
`needs-receipt`.

**Documentation State**:
How well a Transaction is evidenced — its Nachweis, not the noun "document": `invoice`,
`receipt-only`, `no-document-category` (stored `no-receipt-category`), `undocumented`.
Derived, never set. Files outrank a No-document Category, and an invoice outranks a
receipt, so extra Files never downgrade a line.
_Avoid_: complete, documented flag, status

**UVA**:
The Umsatzsteuervoranmeldung — the periodic VAT return the user's figures feed. FiBuKI
derives and reconciles it; it does not file it.
_Avoid_: VAT report, tax return

**BMD Export**:
The handover file the Steuerberater imports. The one artefact an advisor judges us on,
and therefore the most strictly tested thing in the codebase.
_Avoid_: export, dump, CSV

## Getting Belege in

**Mail Integration**:
A mailbox the user connected so invoices arrive on their own — one per mailbox, holding
its credentials and sync state.
_Avoid_: email account, inbox, connection

**Mail Provider**:
The implementation behind a Mail Integration — Gmail via OAuth, or generic IMAP. The
abstraction that keeps self-host on equal footing with cloud.

**Sync**:
One run that pulls new messages from a Mail Integration and turns qualifying attachments
into Files.
_Avoid_: fetch, poll, import (an **Import** is the bank side)

## Where it runs

**Cloud**:
The hosted FiBuKI at fibuki.com. Same features as self-host; what differs is verified
OAuth, bank contracts, models and compliance we have already paid for.

**Self-host**:
The user's own `docker compose up` instance. Multi-tenant code with exactly one tenant —
never a reduced build, never a separate feature set.
_Avoid_: on-prem, community edition, OSS version
