# Renaming the `selfhost` shim layer

The `selfhost` name stays on `lib/selfhost/`, `functions/src/selfhost/` and
`deploy/selfhost/`. A rename is not planned.

## Why this is out of scope

The name reads as "an alternative path" when it is in fact the only backend —
`fibuki.com` runs `FIBUKI_BACKEND=selfhost` with `FIBUKI_TIER=cloud`, and the
Firebase App Hosting backend it used to be an alternative to has been deleted. So the
complaint is real.

It is still not worth the diff, for one reason: **the rename that was proposed
deliberately excludes the only name that actually misleads.**

The genuinely misnamed thing is the env *value*, `FIBUKI_BACKEND=selfhost`. That is
what a reader encounters first and what carries the wrong implication. It was excluded
from the proposed scope on purpose, because existing self-hosters would need a
migration note — which is correct, and which is also the whole argument. Renaming the
directories while leaving the env value in place moves the confusion rather than
removing it, and leaves a repo where the code says one thing and the deployment says
another.

What the excluded-scope rename would have cost, against no behaviour change:

- `lib/selfhost/` and `functions/src/selfhost/` moved
- roughly 40 test files updated
- both test-runner configs updated
- the alias map in `next.config.ts` updated

And two of the three directories are not clearly wrong anyway. `deploy/selfhost/` is
accurate and load-bearing: the box's cron uses absolute paths into it and the container
names key off it. `lib/selfhost/` and `functions/src/selfhost/` are arguable at worst.

## What would change this

If the env value is ever migrated — with the self-hoster migration note that requires —
then renaming the directories alongside it becomes the cheap half of a change that is
happening anyway, and this file should be deleted. The rename is not wrong in
principle; it is wrong on its own.

## Already defused, so not an argument either way

The volume landmine is gone: `name: selfhost` is pinned in the compose file as of
`a25074c6`, so a rename no longer risks bringing `fibuki.com` up against an empty
database. That was the one *risk* argument against doing it, and it no longer applies.
The argument above is about value, not risk.

## Prior requests

- #71 — "Rename the selfhost shim layer now that it is the only backend"
