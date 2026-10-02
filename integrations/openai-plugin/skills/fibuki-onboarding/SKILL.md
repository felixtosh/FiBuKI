---
name: fibuki-onboarding
description: Get a new FiBuKI user from nothing to a working pre-accounting setup (identity, bank data, mailbox). Use when the user is new to FiBuKI, says "set me up", "get started" or "einrichten", or when get_onboarding_status shows open steps.
metadata:
  short-description: Set up FiBuKI step by step
---

# FiBuKI onboarding

FiBuKI is pre-accounting for Austrian one-person businesses (EPU): bank lines, invoices and the Matches between them, prepared so the user's Steuerberater gets clean data. It is not bookkeeping, not tax filing and not an invoicing tool.

Answer in the user's language (German or English). Use FiBuKI's own words: Beleg (File), Vorschlag (Match), Zuordnung (File Connection), Deckung (Coverage), Kategorie ohne Beleg (No-document Category), Postfach (Mail Integration). Say "match confidence", never a bare "confidence".

## The checklist

One call tells you where the user stands, using the same rules as the FiBuKI web app:

`get_onboarding_status` (pass `origin`: `"chatgpt"`, `"codex"` or `"claude"`, whichever assistant you are, so FiBuKI remembers where the user came from). It returns the steps, each `done`, `skipped` or `open`, with the page on fibuki.com where it is done, and the current step. Call it at the start, and again after the user finished something; it records steps their data has completed. It starts onboarding for a new user.

Show the result as one short checklist, then do the current step. Do not interview the user first. Also `get_automation_status` once, for the plan and which tools it allows.

| Step id | Meaning | What to do |
|---|---|---|
| `set_identity` | name, UID, own IBANs | below |
| `connect_email` | Postfach | below |
| `add_bank_account`, `import_transactions` | bank data | the `fibuki-bank-csv` skill |
| `assign_partner`, `attach_file` | first Belege | the `fibuki-belege` skill |

If the user does not want a step, `skip_onboarding_step` (only on their say-so). Never skip the identity step for them.

## Identity comes first

Why it matters, in one line to the user: without it FiBuKI cannot tell the user's own issued invoices from invoices they receive, and would match their own outgoing invoices to their expenses.

`list_identity_entities` shows what exists.

- **Nothing yet:** ask for what is needed (name as it appears on invoices; UID like ATU12345678 if they have one; their own IBANs; other names the business uses; address), show exactly what you will save, and on their yes call `create_identity_entity` (`type`: `person` for a freelancer, `company` for a business; a business owner often has both). The user may offer one of their own issued invoices: read name, UID, IBAN and address off it and propose those values.
- **Exists but incomplete:** `update_identity_entity` with a patch of what is missing, after showing it.
- Never save without confirmation. After saving, call `get_onboarding_status`; the identity step is done.

## Bank data

If there is no Bank Account, ask whether they have a CSV export from their bank. If yes, hand over to `fibuki-bank-csv`. If they want a live bank connection (PSD2), send them to https://fibuki.com/sources because that needs a bank login redirect that cannot happen in chat.

## Postfach: where invoices come from

Explain the choice once, plainly:

- **FiBuKI's own Postfach** (Integrations, Gmail or IMAP) is the recommended default. It keeps syncing in the background after this chat ends, so new invoices are waiting next time. Setup needs a login redirect, so send them to https://fibuki.com/integrations/gmail (or `/integrations/imap`).
- **Your mailbox through this assistant**: if the user has connected Gmail, Outlook, Google Drive or Dropbox to their AI assistant, the `fibuki-belege` skill can search those during a session and upload what it finds. That also works, and assistants can run it in the background too. It is the user's choice; do not push.

FiBuKI has no tool that lists Postfächer, so ask the user instead of guessing. If they choose their assistant's mail over FiBuKI's, skip the step with `skip_onboarding_step` (`connect_email`).

## Finish

End with a three-line status: what is set up, what is next, and the one sentence they can say to continue ("Mach meinen letzten Monat fertig" / "Match my last month").

## Rules

- Never delete a Transaction. If asked: Transactions leave only with their whole Bank Account; offer a note or a Kategorie ohne Beleg instead.
- Amounts are integer cents, negative is an expense.
- If a tool answers that the plan does not include a feature, say so once, plainly, and continue with what is allowed.
