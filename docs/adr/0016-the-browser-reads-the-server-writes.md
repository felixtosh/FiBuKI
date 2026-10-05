# The browser reads domain data; only the server writes it

_Status: accepted (2026-10-05, Stefan), decided in #624. Landed with #625._

The browser reads domain tables through the data plane and never writes them. Every
write to a domain table goes through a server callable or a server route on the admin
SDK. The data policy (`functions/src/selfhost/data-policy.ts`) marks each domain table
read-only for the client.

Three kinds of table stay writable from the browser, each for a stated reason:
notifications (marking one read changes only the User's own view, so the client may
write `readAt` and nothing else), chat sessions (the
User's own conversation history, which no rule governs), and admin tables (the policy
already allows only admins).

A Next route that writes through the client SDK counts as a browser writer: on
self-host the client SDK goes through the data plane under the same policy, so the
route breaks the day its table locks. It moves to the admin SDK with its table.

## Why

- **One tenant, many users.** Every fibuki.com User shares a tenant, so the app's
  checks are all that separates them. The data plane checks ownership and nothing else.
  A browser write skips every other rule: which fields may change, which Partner may be
  assigned, what a removal should teach.
- **One implementation per rule.** The UI, MCP and the chat agent must apply the same
  rules. A rule that runs in the browser runs for one of them only. Removing a
  No-document Category learned from it in the browser and nowhere else.
- **Counts and derived fields need one owner.** A count kept by the browser drifts as
  soon as a server path changes the same rows.

## Consequences

- A new write is a callable built with `createCallable()`, with a field whitelist that
  refuses unknown fields.
- Two guard tests hold the line, both ratchets in
  `functions/src/selfhost/browser-writes.test.ts`: one fails when browser code gains a
  client SDK write call, one fails when a server route gains a client SDK write (directly
  or through an operations-layer writer). Each starts from the writers left after #625;
  a change that moves a writer lowers its allowance, nothing raises one.
- A table becomes read-only for the browser in the same change that removes its last
  browser writer, never later. `functions/src/selfhost/data-policy.test.ts` asserts each
  locked table against the real data plane.
- Dead browser writers are deleted, not ported. #625 deleted the ones nothing called
  and locked Mail Integrations, agent search sessions, AI usage, the precision-search
  queue, reports, and update on the user document. #711 locked create on the user
  document, and create and delete on notifications; a notification update may write
  only `readAt` (the policy's `updateFields`). The other tables lock with the child
  tickets of #624 that move their last writer.
