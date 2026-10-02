# Privacy policy: draft wording for the assistant connections (FOR REVIEW)

Status: draft. NOT applied to `messages/en.json` / `messages/de.json`, so nothing here is live. It is legal text for
Infinity Vertigo GmbH: a lawyer or the data protection contact signs off before it is applied. Each block names where it
goes (`privacy.sections.*` keys; the German text is formal "Sie", like the rest of the page).

`[CONFIRM]` marks a statement of fact I could not verify from the code; answer each before applying. `[DECISION]` marks
something that needs a choice, not a lookup.

## Questions to answer first

1. `[CONFIRM]` Hosting. The page says Firebase / Google Cloud europe-west1. fibuki.com has run on a Hetzner server in
   Nuremberg (`nbg1`) since the W4 cutover, per `deploy/selfhost/README-hetzner.md`. Which processors still apply
   (Firebase retained for rollback only?), and where are files and the database stored today? This changes
   `services`, `internationalTransfers`, `dataProtection.*` and the encryption sentence, not just the new blocks.
2. `[CONFIRM]` Does a user see and revoke an assistant connection under Settings > API keys? (The code revokes by key; I did
   not check that OAuth connections are listed there.) Block C names the path.
3. `[DECISION]` Retention for access requests (block D). Code keeps them until an admin acts or the person registers;
   nothing deletes them. Proposed: 90 days after they are resolved or, if never resolved, 12 months. Needs a job.
4. `[CONFIRM]` Is OpenAI a processor you have a DPA with for this, or is the assistant provider simply the user's own
   counterparty (the user chose to send their data there)? Block A assumes the second.

## A. New third parties: assistants (add to `services` and `internationalTransfers`)

`services.assistants` (new entry, after `anthropic`)

EN, name: `AI assistants you connect (OpenAI ChatGPT and Codex, Anthropic Claude)`
EN, purpose: `Only if you connect one of them to FiBuKI. The assistant can read data from your FiBuKI account and make
changes in it on your instruction, and you can send it documents to add. The provider processes that data under your own
agreement with them, not on our behalf. You can disconnect at any time.`

DE, name: `KI-Assistenten, die Sie verbinden (OpenAI ChatGPT und Codex, Anthropic Claude)`
DE, purpose: `Nur wenn Sie einen davon mit FiBuKI verbinden. Der Assistent kann auf Ihre Anweisung Daten aus Ihrem
FiBuKI-Konto lesen, Änderungen darin vornehmen und Dokumente von Ihnen entgegennehmen. Der Anbieter verarbeitet diese Daten
auf Grundlage Ihrer eigenen Vereinbarung mit ihm, nicht in unserem Auftrag. Sie können die Verbindung jederzeit trennen.`

`internationalTransfers.content`: add one bullet after the Anthropic bullet.

EN: `• OpenAI and Anthropic (connected assistants): If you connect ChatGPT, Codex or Claude, the data the assistant requests
from your FiBuKI account is sent to that provider's servers, which may be in the United States. You start this transfer
yourself by connecting the assistant and by asking it to work with your data. The provider's terms and privacy policy
apply to what it receives.`

DE: `• OpenAI und Anthropic (verbundene Assistenten): Wenn Sie ChatGPT, Codex oder Claude verbinden, werden die Daten, die der
Assistent aus Ihrem FiBuKI-Konto abruft, an die Server des jeweiligen Anbieters übermittelt, die sich in den Vereinigten
Staaten befinden können. Sie lösen diese Übermittlung selbst aus, indem Sie den Assistenten verbinden und ihn mit Ihren Daten
arbeiten lassen. Für das, was der Anbieter erhält, gelten dessen Nutzungsbedingungen und Datenschutzerklärung.`

## B. What an assistant can reach (add to `dataCollection.content`, one bullet)

EN: `• Assistant connection data: If you connect an AI assistant, the data it asks for from your account (for example
transactions, partners, document names and the details read from documents) is passed to it, and documents or bank exports
you give it are added to your account. We record that the assistant acted, which assistant you came from when you signed
up, and the technical details of the connection (see "Connected assistants" below).`

DE: `• Daten der Assistentenverbindung: Wenn Sie einen KI-Assistenten verbinden, werden die Daten, die er aus Ihrem Konto
anfordert (zum Beispiel Transaktionen, Partner, Dokumentnamen und die aus Dokumenten gelesenen Angaben), an ihn übergeben,
und Dokumente oder Bankexporte, die Sie ihm geben, werden Ihrem Konto hinzugefügt. Wir speichern, dass der Assistent
gehandelt hat, über welchen Assistenten Sie sich angemeldet haben und die technischen Angaben der Verbindung (siehe
"Verbundene Assistenten" unten).`

`legalBasis.content`, add to the contract bullet or as a new bullet:

EN: `• Contract performance (Art. 6(1)(b)) and your instruction: Passing data to an assistant you connected is a function you
asked for. Connecting is voluntary and you can end it at any time.`

DE: `• Vertragserfüllung (Art. 6 Abs. 1 lit. b) und Ihre Anweisung: Die Übergabe von Daten an einen von Ihnen verbundenen
Assistenten ist eine Funktion, die Sie ausdrücklich nutzen. Die Verbindung ist freiwillig und kann jederzeit beendet werden.`

