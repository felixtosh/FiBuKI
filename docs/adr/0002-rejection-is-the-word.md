---
status: accepted
date: 2026-08-24
---

# "Rejection" is the word, and unlinking is not one

A pair the user says does not belong together was written two ways — `dismissedTransactions`
on the file, `rejectedFiles` on the transaction — so a pair rejected by a click and one
rejected by an agent could disagree, and scoring had to consult both. `feat/dismissal-model`
collapsed it to one list on the file document with a single builder behind every writer.
The domain word for that fact is **Rejection**: it is what the eight merge-lane issues
already say, and it matches the surviving `rejectFile` flag.

**Unlinking is a different act.** Taking apart an established File Connection may record a
Rejection, but it does not have to — `disconnectFileFromTransaction(userId, …, rejectFile)`
already carries that distinction, and it is worth keeping: a link undone by accident, or
because a better File turned up, is not evidence that the pair was wrong.

## Consequences

Vocabulary first, storage later, as in ADR-0001: the list stays `dismissedTransactions`
and the ops file stays `dismissSuggestionOps.ts` until the Postgres port renames them.
New code, issues, prompts and UI copy say Rejection; "dismiss" is not a synonym to reach
for, and `unrejectFileFromTransaction` keeps its name for now precisely because it already
speaks the chosen word.
