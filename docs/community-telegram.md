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

## One-time setup (Felix, about 15 minutes)

1. **Create the bot.** In Telegram open [@BotFather](https://t.me/BotFather),
   send `/newbot`, pick a name and a username ending in `bot` (for example
   `fibuki_community_bot`). Copy the token it prints. Optional: `/setprivacy`
   is irrelevant (the bot never reads group chat).
2. **Create the announcements channel.** New Channel → "FiBuKI Announcements"
   → **Public**, with a link like `t.me/fibuki_news`. Anyone can join. Add the
   bot as an administrator only if you want it to post later.
3. **Create the private group.** New Group (add Stefan right away), then open
   its settings:
   - Convert to a **Supergroup** (Group type → it becomes one when you set the
     options below).
   - Group type: **Private**. Turn on **Approve new members** (join requests).
     This is what lets the bot gate entry.
   - Topics: **enabled** (Edit → Topics). This gives you several rooms in one
     group, for example "General", "Feedback", "Feature ideas", "Help".
   - Optional: Chat history for new members: **Hidden**; **Restrict saving
     content** if you do not want screenshots forwarded.
4. **Make the bot an admin of the private group.** Group → Administrators →
   Add → your bot. It needs only: **Invite users via link**, **Ban users**.
5. **Make Stefan an admin (this is how he gets full access).** Same screen:
   Administrators → Add → Stefan. Do the same for the channel. Group admins
   are never removed by the bot and never need to link a FiBuKI account. To be
   safe also put his Telegram user id in `TELEGRAM_STAFF_IDS` (step 7) so his
   join requests are always approved, and have him connect his own FiBuKI
   account normally if he wants the Settings page to show "Connected".
6. **Get the ids.**
   - Group id: add [@RawDataBot](https://t.me/RawDataBot) to the group, read
     `"chat": {"id": -100…}`, then remove it. That negative number is
     `TELEGRAM_COMMUNITY_CHAT_ID`.
   - Your id and Stefan's id: message [@userinfobot](https://t.me/userinfobot)
     (each person messages it themselves). Numeric, positive.
7. **Put the values on the box** in `/opt/fibuki/.env` (the deploy never
   overwrites it):

   ```
   TELEGRAM_BOT_TOKEN=<from BotFather>
   TELEGRAM_BOT_USERNAME=fibuki_community_bot
   TELEGRAM_WEBHOOK_SECRET=<random, e.g. openssl rand -hex 32>
   TELEGRAM_COMMUNITY_CHAT_ID=-100xxxxxxxxxx
   TELEGRAM_STAFF_IDS=<felix id>,<stefan id>
   ```

   Then deploy this branch (push to `main`) or run
   `docker compose up -d --build fibuki-api` on the box.
8. **Register the webhook** (once, from anywhere with the same values):

   ```
   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
   FIBUKI_API_HOST=new-api.fibuki.com deploy/selfhost/register-telegram-webhook.sh
   ```

   `getWebhookInfo` at the end should show the URL and `last_error_message`
   empty.
9. **Test it.** In FiBuKI → Settings → Community, connect your own account
   (needs a paid plan), tap the link, press Start, tap the invite link, you
   are in. A free account should be refused: no link, join request declined.

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