## C. New section "Connected assistants" (after `googleUserData`, before `internationalTransfers`)

Title EN `Connected assistants` / DE `Verbundene Assistenten`. Content:

EN:
```
You can connect FiBuKI to an AI assistant such as ChatGPT, Codex or Claude. To do that you sign in to FiBuKI and approve
the connection on a FiBuKI page.

What we store for a connection:
• The connection's access and refresh tokens, only as one-way hashes. An access token is valid for one hour and a refresh
  token for 30 days. A one-time authorization code lives for 10 minutes.
• The name and redirect addresses the assistant registered, and when the connection was made and last used.
• Which assistant you came from when you signed up (web, ChatGPT, Claude, Codex), to show you the right next steps.

What the assistant can do: it uses the same functions as the FiBuKI app, such as listing and changing transactions, files,
partners, bank accounts and invoices. Individual transactions cannot be deleted. FiBuKI does not decide what the assistant
sends on to its provider.

Ending a connection: remove it under Settings > API keys [CONFIRM]. Its tokens stop working immediately. Deleting your
account removes all connections and their records.
```

DE:
```
Sie können FiBuKI mit einem KI-Assistenten wie ChatGPT, Codex oder Claude verbinden. Dazu melden Sie sich bei FiBuKI an und
bestätigen die Verbindung auf einer FiBuKI-Seite.

Was wir für eine Verbindung speichern:
• Zugriffs- und Aktualisierungstoken der Verbindung, nur als Einweg-Hashwerte. Ein Zugriffstoken ist eine Stunde gültig, ein
  Aktualisierungstoken 30 Tage. Ein einmaliger Autorisierungscode gilt 10 Minuten.
• Den Namen und die Weiterleitungsadressen, die der Assistent registriert hat, sowie wann die Verbindung hergestellt und
  zuletzt genutzt wurde.
• Über welchen Assistenten Sie sich angemeldet haben (Web, ChatGPT, Claude, Codex), damit wir Ihnen die passenden nächsten
  Schritte zeigen.

Was der Assistent kann: Er nutzt dieselben Funktionen wie die FiBuKI-App, etwa Transaktionen, Dateien, Partner, Bankkonten
und Rechnungen auflisten und ändern. Einzelne Transaktionen lassen sich nicht löschen. Was der Assistent an seinen Anbieter
weitergibt, bestimmt FiBuKI nicht.

Verbindung beenden: Entfernen Sie sie unter Einstellungen > API-Schlüssel [CONFIRM]. Die Token funktionieren sofort nicht mehr.
Beim Löschen Ihres Kontos werden alle Verbindungen und ihre Datensätze entfernt.
```

`dataProtection.retention.content`: the bullet "OAuth tokens for connected services (e.g., Gmail) are revoked ..." already
exists; extend it. EN: `... (e.g., Gmail, ChatGPT, Claude) are revoked or deleted ...`; DE: `... (z.B. Gmail, ChatGPT, Claude)
werden widerrufen bzw. gelöscht ...`. (This is true as of the commit that added `apiKeys` to account deletion; before
it, assistant connections survived account deletion. See "Code fix" below.)

## D. Access requests (add to `dataCollection.content`, one bullet, and to `dataProtection.retention.content`)

If a person tries to sign in without an invite and no open seat is left, we keep their email address, name, profile picture
URL (from Google) and the time, so an admin can invite them.

EN, dataCollection: `• Access requests: If you try to sign in without an invitation, we store your email address, the name
and profile picture your sign-in provider gave us, and the time of your request, so we can invite you.`
EN, retention: `• Access requests are deleted 90 days after they are answered, and after 12 months at the latest. [DECISION]`

DE, dataCollection: `• Zugangsanfragen: Wenn Sie versuchen, sich ohne Einladung anzumelden, speichern wir Ihre E-Mail-Adresse,
den Namen und das Profilbild, die Ihr Anmeldeanbieter uns übergibt, sowie den Zeitpunkt, um Sie einladen zu können.`
DE, retention: `• Zugangsanfragen werden 90 Tage nach ihrer Beantwortung gelöscht, spätestens nach 12 Monaten. [DECISION]`

Legal basis for D: legitimate interest (Art. 6(1)(f)), handling a request the person made themselves; add to
`legalBasis` or cover it under the existing legitimate-interest bullet.

## E. Page housekeeping

- `lastUpdated`: change the date in `app/(marketing)/privacy/page.tsx` only when the reviewed text goes live.
- Both languages must change together: `messages/en.json` and `messages/de.json`, `privacy.sections.*`.
- The Google "Limited Use" section is about Gmail data and does not change. Assistants never receive Gmail content from
  FiBuKI's Mail Integration unless the user asks for it through a tool; if the product ever passes Gmail-derived text to an
  assistant, check that against Google's Limited Use rules before shipping that. `[CONFIRM]`

## Code fix made while writing this

Deleting an account did not delete its API keys, and an assistant connection is an API key with OAuth fields. So the sentence
"OAuth tokens ... are revoked" was not true for connections, and their hashes and client names stayed behind.
`deleteUserData` now deletes `apiKeys` by `userId` (`functions/src/user/deleteUserAccountCallable.ts`, test
`deleteUserData.apiKeys.test.ts`, which fails without the fix).
