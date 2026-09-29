# Workstream: TypeSafe Jev as a decision provider

**Status:** Spike done and phase 2 (column matching) IMPLEMENTED 2026-09-27,
uncommitted. Felix picked column matching as the pilot and asked for a config
switch usable per deployment (prod and self-host).

## What is implemented (uncommitted working tree)

- `functions/src/utils/typesafe.ts` — minimal System One client. Env:
  `FIBUKI_TYPESAFE_API_KEY` (required), `FIBUKI_TYPESAFE_BASE_URL` (optional;
  lets self-host point at an API-compatible local clone such as "jeff" so no
  document text leaves the box).
- `functions/src/import/columnFields.ts` — field/format definitions split out of
  matchColumns.ts so both backends share one source (DATE_FORMATS still
  re-exported from matchColumns.ts for matchInvestmentColumns, #304).
- `functions/src/import/matchColumnsJev.ts` — Jev backend: one call, one Choice
  per column plus date/amount/balance format Choices; pure builders/mappers,
  tested. `columnMatchProvider()` reads `FIBUKI_COLUMN_MATCH_PROVIDER`
  (gemini default | typesafe; unknown value throws).
- `functions/src/import/matchColumns.ts` — branches on the provider. Missing
  key = loud failed-precondition; Jev runtime failure = console.error + Gemini
  fallback, so a vendor outage cannot break imports. Post-processing (dedupe,
  format fallbacks) extracted and shared by both backends.
- `jev-latest` role (`jevDecision`) + pricing ($0.042/M in, $0 out) added to
  BOTH registry files; models.sync.test.ts green. Usage logged to aiUsage as
  function `columnMatching`, model `jev-latest`.
- Tests: `functions/src/import/matchColumnsJev.test.ts` (16 passing incl. the
  format-id drift guard). Pre-existing unrelated tsc errors in
  bmd-export/user-export (archiver typings) are NOT from this change.

Enablement: prod = set `FIBUKI_COLUMN_MATCH_PROVIDER=typesafe` +
`FIBUKI_TYPESAFE_API_KEY` in functions env and redeploy `matchColumns`;
self-host = same vars in compose env for fibuki-api. Default everywhere stays
Gemini. Prod enablement remains blocked on the DPA question. Rotate the spike
API key before prod use (it passed through a chat transcript).

## Partner matching: where Jev would and would not fit (Felix's question)

Matching against EXISTING partners is deterministic and free: Cologne
Phonetics + glob patterns + IBAN/VAT/domain exact matching
(`utils/filePartnerMatcher.ts`, `utils/partner-matcher.ts`) with a
`shouldAutoApply` gate. Gemini appears in that pipeline only for company
LOOKUP of new vendors (web grounding) and domain-ownership validation.
So Jev is NOT a replacement there. The only sensible slot is a cheap
tie-breaker at the margin: when deterministic matching returns several
mid-score candidates or one borderline candidate below the auto-apply gate,
one Jev Choice call (candidates + none) could confirm or reject for ~$0.0001.
Whether that margin is big enough to matter should be measured from real
data (how many files/month land between "auto-apply" and "no match") before
building anything. Not part of phase 2.

## Spike results (2026-09-27, hosted jev-latest, synthetic Austrian doc set)

Harness: standalone Node script + ground-truth dataset (21 documents, 3 bank
CSVs/21 columns, 6 partner cases, 6 match-verification cases), built in the
session scratchpad; promote into the repo as the eval baseline when phase 2
starts. All questions were modeled on the real tasks (field keys from
`lib/import/field-definitions.ts`, doc types, candidate-partner matching).

| Task | Strict | Lenient | Notes |
|---|---|---|---|
| Doc-type classification | 18/21 | 21/21 | All misses were deliberately ambiguous probes; conf dropped to 0.51-0.63 on them vs ~1.00 when right |
| CSV column matching | 21/21 | 21/21 | Whole 9-column CSV in one ~290ms call, incl. legacy Soll/Haben |
| Partner matching | 6/6 | 6/6 | OCR-mangled names and a correct "none" both handled |
| File-txn match verification | 4/6 | 5/6 | Weak spot: accepted same-amount/wrong-partner (p=0.81). Do NOT touch scoreAttachmentMatch |

Operational: p50 latency ~150ms, p90 ~250ms. Zero type violations in 38 calls
(every Choice answer was a sent criteria key). ~29k input tokens for the whole
spike = about $0.0012 total; output tokens are free, so fan-out (6 questions on
one doc) cost the same call and LESS latency than 1 question. Calibration is
the standout: confidence cleanly separates right from wrong answers, which
Gemini does not give us at all today.

Implication for design: confidence-gated routing. Auto-apply above a threshold,
fall back to Gemini or ask the user below it. Thresholds must be per-deployment
config (real Jev vs any self-host clone calibrate differently).

## Goal

Evaluate and (if it wins) integrate TypeSafe's Jev model as a switchable provider
for System-1 decision tasks around document processing, for both prod (Firebase)
and self-host, behind a default-off switch.

## What Jev is (verified 2026-09-27)

- Real vendor, launched 2026-09-15. Founder Diogo Almeida (RLHF co-inventor).
  Covered by Tom's Hardware, MarkTechPost, Turing Post.
- API: `POST https://api.typesafe.ai/v1/systemone`, Bearer auth, model
  `jev-latest`. NOT OpenAI-compatible. Request = `{ state, model, questions }`
  where questions are typed: **Noul** (yes/no probability), **Choice** (pick from
  up to 255 options, full distribution), **Score** (ordered rubric). Response =
  calibrated, typed answers with confidence.
- Reported pricing: $0.042 per 1M input tokens, output free.
- **Text only. No PDF/image input. Not generative.** It answers typed questions;
  it cannot emit free-form structured extraction.

## Consequence: Jev cannot replace extraction

`functions/src/extraction/geminiParser.ts` sends raw PDFs/images to Gemini and
gets back `ExtractedData` (amounts, VAT IDs, line items, bounding boxes). Jev can
do none of that. "Jev for invoice recognition" therefore means: **Gemini keeps
doing OCR/extraction; Jev takes over the downstream text-based decisions.**

Candidate decision points, best fit first:

1. **Document type classification** (invoice / receipt / credit note / reminder /
   bank statement / other) — Choice over extracted text. Clean, low-risk pilot.
2. **CSV column matching** (`functions/src/import/matchColumns.ts`) — Choice per
   column. Pure text, already on `geminiLite`.
3. **Partner matching** (`functions/src/matching/matchFilePartner.ts`) — Choice
   over candidate partners given extracted fields.
4. **File-transaction match scoring** — Noul/Score. CAUTION: `scoreAttachmentMatch`
   is the single source of truth for scoring (CLAUDE.md business rule); any change
   here needs its own spec and identical behavior for UI and agents.

## Why a plain route override is NOT enough

The self-host routing layer (`functions/src/selfhost/ai/config.ts`,
`FIBUKI_AI_ROUTE_<model>=<provider>:<model>`) transparently re-routes
prompt-in/text-out calls. Jev's API is question-map-shaped, so a Gemini prompt
cannot be forwarded to it. The switch has to live one level up, per task:

- Define a small decision interface per task (e.g. `classifyDocument(state)`),
  with two backends: the existing Gemini prompt, and a Jev `questions` call.
- Select backend via env, same variable names in both stacks (self-host env,
  Firebase params/secrets), e.g. `FIBUKI_DECISION_PROVIDER=gemini|typesafe`
  plus per-task overrides. Cloud and self-host ship the same feature
  (who-is-this-for rule: the split is infra, never capability).
- Add `typesafe` as a `ProviderName` + `FIBUKI_TYPESAFE_API_KEY` in
  `selfhost/ai/config.ts` for key handling; prod reads a Firebase secret.
- Add `jev-latest` to `MODEL_PRICING` in BOTH mirrored files
  (`functions/src/utils/models.ts` and `types/ai-usage.ts`); the sync test
  fails the build if they drift. Log usage via existing `ctx.logAIUsage()`.

## Phases

1. **Spike / shadow eval (no product wiring).** Script that replays N real
   already-extracted documents through both Gemini (current behavior) and Jev
   (typed questions) for ONE task (doc classification or column matching).
   Compare accuracy, calibration, latency, cost. Deliverable: numbers + a
   go/no-go note.
2. **Provider integration** behind default-off env switch, pricing entries,
   usage logging, tests first (xfail per repo practice), then `/goal`.
3. **Rollout**: enable per deployment via env. Prod enablement blocked on the
   privacy question below.

## Guardrails

- **Privacy/DPA (blocking for prod default-on):** routing invoice text to a
  12-day-old US startup is a data-processing decision for an Austrian tax
  product. `selfhost/ai/config.ts` already documents the DPA requirement.
  Shadow-eval on Felix's own data is fine; customer data is not, until resolved.
- **API key hygiene:** the key was pasted into a chat transcript. Store only in
  env/secrets, never in the repo or handoffs, and rotate after the spike.
- **Skill install:** SKILL.md at typesafe-ai/skills was reviewed 2026-09-27 and
  looks benign (points agents at docs.typesafe.ai, no command execution). Install
  via `claude plugin marketplace add typesafe-ai/skills` +
  `claude plugin install typesafe@typesafe-ai` when the spike starts, not before.
- Never inline `jev-latest` at callsites; add a role in the model registry.
- Cost accounting keys on the callsite-requested model; make sure Jev calls
  request the Jev role so they are not priced at Gemini rates.

## Open questions for Felix

1. Which task pilots first: doc-type classification, column matching, or partner
   matching? (Recommendation: doc-type classification — new capability, zero
   risk to existing behavior; column matching is the cheapest brownfield swap.)
2. Is "invoice recognition" meant as extraction (then Jev is the wrong tool and
   we keep Gemini) or as classify/match/verify (then this plan applies)?
3. Who owns the DPA/privacy call for prod?
4. Switch granularity: one global decision-provider env, or per-task overrides
   from day one?
