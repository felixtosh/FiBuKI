# Privacy policy: draft wording for the assistant connections (FOR REVIEW)

Status: draft. NOT applied to `messages/en.json` / `messages/de.json`, so nothing here is live. It is legal text for
Infinity Vertigo GmbH: a lawyer or the data protection contact signs off before it is applied. Each block names where it
goes (`privacy.sections.*` keys; the German text is formal "Sie", like the rest of the page).

`[CONFIRM]` marks a statement of fact I could not verify from the code; answer each before applying. `[DECISION]` marks
something that needs a choice, not a lookup.

## Answers received (2026-10-02)

1. Hosting is Hetzner. Block F below corrects the existing text. What the repo can prove is stated; what only the server
   knows is `[CONFIRM]`.
2. Revoking a connection: checked in code. Each connection is an `apiKeys` record named `<assistant> (connected app)`,
   listed by `listApiKeys` and revoked by `revokeApiKey`; it appears under Integrations > API keys (card "AI Agents").
   Revoking also stops the refresh token, so the connection ends. Block C uses that path.
3. No data processing agreement with OpenAI or Anthropic for connected assistants: they are the user's own provider.
   Block A and C already say this; nothing to change.
4. Access requests are kept for now, no deletion period. The draft says so plainly instead of promising one (block D).
   Note for review: GDPR storage limitation still applies, so "kept until you ask us to delete them" with a stated
   deletion route is the honest minimum. A retention job can follow.

5. Server facts (checked 2026-10-02, read-only, supplied by Felix): Gemini through an API key (not Vertex; models
   gemini-3.1-flash-lite and gemini-3.8-flash); Anthropic key set but zero calls in 14 days, chat runs on Gemini; Vision
   unused; LangFuse disabled; Stripe active; mail through Resend (smtp.resend.com); backups nightly 03:10, GPG-encrypted,
   14 days, copied off-site to a Hetzner Storage Box, weekly restore test passing; server Hetzner Cloud nbg1-dc3, disk not
   encrypted; Hetzner holds ISO/IEC 27001. Block F is rewritten on these facts. Remaining `[CONFIRM]` items are listed at
   the end of F.
6. `[DECISION]` Anthropic. Recommendation: do not list it as a processor of the in-app chat, because nothing is sent to
   it, and a policy that names a processor that receives no data is as wrong as one that omits a real one. Block F removes
   that entry and its transfer bullet. Anthropic stays named in block A as a provider the user may connect themselves. If
   the chat is ever switched back to Anthropic, add the entry back BEFORE the switch (the key being set makes that a
   one-line config change, so it is easy to do by accident).

## A. New third parties: assistants (add to `services` and `internationalTransfers`)

`services.assistants` (new entry, after `gemini`, see block F)

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

Ending a connection: remove it under Integrations > API keys, where it is listed as "<assistant> (connected app)". Its tokens stop working immediately. Deleting your
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

Verbindung beenden: Entfernen Sie sie unter Integrationen > API-Schlüssel, wo sie als "<Assistent> (connected app)" aufgeführt ist. Die Token funktionieren sofort nicht mehr.
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
EN, retention: `• Access requests are kept until you ask us to delete them (privacy@fibuki.com). Once you register, your request is closed.`

DE, dataCollection: `• Zugangsanfragen: Wenn Sie versuchen, sich ohne Einladung anzumelden, speichern wir Ihre E-Mail-Adresse,
den Namen und das Profilbild, die Ihr Anmeldeanbieter uns übergibt, sowie den Zeitpunkt, um Sie einladen zu können.`
DE, retention: `• Zugangsanfragen werden aufbewahrt, bis Sie uns um Löschung bitten (privacy@fibuki.com). Sobald Sie sich registrieren, wird Ihre Anfrage geschlossen.`

Legal basis for D: legitimate interest (Art. 6(1)(f)), handling a request the person made themselves; add to
`legalBasis` or cover it under the existing legitimate-interest bullet.

