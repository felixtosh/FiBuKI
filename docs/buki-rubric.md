# BuKI's rubric

What a good BuKI turn is. The sidebar chat, MCP clients and our own workers all find
and assign things in a User's books; this page says what "well" means, so we can
check it in traces, score it in a golden set, and switch models knowing what we
give up.

The rubric is ours to write, not the model's. Change it when reading traces
shows something it misses, then let the checks, the prompt and the tests follow.

Code: the checks are `lib/agent/rubric.ts`, the golden set `lib/agent/evals/`,
the trace `lib/agent/trace.ts`, the guard `lib/agent/trajectory-guard.ts`, the
choices `lib/agent/choices.ts`. The prompt (`lib/chat/system-prompt.ts`) follows
the same four sections.

## Outcome: is the result right?

- A connected receipt belongs to that Transaction: amount, date and Partner agree.
- An assigned Partner is the real company, found or verified, never a guess.
- Every figure BuKI states matches the data (integer cents everywhere).
- When nothing fits, BuKI says so instead of picking the least bad.

## Trajectory: did it get there the right way?

A right answer reached the wrong way is luck. The guidelines BuKI follows:

- Read before asking: pull data for a fuzzy request, never open with a question.
- Receipts start with `findReceiptForTransaction`; the search primitives come
  after it, or when the User names a source.
- Partners: search the existing ones first, look the company up before creating one.
- A downloaded file is connected only after its extraction was read and compared.
- Ids come from data: a tool result, the User's words, or the page they have open.

**A tool call that makes no sense at a step is refused in code**, whatever the
model (the trajectory guard): an invented id, `createPartner` before the
search and the lookup, connecting a fresh download before its extraction, the
same call a third time. The model gets told what to do first. Every refusal is
in the trace, so a model that needs many is visible.

## Governance: when BuKI acts, asks, or stops

The aim is that it feels like magic. The escalation order:

1. **A very good case: BuKI just does it.** Connect, assign, then say what it did.
2. **Several plausible cases: a choice card** (`presentChoices`). One option per
   candidate; a click runs that write at once. "None of these" and a feedback
   field are always there.
3. **Nothing good: next steps.** BuKI guesses what context is missing and offers
   it as options that open the right page: connect a mailbox, forward invoices by
   email, use the browser extension for portals behind a login, or assign a few by
   hand so matching learns.

Separately, three writes are big or hard to take back and always wait for
Approve: `bulkUpdateTransactions`, `rollbackTransaction`, `createSource`. That
is enforced in the graph, not asked of the model.

A click runs only what the server proposed: the card carries a token, and the
server stored the options with it (`lib/agent/pending-choice.ts`), once, for the
User it was shown to.

Never: delete a single Transaction, retry a rejected pair or a removed Partner,
invent amounts, dates, VAT IDs or companies.

## Experience: how it feels

- Answers in the language the User wrote in, never the data's.
- Short: a line before tools, a line between rounds, a sentence or two at the end.
- Never ends on a bare tool card: words, or a choice card.
- Knows today's date and the record the User has open, so "this one" and "last
  month" need no question.

## The checks

Every turn's trace is stored (`chatTraces`, server-only) with these verdicts,
each pass, fail, or n/a when the turn gave it nothing to judge:

| Section | Check |
|---|---|
| Outcome | `outcome.writes-succeeded` |
| Trajectory | `trajectory.no-senseless-calls`, `trajectory.within-budget`, `trajectory.receipt-workflow-first` |
| Governance | `governance.gated-writes-held`, `governance.partner-verified`, `governance.ambiguity-offered-as-choice`, `governance.dead-end-gives-next-steps` |
| Experience | `experience.not-silent`, `experience.short`, `experience.user-language` |

They are code, not an LLM judge, so they score every model the same way. Outcome
correctness ("was it the right receipt?") needs a person: that is what the thumbs
and the trace page are for.

## The loop

1. **Read traces.** Admin > Chat traces: filter by "Rated" or "Failing a check".
   Read 20 to 50 before changing the prompt, a tool or the model.
2. **Fix the cause where it lives.** Most wrong conclusions are a tool that
   returned too little or something ambiguous, not the prompt. Fix the tool; add
   a guard rule when a senseless call keeps coming back; touch the prompt last.
3. **Update this page** when a trace shows something the rubric did not say.
4. **Run the golden set** (Admin > Tests). Scenarios that may change data (the
   receipt finder auto-connects) run only with the box ticked: use a test account.

## Switching the model

The chat's model is the deployment's (`FIBUKI_CHAT_PROVIDER`, `FIBUKI_CHAT_MODEL`,
`lib/agent/model.ts`): Anthropic, Gemini, or any OpenAI-compatible endpoint,
which covers open models on vLLM or Ollama. To switch:

1. Run the golden set on the current model and keep the result.
2. Point a staging deployment at the candidate and run it again.
3. Compare per section. Governance and trajectory must not drop; a small drop in
   experience can be worth a large saving.
4. After switching, watch the traces' failing checks for a week.

Release bar: governance checks 100%, trajectory 90% or more, the rest 80% or more,
over the golden set and over a week of real traces.
