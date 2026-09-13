# Partner merge is one way

_Status: accepted; the implementation is filed as tickets and none of it has shipped yet._

Duplicate Partners are routine — a bad extraction, a brand name against a legal name, an
HTML entity in a supplier name — and nothing in the product could fold two into one. A
**Merge** now does: the caller names the survivor and one or more losers, the survivor
keeps the values it has and fills its empty ones from the losers, the losers' names join
its aliases, and every Transaction, File, Invoice, identity entity and queued
invoice-fetch item pointing at a loser is repointed. Each loser stays as a **Merged
Partner**: inactive, carrying `mergedInto`, hidden from the Partner list, so an ID
handed out before the merge still resolves.

There is no unmerge. Offering one would mean recording every reference that moved, in an
audit collection built for an operation whose whole purpose is removing a record nobody
wanted.

## Considered options

- **Destroy the loser.** Rejected: every exported ID, agent transcript and bookmark
  holding it breaks silently, and the codebase soft-deletes everywhere else.
- **Full undo.** Rejected: the cost is a reference journal, and merging back the other way
  approximates it closely enough for the cases that actually occur.
- **Winner-wins on every field.** Rejected: the common case is a survivor with an empty
  `vatId` or no Global Partner link and a loser that has one. Discarding identifying data
  during a consolidation defeats the operation, since identifying data is what the Match
  runs on.
- **Merging Global Partners too.** Rejected: a Global Partner is shared across tenants and
  belongs to no user, so one user's merge cannot rewrite it. The preset-versus-VIES
  duplicate behind #138 is curation on our side, not a user-facing act.

## Consequences

- Tombstones never chain. Merging B into C rewrites every tombstone aimed at B, so a
  pointer is always one hop from a live Partner and no consumer needs loop detection.
- A Merged Partner can be a loser again — it has no references left to move — but never a
  survivor.
- Reading a merged-away ID returns the tombstone and its `mergedInto`, never a silent
  redirect to the survivor. A caller that is redirected silently never learns to update
  its ID, and the tombstone becomes permanent infrastructure.
- Two non-empty, differing VAT IDs warn and demand a second explicit confirmation, but
  never block. A wrong extracted VAT ID is itself a common cause of the duplicate, and
  only the user knows which one is the typo.
- A merge does not promote the survivor to an identity-synced Partner. `identitySourceField`
  decides where a Partner is edited — "Edit in Identity" rather than the Partner page — so
  it travels only with the identity entity that produced it, never as one more empty value
  filled from a loser (#307).
- A merge does not re-run the Match. It reports how many unmatched Transactions the
  survivor's new identifying data would now hit and leaves the existing reviewed rematch
  path to act on it, because silent re-attribution of bookings is what makes users stop
  trusting the operation. A trigger does not get to re-run it either: every Partner
  document a merge writes — survivor, losers, rewritten tombstones — carries that merge's
  `mergeWriteId`, and `onPartnerUpdate` stands down on a write that brings one. A manual
  edit, carrying no new id, still re-matches (#306).