## F. Correction: the page describes Firebase / Google Cloud; production is Hetzner, Gemini API, Stripe, Resend

Final replacement text, key by key (`privacy.sections.*`), on the confirmed server facts above. Entries not listed stay
as they are (`gmailApi`, `googleUserData.*`, `truelayer`).

### services

| key | action |
|---|---|
| `firebase` | replace with the hosting entry below |
| `cloudVision` | delete (not used) |
| `vertexAi` | replace with the `gemini` entry below |
| `anthropic` | delete `[DECISION]` item 6 |
| `langfuse` | delete (disabled) |
| `assistants` | add (block A) |
| `stripe` | add |
| `resend` | add |

`services.firebase` becomes (rename the key to `hosting`, and the renderer in `app/(marketing)/privacy/page.tsx` with it)
- EN name `Hetzner Online GmbH (hosting)`; purpose `Hosting of the application, the database and the file storage on servers in
  Nuremberg, Germany. Encrypted backups are also copied to a Hetzner Storage Box. Hetzner is certified under ISO/IEC 27001.`
- DE name `Hetzner Online GmbH (Hosting)`; purpose `Hosting der Anwendung, der Datenbank und der Dateispeicherung auf Servern in
  Nürnberg, Deutschland. Verschlüsselte Backups werden zusätzlich auf eine Hetzner Storage Box kopiert. Hetzner ist nach
  ISO/IEC 27001 zertifiziert.`
- Link Hetzner's certificate page next to the ISO sentence. `[CONFIRM]` the exact URL before it goes in (the page text is plain
  strings today, so a link needs the page component to render one).

`services.vertexAi` becomes `services.gemini`
- EN name `Google Gemini API`; purpose `AI-powered document analysis, categorization, matching of receipts and the in-app
  assistant. The documents and text involved are sent to Google for processing.`
- DE name `Google Gemini API`; purpose `KI-gestützte Dokumentenanalyse, Kategorisierung, Zuordnung von Belegen und der
  In-App-Assistent. Die betreffenden Dokumente und Texte werden zur Verarbeitung an Google gesendet.`

`services.stripe` (new)
- EN name `Stripe`; purpose `Payment processing for subscriptions. Stripe receives your billing details; we do not store card
  numbers.`
- DE name `Stripe`; purpose `Zahlungsabwicklung für Abonnements. Stripe erhält Ihre Rechnungsdaten; wir speichern keine
  Kartennummern.`
- `[CONFIRM]` the contracting Stripe entity (Stripe Payments Europe, Ltd. for EEA accounts) and that checkout is Stripe-hosted,
  which is what the "no card numbers" sentence assumes.

`services.resend` (new)
- EN name `Resend`; purpose `Sending of emails from FiBuKI, such as invitations, password resets and notifications.`
- DE name `Resend`; purpose `Versand von E-Mails von FiBuKI, etwa Einladungen, Passwort-Zurücksetzungen und Benachrichtigungen.`

### internationalTransfers.content

First sentence
- EN `Your data is stored on servers in Germany (Hetzner, Nuremberg). Some processing involves transfers outside the European
  Union, in particular to the United States:`
- DE `Ihre Daten werden auf Servern in Deutschland gespeichert (Hetzner, Nürnberg). Einige Verarbeitungen umfassen jedoch
  Übermittlungen außerhalb der Europäischen Union, insbesondere in die Vereinigten Staaten:`

Bullets
- Delete the Anthropic (chat) bullet and the "Google Cloud AI (Vertex AI, Cloud Vision)" bullet.
- Add, EN: `• Google (Gemini API): Documents and text sent for analysis are processed by Google, which may do so outside the EU.
  This is covered by Google's data processing terms and standard contractual clauses.`
  DE: `• Google (Gemini API): Zur Analyse gesendete Dokumente und Texte werden von Google verarbeitet, möglicherweise außerhalb der
  EU. Dies ist durch Googles Datenverarbeitungsbedingungen und Standardvertragsklauseln abgedeckt.`
