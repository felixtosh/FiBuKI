# FiBuKI

Pre-accounting for Austrian one-person businesses (EPUs): turn the pile of Files (Belege)
and bank lines into something a Tax Advisor can book without cleaning it up first.
This glossary is the project's ubiquitous language — issues, tests, UI copy and code
should use these words and avoid the listed synonyms.

Some entries describe code that is still landing. The § 11 classifier
(`classifyDocumentType.ts`), Documentation State (`documentationState.ts`) and the single
rejection list (`dismissSuggestionOps.ts`) arrive with their lanes — see the map,
"One trunk: land the fork on main and retire the fork" (#93). The vocabulary lands first
on purpose: every lane review is written in it.

Scope note: this file is a glossary, not a spec. Positioning lives in
[`docs/who-is-this-for.md`](docs/who-is-this-for.md), the rebuild plan in
[`docs/rewrite-goals.md`](docs/rewrite-goals.md), decisions in [`docs/adr/`](docs/adr/).

## How to read an entry

Every concept has a name in both languages, chosen by
[ADR-0007](docs/adr/0007-english-names-german-meaning.md). The headword is the name used
in code, issues, tests and English copy. The lines under it say what German does:

- `_Deutsch_: Vorschlag` — the word German copy and the message catalogue use. Nothing more.
- `_Deutsch (defining)_: Zahlungsbeleg` — the German word draws the concept's boundary,
  because Austrian law or practice already has one. The English headword names that
  Austrian concept and nothing wider.
- `_English_: none, cite verbatim` — a proper noun or a law citation. Never translated, in
  any locale; quoted once in English prose, not folded into it.
- `_Also printed as_:` — the words a document may print for this concept. The Extraction
  must read every one of them; an unlisted synonym is a field that silently fails.
- `_Avoid (de)_:` — German words that name a *different* concept. The English `_Avoid_`
  carries style synonyms too; the German list is only for legal near-misses.

## People

**User**:
The Austrian EPU or freelancer whose books these are. Owns every record in the system;
all data is scoped to one user.
_Deutsch_: Benutzer
_Avoid_: customer, client, account holder
_Avoid (de)_: Kunde, Mandant (that is what the User is to their Tax Advisor)

**Tax Advisor**:
The user's Steuerberater, the profession regulated by the WTBG. Invited read-only, never
charged, and never a tenant of their own — a gatekeeper we must satisfy, not a buyer we
sell to.
_Deutsch (defining)_: Steuerberater
_Avoid_: accountant, bookkeeper, advisor bare, Kanzlei user
_Avoid (de)_: Buchhalter (a different profession), Kanzlei (the firm, not the person),
Wirtschaftsprüfer

**Partner**:
A business the user transacts with, as that user knows it — one record per user, holding
the IBANs, VAT ID, domains and learned patterns that identify it. On a File, the Partner
is always the business that **did the work** (the Leistungserbringer), never the business
that happened to write the document. See
[ADR-0003](docs/adr/0003-partner-is-the-supplier.md).
_Deutsch_: Partner
_Avoid_: vendor, supplier, merchant, counterparty, contact
_Avoid (de)_: Lieferant (a Partner may be a customer), Kunde, Kontakt

**Global Partner**:
The cross-user record a Partner may link to, built from what many users contributed.
Suggests identifying data; never owns a user's decisions.
_Deutsch_: Globaler Partner
_Avoid_: master partner, global vendor

**Merge**:
Folding one Partner into another because they are the same business. The survivor keeps
the values it has, fills its empty ones from the loser, takes the loser's name as an
alias, and takes over what pointed at the loser. What an issued Invoice froze at issue
time stays frozen. One way: there is no unmerge.
_Deutsch_: Zusammenführen
_Avoid_: dedupe, combine, link partners
_Avoid (de)_: Verknüpfen, Duplikat entfernen

**Merged Partner**:
What a merge leaves behind: an inactive Partner that names its survivor, so an ID handed
out before the merge still resolves. Never a match candidate, never in the Partner list.
_Deutsch_: Zusammengeführter Partner
_Avoid_: deleted partner, ghost partner, alias record

## Money coming in

**Bank Account**:
An account Transactions arrive from — a bank account, a card account, or a depot. Every
Transaction belongs to exactly one.
_Deutsch_: Bankkonto
_Avoid_: source, account bare, bank, connection, feed. (Stored as `sources`; the rename is
deferred, as in [ADR-0001](docs/adr/0001-receipt-means-section-11-only.md).)
_Avoid (de)_: Konto bare (a Tax Advisor's Konto is a Sachkonto), Quelle, Bankverbindung
(the IBAN details, not the account)

**Transaction**:
One booked line from a Bank Account: date, amount in cents with a normalised sign
(negative = money out), booking text, counterparty text. The bank's words, kept as
imported.
_Deutsch_: Transaktion
_Avoid_: booking, entry, payment, line item
_Avoid (de)_: Umsatz (turnover, to a Tax Advisor), Buchung (the Tax Advisor's act),
Zahlung

**Import**:
One batch of Transactions taken in at once, from a CSV or a connector, retaining the raw
columns so a parse can be re-read later.
_Deutsch_: Import
_Avoid_: upload, sync (a **Sync** is the mailbox side)
_Avoid (de)_: Upload, Synchronisierung

## Evidence coming in

**File**:
Something the user received or uploaded. The unit that gets extracted, classified and
matched. One word for one thing: a File whose Document Type is `other`, or whose
Extraction failed, is still a File.
_Deutsch_: Beleg
_Avoid_: document, receipt, attachment, Beleg (in code and English copy). The single
exception is **Document Type**, where "document" names the File itself; the word appears
nowhere else in that sense. **Documentation State** is unrelated — see its entry.
_Avoid (de)_: Datei, Dokument, Anhang, Rechnung (a File need not be one)

**Purge**:
Destroying a deleted File for good: the document and its stored bytes are gone, and only
the keys that stop it being imported again survive. Deleting a File hides it and can be
undone; purging is the only act in the system that cannot.
_Deutsch_: Endgültig löschen
_Avoid_: hard delete, permanent delete, wipe

**Document Type**:
What a File is under § 11 UStG: `invoice`, `receipt`, `other`, or `unknown`. Decides
whether the File can carry an input VAT (Vorsteuer) deduction. A reverse-charge document
is an invoice; so is a simplified invoice (Kleinbetragsrechnung, § 11 Abs 6).
**Derived, never hand-set**: the § 11 classifier is its only writer, and it re-decides on
every classification. The user's one lever is `isNotInvoice`, a stored flag that is an
*input* to that classifier rather than a rival field — it reaches `other` and nothing
else. A user can say "this is not a financial document", which they know better than the
classifier does; they cannot declare a document § 11-complete, because that judgement is
what the tool is for and a wrong one becomes a wrong input VAT claim in their own name.
_Deutsch (defining)_: Belegart — Rechnung, Zahlungsbeleg, Sonstiges, Nicht bestimmt
_Avoid_: kind, category (a **Category** is the booking category), eligibility (what a
type *means* for input VAT, not what the File is)
_Avoid (de)_: Dokumenttyp, Dateityp

**Receipt**:
A File that is a document but neither a § 11-complete invoice nor a simplified invoice —
proof of spend that never carries an input VAT deduction. "Receipt" has this one meaning
and is never the everyday word for an incoming document; that word is **File**. See
[ADR-0001](docs/adr/0001-receipt-means-section-11-only.md).
_Deutsch (defining)_: Zahlungsbeleg
_Also printed as_: Quittung, Zahlungsbestätigung, Kontoauszug, Kreditkartenbeleg,
Kassabon (only when the § 11 Abs 6 elements are missing)
_Avoid_: receipt as a synonym for Beleg, voucher, proof of purchase
_Avoid (de)_: Kassenbeleg (a Registrierkasse receipt up to 400 EUR with a VAT rate is
usually a simplified invoice, so an *invoice*), Beleg (the wider set), Rechnung

**§ 11 Element**:
One of the nine things § 11 UStG requires an invoice to print (issue date, supplier name
and address, description, VAT rate (Steuersatz), invoice number, supplier VAT ID (UID),
recipient, recipient VAT ID). Their absence is what demotes a document to a Receipt.
_Deutsch (defining)_: Rechnungsmerkmal
_Avoid_: required field, invoice attribute
_Avoid (de)_: Pflichtangabe (any legally required statement, wider than § 11), Merkmal bare

**Invoice**:
A § 11 document the User issues to a Partner, numbered and immutable once issued. An
invoice the User *receives* is a File with Document Type `invoice`, not an Invoice.
_Deutsch (defining)_: Ausgangsrechnung
_Also printed as_: Rechnung, Honorarnote, Faktura, Invoice
_Avoid_: bill, outgoing document
_Avoid (de)_: Eingangsrechnung (that is a File), Rechnung bare when the direction matters

**Invoice Correction**:
A document that reduces or cancels an earlier Invoice by referencing its number and
carrying the negative amounts; the original is never edited. Under § 11 it is itself an
invoice, so an incoming one is a File with Document Type `invoice`. A full cancellation is
a correction over the whole amount, not a second concept; **Cancel** is the act that
issues one. The re-issued document with the corrected figures is simply a new Invoice.
_Deutsch (defining)_: Rechnungskorrektur
_Also printed as_: Stornorechnung, Storno, Korrekturrechnung, Gutschrift, Credit Note
(a Gutschrift that references an invoice and carries the opposite sign)
_Avoid_: credit note, refund, reversal, void
_Avoid (de)_: Gutschrift in our own copy (that is a **Self-billed Invoice**), Stornobeleg
(the cash-register term), Rechnungsänderung (implies editing)

**Self-billed Invoice**:
An Invoice written by the *recipient* of the supply in the supplier's name, which § 11
Abs 7 UStG treats as the supplier's invoice. For the User it is an incoming File that is
their own outgoing invoice — a platform payout statement is the common case — so it is
revenue, not a reduced expense. Told from an Invoice Correction by the sign and the
absence of a referenced invoice number.
_Deutsch (defining)_: Gutschrift (§ 11 Abs 7)
_Also printed as_: Gutschrift, Abrechnung, Auszahlung, Self-billing invoice
_Avoid_: credit note, payout
_Avoid (de)_: Rechnungskorrektur (that is the other Gutschrift), Gutschein

**Dunning Letter**:
A document demanding payment of an Invoice already due. It states no new supply, so it
is never an invoice and carries no VAT (Mahnspesen and Verzugszinsen are outside VAT).
Incoming, it is a File with Document Type `other` that the Extraction must not read as a
second copy of the invoice it names; outgoing, what the User would send for their own
overdue Invoice.
_Deutsch (defining)_: Mahnung
_Also printed as_: Zahlungserinnerung, 1. Mahnung, 2. Mahnung, letzte Mahnung,
Mahnschreiben, Zahlungsaufforderung
_Avoid_: payment reminder as the concept (a Zahlungserinnerung is its first stage),
overdue notice, collection letter
_Avoid (de)_: Inkasso (third-party collection), Mahnspesen (a fee it may carry), Rechnung

**Invoicing Agent**:
A business that writes a File in the name of another, as § 11 Abs 2 UStG permits (Uber
Austria GmbH for a taxi operator). Recorded on the Extraction under a fixed field name,
UID and all. Never a Partner, never matched against a Transaction, never part of an
input VAT trail.
_Deutsch (defining)_: Abrechnender Dritter (§ 11 Abs 2)
_Avoid_: issuer platform, service provider, billing partner
_Avoid (de)_: Rechnungsaussteller (every issuer, including the Partner), Plattform

**Extraction**:
The structured facts read off a File — entities, dates, amounts, line items, rate groups
— together with how they were obtained. One File has one current Extraction.
_Deutsch_: Extraktion
_Avoid_: parse, OCR result, AI output
_Avoid (de)_: OCR, KI-Ergebnis, Erkennung, Erfassung (manual entry at the Tax Advisor's desk)

**Line Item**:
One priced row transcribed from a File's body.
_Deutsch_: Position (the word English avoids is the one German requires)
_Avoid_: position, row, item
_Avoid (de)_: Zeile, Artikel

**Rate Group**:
One row of the VAT summary block the document itself prints (rate, net, VAT, gross). Read
off the document, never derived from Line Items.
_Deutsch_: Steuersatzzeile
_Also printed as_: MwSt.-Aufstellung, USt-Zusammenfassung, Steuersätze
_Avoid_: VAT breakdown, tax group, summary row
_Avoid (de)_: USt-Aufschlüsselung, Steuergruppe

**Due Date**:
The date by which the User must pay an invoice. A deadline, not a payment date, and not
the date the money moved. Chosen from the domain, not from the sample: one issuer's
"Zahlungstermin" is a synonym, not the term.
_Deutsch (defining)_: Fälligkeitsdatum
_Also printed as_: Zahlungstermin, fällig am, zahlbar bis, Zahlbar ohne Abzug bis
_Avoid_: payment date, payment term, deadline bare
_Avoid (de)_: Zahlungsziel (the *period*, "14 Tage", not a date — read as a date it
yields 1970 or today), Zahldatum, Valuta

**Debit Date**:
The date a Partner states it will collect under a SEPA mandate. An obligation on the
Partner, where a Due Date is an obligation on the User; they coincide on many invoices and
diverge on others, so they are two terms. Stronger Match evidence than a Due Date,
because the bank line corroborates it. Tracked in #136.
_Deutsch (defining)_: Einzugsdatum
_Also printed as_: wird … eingezogen, Abbuchung erfolgt am, Einzug am, Lastschrift am
_Avoid_: due date, collection date, direct-debit date
_Avoid (de)_: Fälligkeitsdatum, Buchungsdatum (the bank's date, on the Transaction)

## Connecting the two

**Match**:
A candidate pairing of one File with one Transaction, carrying a Confidence and the
reasons behind it. A Match is a proposal, not a fact.
_Deutsch_: Vorschlag
_Avoid_: link, hit, candidate
_Avoid (de)_: Treffer, Zuordnung (that is the **File Connection**)

**Match Source**:
One reason a Match scored: IBAN, VAT ID, website, email domain, name, learned pattern, or
manual. Evidence, not a channel.
_Deutsch_: Grund (Zuordnungsgrund when it must stand alone)
_Avoid_: signal, channel
_Avoid (de)_: Indiz, Kriterium, Quelle, Treffer

**Confidence**:
How strongly one pairing is evidenced, 0-100. Above the auto threshold a Match becomes a
File Connection by itself; above the suggestion threshold it is shown to the user.
**Never bare** — the codebase has four unrelated confidences, so always say which:
*match confidence* (File↔Transaction), *partner match confidence* (Partner↔Transaction,
a different scorer), *extraction confidence* (how sure the extractor is — worth little,
two contradictory Uber readings both reported 100), and a Global Partner's *data
confidence* (how much the crowdsourced record is trusted).
_Deutsch_: Sicherheit, never bare either — Zuordnungssicherheit, Partnersicherheit,
Extraktionssicherheit, Stammdatensicherheit
_Avoid_: probability, rating, accuracy, a bare "confidence"
_Avoid (de)_: Wahrscheinlichkeit, Genauigkeit, Konfidenz

**Score**:
One signal's contribution to a Confidence — the points an IBAN hit, a date hit or a name
hit is worth. Scores live in a breakdown and add up; the sum is the Confidence. A Score is
never the total.
_Deutsch_: Bewertung
_Avoid_: weight, points, confidence
_Avoid (de)_: Teilwert (§ 6 EStG, a tax term), Gewichtung, Punkte

**File Connection**:
An established pairing of a File and a Transaction — the record that says this document
documents this line.
_Deutsch_: Zuordnung
_Avoid_: match (that is the candidate), attachment, link
_Avoid (de)_: Verknüpfung, Anhang, Vorschlag

**Coverage**:
How much of a Transaction its connected Files explain — their payment totals against the
bank line, as a ratio. At or above the coverage tolerance the Transaction counts as
documented and stops taking auto-connections. A ratio and not a sum, because it has to
hold for a 12 EUR line and a 12 000 EUR line alike.
_Deutsch_: Deckung
_Avoid_: covered amount, matched amount, completeness, percentage matched
_Avoid (de)_: Abdeckung, Vollständigkeit

**Remainder**:
The part of a Transaction its connected Files do not yet explain: the bank line minus
what those Files come to. It is the figure both detail panels print
(the line used to be labelled "Difference"), and what a further candidate File is scored
against — a File that closes it is a Match on
the Remainder, never an amount mismatch against the full line. At or below zero the
Transaction is fully documented, and scoring goes back to the full amount. A Match scored
against a Remainder is a suggestion unless the documents are from the same day and no
undocumented Transaction wants the File as much — see
[ADR-0008](docs/adr/0008-remainder-auto-connect-is-same-day-only.md).
_Deutsch_: Restbetrag
_Avoid_: difference, open amount, balance, remaining amount, delta
_Avoid (de)_: Differenz, offener Betrag, Saldo

**Rejection**:
The standing "this File and this Transaction do not belong together", whoever recorded it
— a click, an agent, an MCP call. Survives re-scoring and re-extraction; a rejected pair
is never proposed again. One list, one shape, one writer.
_Deutsch_: Ablehnung (the act: ablehnen)
_Avoid_: dismissal, ignore, hide, snooze. (Stored as `dismissedTransactions` on the file;
the rename is deferred — see
[ADR-0002](docs/adr/0002-rejection-is-the-word.md).)
_Avoid (de)_: Ausblenden, Verwerfen, Ignorieren

**Unlink**:
Taking apart an established File Connection. A separate act from a Rejection: unlinking
may record one, but a link can also be undone without saying the pair was wrong.
_Deutsch_: Zuordnung lösen
_Avoid_: disconnect, remove, detach, reject
_Avoid (de)_: Entfernen, Löschen, Ablehnen

**Learned Pattern**:
A rule the system inferred from the user's own corrections, stored on a Partner and used
as evidence in later Matches.
_Deutsch_: Gelerntes Muster
_Avoid_: rule, training data, heuristic
_Avoid (de)_: Regel

## Resolving a line

**Category**:
The booking category a Transaction is assigned, which is what the export ultimately
carries.
_Deutsch_: Kategorie
_Avoid_: account, tag, class
_Avoid (de)_: Konto, Sachkonto (what the Tax Advisor books it to, downstream of us), Tag

**No-document Category**:
How a Transaction that has no File is legitimately resolved — bank fees, interest,
internal transfers, payroll, taxes, private, and so on. A stated reason no document
exists, not an excuse for a missing one.
_Deutsch_: Kategorie ohne Beleg
_Avoid_: no-receipt category, exception, uncategorised, missing-receipt flag.
(Stored as `noReceiptCategoryId` / collection `noReceiptCategories`; the rename is
deferred — see [ADR-0001](docs/adr/0001-receipt-means-section-11-only.md).)
_Avoid (de)_: Eigenbeleg (a document the User writes, which is the opposite of having
none), Ausnahme

**VAT Treatment**:
What a No-document Category means for the UVA: `exempt-class` (zero input VAT by law),
`documented-elsewhere` (outside the report's scope), or `needs-document` (still on the
chase list — an Eigenbeleg never creates an input VAT deduction). Stored today as
`needs-receipt`.
_Deutsch_: UVA-Wirkung — kein Vorsteuerabzug, nicht UVA-relevant, Beleg ausständig
_Avoid_: tax code, VAT status
_Avoid (de)_: USt-Behandlung, Steuercode, Steuerschlüssel (the Tax Advisor's BMD codes,
downstream of us)

**Documentation State**:
How well a Transaction is evidenced — its Nachweis, not the noun "document": `invoice`,
`receipt-only`, `unknown` (holds Files whose type could not be established),
`no-document-category` (stored `no-receipt-category`), `undocumented`. Derived, never
set. Files outrank a No-document Category, and an invoice outranks a receipt, so extra
Files never downgrade a line. Not the same as `isComplete`, which means only "has some
documentation" and can be set by hand — see
[ADR-0004](docs/adr/0004-is-complete-is-not-documentation-state.md).
_Deutsch_: Nachweis — Rechnung, nur Zahlungsbeleg, unbestimmt, Kategorie ohne Beleg,
kein Nachweis
_Avoid_: complete, documented flag, status
_Avoid (de)_: Status, Vollständigkeit, Belegstatus

**UVA**:
The Umsatzsteuervoranmeldung — the periodic VAT return the user's figures feed. FiBuKI
derives and reconciles it; it does not file it.
_English_: none, cite verbatim
_Avoid_: VAT report, tax return, advance VAT return
_Avoid (de)_: USt-Meldung, Steuererklärung (the annual one)

**BMD Export**:
The handover file the Tax Advisor imports. The one artefact an advisor judges us on,
and therefore the most strictly tested thing in the codebase.
_English_: none, cite verbatim
_Avoid_: export, dump, CSV
_Avoid (de)_: Export bare, Übergabe

## Getting Files in

**Mail Integration**:
A mailbox the user connected so invoices arrive on their own — one per mailbox, holding
its credentials and sync state.
_Deutsch_: Postfach
_Avoid_: email account, inbox, connection
_Avoid (de)_: E-Mail-Konto, Posteingang

**Mail Provider**:
The implementation behind a Mail Integration — Gmail via OAuth, or generic IMAP. The
abstraction that keeps self-host on equal footing with cloud.
_Deutsch_: Mailanbieter
_Avoid_: mail service, backend
_Avoid (de)_: Anbieter bare, Dienst

**Sync**:
One run that pulls new messages from a Mail Integration and turns qualifying attachments
into Files.
_Deutsch_: Synchronisierung (the act: synchronisieren — Gmail's own word)
_Avoid_: fetch, poll, import (an **Import** is the bank side)
_Avoid (de)_: Abruf, Import, Laden

## Where it runs

**Cloud**:
The hosted FiBuKI at fibuki.com. Same features as self-host; what differs is verified
OAuth, bank contracts, models and compliance we have already paid for.
_Deutsch_: Cloud
_Avoid_: SaaS edition, hosted version
_Avoid (de)_: gehostete Version

**Self-host**:
The user's own `docker compose up` instance. Multi-tenant code with exactly one tenant —
never a reduced build, never a separate feature set.
_Deutsch_: Self-host
_Avoid_: on-prem, community edition, OSS version
_Avoid (de)_: On-Premise, Eigenbetrieb, Community-Version
