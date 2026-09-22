---
status: accepted
date: 2026-09-11
---

# English names, German meaning: how a headword's language is chosen

`CONTEXT.md` was bilingual by instinct: 34 English headwords, one German
(**Steuerberater**), one citation (**§ 11 Element**), and a section heading that said
"Belege" over an entry named **File**. Nothing recorded which language a new concept
takes, so every new term re-argued it (#133), and where German was the precise word the
English one imported a concept Austrian tax law does not have (#134).

The proposed rule was two-way: German wins for legal or tax artefacts the User and the
Tax Advisor share a word for, English for FiBuKI-internal constructs. It predicts *Beleg*
over **File**, *Belegart* over **Document Type**, *Kassenbeleg* over **Receipt** — three of
the most-used identifiers in the codebase renamed, and ADR-0001's move (keep "receipt",
pin its meaning to § 11) undone. Rejected.

## Decision

Two questions, not one.

**Which language draws the concept's boundary?** German, wherever Austrian law or practice
already has one. That word is recorded on the entry as `_Deutsch (defining)_`, and the
English headword names *that* concept and nothing wider. **Receipt** is a Zahlungsbeleg,
not "any receipt"; **Due Date** is a Fälligkeitsdatum, not a Zahlungsziel.

**Which word is the name?** English by default, because code, issues and tests are English
and the Tax Advisor never reads them. German is the name only for proper nouns of Austrian
artefacts you would write in capitals (UVA, BMD, FinanzOnline, Kennzahl 060) and for law
citations (§ 11 UStG, BAO § 132). Those carry `_English_: none, cite verbatim`. Everything
else translates, from this source order: the EU VAT Directive's English first (input VAT
for Vorsteuer, VAT ID for UID, VAT rate for Steuersatz, simplified invoice for
Kleinbetragsrechnung, reverse charge), then the Austrian body's own English (the KSW's
"tax adviser"), then our coinage. A German citation appears in brackets on first use in
English prose and is not repeated.

Three classes fall out, and every entry states which it is in, so an absent counterpart is
a decision and not an omission:

1. English name, German defines: Receipt / Zahlungsbeleg, Document Type / Belegart,
   Invoice Correction / Rechnungskorrektur, Tax Advisor / Steuerberater.
2. English name, German is only the interface word: Match / Vorschlag, Bank Account /
   Bankkonto, Sync / Synchronisierung.
3. German name, never translated: UVA, BMD Export, § 11.

Identifiers follow the name. A class-3 word appears in code ASCII-folded and untranslated
(`Uva`, `Vorsteuer` in the UVA trace); a class-1 or class-2 word appears in English
(`taxAdvisor`, never `steuerberater`). Existing identifiers are not renamed for this —
vocabulary first, storage later, as ADR-0001 set out.

## What the rule decided on contact

- **Steuerberater** becomes **Tax Advisor**. The profession has an English name its own
  chamber uses; keeping the German made it a citation it is not.
- **Vorsteuer** is *input VAT* in English copy. #229 kept it German because an operator
  quotes it verbatim to a supplier. That is the outgoing-correspondence rule below, not a
  naming rule, and `uva-preview` already renders "Input VAT from invoices (Vorsteuer)".
  The same applies to Steuersatz, UID, Kleinbetragsrechnung and the nine element names,
  which amends the brief in #237.
- **Source** becomes **Bank Account**. It was the one glossary term the interface ignored
  (the page already said "Bank Accounts"), and the "match source" collision goes with it.
- **Receipt** is *not* a Kassenbeleg. The classifier treats a Registrierkasse receipt up
  to 400 EUR with a VAT rate as a simplified invoice (§ 11 Abs 6) and therefore as an
  invoice with a deduction. The German for the no-deduction class is Zahlungsbeleg, and
  the old definition text was wrong.
- **File** keeps its name and takes *Beleg* as its interface word. A separate legal-object
  entry was considered and dropped: no consumer needs "a File that is legally a Beleg"
  as a named thing, Documentation State already says it per Transaction.
- **Gutschrift** names two documents. In commerce it is the credit note; in § 11 Abs 7
  UStG it is an invoice written by the recipient. A File titled Gutschrift is either a
  supplier's **Invoice Correction** (expense goes down) or a **Self-billed Invoice**
  (the User's own revenue, written for them). Both are headwords so the Extraction has a
  name for each; "credit note" stays avoided in our own copy because it is the word that
  produces the wrong label.

## Consequences

- **Which language a string takes is the reader's fact, not the glossary's.** Interface
  chrome follows the interface locale through the message catalogue, using the
  `_Deutsch_` word. Class-3 terms never translate in any locale. **Outgoing text follows
  its recipient**: a mail to an Austrian supplier is German whatever locale the User
  reads the app in. The product's own locale (German app, English app, bilingual) is
  #168 and #175, not this record.
- **A headword does not absorb a presentation problem.** #229's request to rename Document
  Type to "Eligibility" was a complaint about what the screen said first. Lead with the
  consequence and leave the word alone.
- **Dose, not presence.** Every German term in #229's summaries was individually
  defensible and the result still read as Denglish, because citations had been folded
  into English sentences. The rule says which words stay German; it does not license
  sprinkling them.
- **`_Also printed as_` is load-bearing.** The Extraction is prompt-driven, so an unlisted
  synonym is a field that silently fails to extract, not a style slip. The list is chosen
  from the domain, not from the sample in front of you: Fälligkeitsdatum is the term,
  Zahlungstermin is one issuer's synonym.
- **The two Avoid lists are different sets.** German `_Avoid (de)_` carries only words
  that name a different concept (Zahlungsziel is a period, Umsatz is turnover, Teilwert is
  § 6 EStG); the English `_Avoid_` also carries style. Asymmetry is expected: German
  *requires* Position where English avoids it.
- **Every new concept has its pair settled before code is written**, in `CONTEXT.md`,
  with its class stated. `docs/agents/domain.md` tells the skills to enforce it.
