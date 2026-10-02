---
name: fibuki-onboarding
description: Get a new FiBuKI user from nothing to a working pre-accounting setup (identity, bank data, mailbox). Use when the user is new to FiBuKI, says "set me up", "get started" or "einrichten", or when list_sources / list_identity_entities come back empty.
metadata:
  short-description: Set up FiBuKI step by step
---

# FiBuKI onboarding

FiBuKI is pre-accounting for Austrian one-person businesses (EPU): bank lines, invoices and the Matches between them, prepared so the user's Steuerberater gets clean data. It is not bookkeeping, not tax filing and not an invoicing tool.

Answer in the user's language (German or English). Use FiBuKI's own words: Beleg (File), Vorschlag (Match), Zuordnung (File Connection), Deckung (Coverage), Kategorie ohne Beleg (No-document Category), Postfach (Mail Integration). Say "match confidence", never a bare "confidence".

## The checklist

Work out where the user stands from three reads, show them as one short checklist, then do the first open step. Do not interview the user up front.

1. `get_automation_status`: plan and which tools the plan allows.
2. `list_identity_entities`: is there an entity with name, UID (vatId) and IBANs?
3. `list_sources`: is there at least one Bank Account, and does `list_transactions` (limit 1) return anything?

| Step | Done when | What to do |
|---|---|---|
| Identity | an entity has a name and, for a business, a UID and its own IBANs | below |
| Bank data | a Bank Account has Transactions | the `fibuki-bank-csv` skill |
| Postfach | the user says a mailbox is connected | below |
| First Belege | some Transactions have Files | the `fibuki-belege` skill |

## Identity comes first

Why it matters, in one line to the user: without it FiBuKI cannot tell the user's own issued invoices from invoices they receive, and would match their own outgoing invoices to their expenses.

- Entity exists but is incomplete: ask for what is missing (name, UID like ATU12345678, own IBANs, other names the business uses, address) and write it with `update_identity_entity`. Show the patch first and apply it after the user agrees.
- No entity at all: `update_identity_entity` can only change an existing one. Send the user to https://fibuki.com/settings/identity and continue when they are back (re-read `list_identity_entities`).
- The user may offer one of their own issued invoices. Read name, UID, IBAN and address off it and propose those values; never save without confirmation.

## Bank data

If there is no Bank Account, ask whether they have a CSV export from their bank. If yes, hand over to `fibuki-bank-csv`. If they want a live bank connection (PSD2), send them to https://fibuki.com/sources because that needs a bank login redirect that cannot happen in chat.

## Postfach: where invoices come from

Explain the choice once, plainly:

- **FiBuKI's own Postfach** (Integrations, Gmail or IMAP) is the recommended default. It keeps syncing in the background after this chat ends, so new invoices are waiting next time. Setup needs a login redirect, so send them to https://fibuki.com/integrations/gmail (or `/integrations/imap`).
- **Your mailbox through this assistant**: if the user has connected Gmail, Outlook, Google Drive or Dropbox to their AI assistant, the `fibuki-belege` skill can search those during a session and upload what it finds. That also works, and assistants can run it in the background too. It is the user's choice; do not push.

FiBuKI has no tool that lists Postfächer, so ask the user instead of guessing.

## Finish

End with a three-line status: what is set up, what is next, and the one sentence they can say to continue ("Mach meinen letzten Monat fertig" / "Match my last month").

## Rules

- Never delete a Transaction. If asked: Transactions leave only with their whole Bank Account; offer a note or a Kategorie ohne Beleg instead.
- Amounts are integer cents, negative is an expense.
- If a tool answers that the plan does not include a feature, say so once, plainly, and continue with what is allowed.
