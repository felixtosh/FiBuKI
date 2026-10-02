# Community chat on Telegram

A private group where paying users talk to Felix and Stefan, plus a public
announcements channel. The Telegram Bot API is free (no plan, no per-message
fee). Why Telegram and not WhatsApp: WhatsApp's Groups API caps a group at 8
people and cannot add members; Communities need unofficial automation.

**How it works.** A paying user opens Settings → Community and taps "Connect
Telegram". The API mints a one-time token for that signed-in user (15 minutes)
and opens `t.me/<bot>?start=<token>`. The bot redeems the token, links the
Telegram account to the FiBuKI account, and replies with a join-request invite
link. When the user taps it, Telegram sends the bot a `chat_join_request`; the
bot approves only if the Telegram id is linked to an account that pays (paid
plan with an active Stripe subscription) or is staff. A forwarded link is
useless to anyone else. A daily sweep (04:30) kicks members whose subscription
lapsed; they can rejoin by resubscribing.

Code: `functions/src/community/`. Tests: `functions/src/selfhost/community-telegram.test.ts`.

## Rooms and how people get in

| Room | Who | How they get in |
|---|---|---|
| Announcements channel | Everyone | The open invite link. The bot DM and Settings → Community both show it. |
| Support group (private, join requests on) | Paying users, Felix, Stefan | Connect in Settings → Community, the bot DMs a one-time join link, the bot approves the request. |

The welcome is a **private DM from the bot**, not a post in the channel: a
channel post reaches everyone and cannot greet one person. After "Connect
Telegram" → Start, the bot sends the support-group join link plus the
announcements link. Free users see the announcements link on the Settings page
and in the bot's reply to a bare `/start`, but get no support link.

## One-time setup (Felix, about 15 minutes)

1. **Bot.** Already created: the bot `@bukibukibukibot`. Its token lives only in
   `/opt/fibuki/.env`, never in the repo. If it was ever pasted into a chat or
   ticket, regenerate it with BotFather `/revoke` and use the new one below.
2. **Announcements channel.** Exists. Its invite link goes into
   `TELEGRAM_ANNOUNCEMENTS_URL`. Optional: add the bot as admin if it should
   post later.
3. **Support group.** Exists ("FiBuKI - Tax Gang"). In its settings:
   - Group type **Private**, **Approve new members** on (this is what lets the
     bot gate entry).
   - Topics on. Create an "Announcements" topic and close it (⋯ → Close Topic)
     so only admins post there.
4. **Make the bot an admin of the support group.** Group → Administrators → Add →
   the bot, with only **Invite users via link** and **Ban users**.
5. **Make Stefan an admin of the group and the channel.** Admins are never
   removed by the bot and need no linked FiBuKI account. Also put his id in
   `TELEGRAM_STAFF_IDS` so his join requests are always approved.
6. **Find the ids with the bot itself** (do this BEFORE step 8, because
   `getUpdates` stops working once a webhook is set):
   1. Write any message in the support group.
   2. Have Felix and Stefan each send `/start` to the bot in a private chat.
   3. Run `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"`
      and read the numbers: the group's `chat.id` (negative, like `-100…`) is
      `TELEGRAM_COMMUNITY_CHAT_ID`; each person's `from.id` is their staff id.
7. **Put the values on the box** in `/opt/fibuki/.env` (the deploy never
   overwrites it):

   ```
   TELEGRAM_BOT_TOKEN=<from BotFather>
   TELEGRAM_BOT_USERNAME=bukibukibukibot
   TELEGRAM_WEBHOOK_SECRET=<random, e.g. openssl rand -hex 32>
   TELEGRAM_COMMUNITY_CHAT_ID=-100xxxxxxxxxx
   TELEGRAM_STAFF_IDS=<felix id>,<stefan id>
   TELEGRAM_ANNOUNCEMENTS_URL=<the channel invite link>
   ```

   Then deploy this branch (push to `main`) or run
   `docker compose up -d --build fibuki-api` on the box.
8. **Register the webhook** (once):

   ```
   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
   FIBUKI_API_HOST=new-api.fibuki.com deploy/selfhost/register-telegram-webhook.sh
   ```

   `getWebhookInfo` at the end should show the URL and no `last_error_message`.
9. **Test it.** In FiBuKI → Settings → Community, connect your own account
   (needs a paid plan), press Start in the bot, tap the join link, you are in.
   A free account must get no support link and a declined join request.

## Operating it

- Rotate the token with BotFather `/revoke`, update `.env`, rerun step 8.
- Remove someone by hand: ban them in Telegram. Unlinking in Settings also
  removes them.
- The webhook always answers 200 after the secret check (otherwise Telegram
  retries a failing update forever); failures show in the api log as
  `[telegramWebhook]`.
- Until the five env values are set, the Settings card says the chat is not
  open and the webhook answers 404.
- Announce the channel link yourself (footer, onboarding email); it needs no
  gating.