- Add, EN: `• Resend (email delivery): Email addresses and message content are processed by Resend, a US provider. [safeguard]`
  DE: `• Resend (E-Mail-Versand): E-Mail-Adressen und Nachrichteninhalte werden von Resend, einem US-Anbieter, verarbeitet.
  [Garantie]`
- Keep the connected-assistants bullet from block A.
- `[CONFIRM]` for Gemini and Resend which safeguard actually applies (SCCs in the provider's DPA, or the EU-US Data Privacy
  Framework certification of that provider) and name that one; "Google's data processing terms" holds only if you are on the
  paid Gemini API tier, where Google does not use API data to improve its models. On the free tier it can, which would be a
  different and much heavier disclosure. Check the billing tier of the key.

### dataProtection.content

- Transit line: `TLS` instead of `TLS 1.3` (Caddy; the repo does not pin the version). `[CONFIRM]` only if you want to keep "1.3".
- At-rest line, replace with what is true (disk not encrypted, backups are):
  EN `Backups are encrypted (GPG) before they leave the server.`
  DE `Backups werden vor dem Verlassen des Servers verschlüsselt (GPG).`
  Do not claim database or file encryption at rest. If you later enable disk encryption on the server, add that sentence then.
- Infrastructure line, replace:
  EN `Our services run on servers of Hetzner Online GmbH in Germany, which is certified under ISO/IEC 27001.`
  DE `Unsere Dienste laufen auf Servern der Hetzner Online GmbH in Deutschland, die nach ISO/IEC 27001 zertifiziert ist.`

### dataProtection.retention.content, backups line

EN `Database backups are encrypted, kept for 14 days for disaster recovery and then automatically deleted. An encrypted copy is
also kept off-site on a Hetzner Storage Box.` DE `Datenbank-Backups werden verschlüsselt, 14 Tage zur Notfallwiederherstellung
aufbewahrt und danach automatisch gelöscht. Eine verschlüsselte Kopie wird zusätzlich extern auf einer Hetzner Storage Box
aufbewahrt.` `[CONFIRM]` how long the Storage Box copy is kept; if longer than 14 days, say so, because "deleted after 14 days"
would then be untrue for that copy.

### Other places that still name the old stack or removed services

- `legalBasis.content`: the legitimate-interest bullet mentions "AI quality monitoring". LangFuse, which did that, is
  disabled; reword to usage analytics only unless something else does the monitoring. `[CONFIRM]`
- `automatedProcessing.content` and `googleUserData.*`: check for "Vertex" or "Firebase" wording (not reviewed line by line here).
- The Gmail "Limited Use" text is about Gmail data; Gemini now processes extracted text from those emails, so confirm the
  sentence about sending data to AI providers still matches the Google API Services User Data Policy for your setup.
  `[CONFIRM]` (Gemini API, not Vertex, is the part that changed).

### Still `[CONFIRM]` after the server facts

1. Gemini API billing tier of the key (paid vs free) and the safeguard for Gemini and Resend (above).
2. Off-site backup retention on the Storage Box.
3. Hetzner certificate page URL; whether the page component can render a link.
4. TrueLayer and FinAPI: `FINAPI_*` and `TRUELAYER_*` are in the compose files; the server facts did not say whether either is
   live. TrueLayer stays listed; add FinAPI if it is.
5. Stripe contracting entity and hosted checkout.

## D2. Rate limiting of connection registration (one line for `dataCollection`, optional)

To limit abuse of the open registration endpoint we keep a hash of the caller's IP address for at most the current one-hour
window and then delete it. EN: `• Security: a short-lived hash of your IP address when an app registers a connection, kept
for up to an hour to prevent abuse.` DE: `• Sicherheit: ein kurzlebiger Hashwert Ihrer IP-Adresse, wenn eine App eine Verbindung
registriert, höchstens eine Stunde gespeichert, um Missbrauch zu verhindern.` The host's general rate limiter and Caddy's
access log also see IP addresses; check whether the page already covers server logs. `[CONFIRM]`

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
