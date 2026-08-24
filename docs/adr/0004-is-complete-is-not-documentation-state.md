---
status: accepted
date: 2026-08-24
---

# `isComplete` keeps its old meaning; Documentation State is additive

`isComplete` has meant "this Transaction has some documentation" since long before § 11
classification existed, and 216 references depend on that meaning. Documentation State
(#104) was deliberately added *beside* it rather than replacing it, so no line that is
green today turns red, no existing view changes behaviour, and the whole Transaction
corpus is not re-triggered by a backfill. The gap becomes visible through the new chase
queue, not through the old flag flipping.

The two answer different questions. `isComplete` asks whether anything at all is attached.
Documentation State asks what that evidence is worth — `invoice`, `receipt-only`,
`unknown`, `no-document-category`, `undocumented`. A line with a Kassenbeleg and no
invoice is `isComplete: true` and `receipt-only`, and that combination is the point, not
a bug.

## Consequences

They can genuinely disagree, and one path makes them disagree in the wrong direction:
`update_transaction` over the MCP surface writes `isComplete` directly, so an agent can
mark a Transaction complete with no Files and no No-document Category while the derived
state still reads `undocumented`. `shouldRecomputeDocumentationState` only re-derives when
the Files or the category change, so such a row stays divergent until it is touched.
Legacy rows written before #104 sit in the same position, and `admin/fixIsCompleteFlag.ts`
exists because the flag drifts from the data.

Nothing reads `isComplete` as proof of deductibility, so this is a reporting wart rather
than a tax risk. It is worth an issue, not a redesign.
