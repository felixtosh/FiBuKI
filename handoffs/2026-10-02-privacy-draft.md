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

## F. Correction: the page still describes Firebase / Google Cloud (production is Hetzner)

Replace, key by key (`privacy.sections.*`). Sourced from `deploy/selfhost/README-hetzner.md`, `backup.sh`, the compose files.

`services.firebase` (rename the entry, keep the key or change the key and the page that renders it)
- EN name `Hetzner Online GmbH (hosting)`; purpose `Hosting of the application, the database and the file storage on servers in
  Nuremberg, Germany.`
- DE name `Hetzner Online GmbH (Hosting)`; purpose `Hosting der Anwendung, der Datenbank und der Dateispeicherung auf Servern in
  Nürnberg, Deutschland.`

`internationalTransfers.content`, first sentence
- EN `Your data is stored on servers in Germany (Hetzner, Nuremberg). Some processing involves transfers to the United States:`
- DE `Ihre Daten werden auf Servern in Deutschland gespeichert (Hetzner, Nürnberg). Einige Verarbeitungen umfassen jedoch
  Übermittlungen in die Vereinigten Staaten:`

`dataProtection.content`
- Line "Encryption in transit ... TLS 1.3": change to `TLS` (Caddy terminates TLS with Let's Encrypt certificates; the repo does
  not pin 1.3). `[CONFIRM]` if you want to keep "1.3".
- Line "Encryption at rest ... Google Cloud Firestore ... Cloud Storage ... AES-256": NOT TRUE as written for Hetzner. The repo
  configures no disk encryption (no LUKS); the database is Postgres on the server disk and files are in SeaweedFS. `[DECISION]`
  either enable disk encryption on the server and keep an at-rest sentence, or replace it with only what is true:
  EN `Backups are encrypted (GPG) before they leave the server.` / DE `Backups werden vor dem Verlassen des Servers
  verschlüsselt (GPG).`
- Line "Our services run on Google Cloud Platform ... SOC 2, ISO 27001": EN `Our services run on servers of Hetzner Online
  GmbH in Germany.` / DE `Unsere Dienste laufen auf Servern der Hetzner Online GmbH in Deutschland.` Add Hetzner's
  certifications only after you confirm them. `[CONFIRM]`

`dataProtection.retention.content`, backups line
- Local backups are GPG-encrypted and pruned after 14 days (`backup.sh`, `RETAIN_DAYS=14`), so "retained for up to 14 days"
  holds for the local copy. `[CONFIRM]` the cron is installed (the Hetzner README said it was not at the time it was
  written) and what an offsite copy (rclone to a storage box) retains, since that is also a backup.

Services whose status only the server knows (set in its `.env`; the repo supports them but cannot say they are on) `[CONFIRM]`:
- Gemini for extraction and matching: via Vertex AI (EU) or the Gemini API with an API key? The page says Vertex AI. They
  differ in where data goes and in the contract that covers it.
- Anthropic: the page says it powers the in-app chat. On self-host the documented chat model is Gemini
  (`FIBUKI_CHAT_MODEL`); is Anthropic still used in production?
- Google Cloud Vision (OCR), LangFuse: still in use after the move?
- Missing from the page today: Stripe (payments), the outbound mail provider behind `FIBUKI_SMTP_*` (name it), FinAPI
  (bank connection, if live; TrueLayer is listed), Google sign-in. Each needs an entry if it is active.

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
