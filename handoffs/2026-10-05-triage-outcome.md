# Triage pass, 2026-10-05: outcome and what to pick up

**Status:** done. Every open issue on `felixtosh/FiBuKI` now carries a triage or wayfinder
label; none is left at `needs-triage`. Decisions are Stefan's, recorded as a comment on
each issue. Code state checked against `main` at `7f70e63`. No code changed in this session.

## Read first

1. [`CLAUDE.md`](../CLAUDE.md), [`CONTEXT.md`](../CONTEXT.md), [`docs/adr/`](../docs/adr/)
2. The triage comment on the issue you pick up: it corrects the body where `main` moved on
   (file:line refs, stale names, the ADR number).

## What changed

**Approved, previously waiting on Felix's triage** (Stefan approved both):
- #624, the browser stops writing domain data. The children #625–#635 are `ready-for-agent`.
  **Its ADR is 0016, not 0012**: 0012–0015 are already taken. This is noted on #624, #625 and #635.
- #647, one copy of each shared module plus a callable contract. Slices 2–6 were filed as
  sub-issues #688–#692. #688, the guard test, blocks the other four. Slice 1 (#648) had already landed.

**Decided and now `ready-for-agent`:**
- #669: option (a). A surface that starts from a Transaction never auto-connects a File
  that already has a File Connection.
- #606: only a Rejection unlearns an email domain. A File Connection records what it taught.
  Shared evidence wins. The backfill is a report only.
- #551 presets:
  - the Austrian entity keeps the short name;
  - "Merkur" is dropped from both presets;
  - no migration of users' Partners;
  - the issuers are settled from real invoices.
- #674: column widths are remembered per browser (build now).

**Bugs confirmed in code** (`bug`, `ready-for-agent`): #652 (BMD vs UVA VAT), #644 (re-score
stores 0; accept the 0 when one Transaction holds two invoices), #642 (orphan and half-listed connect),
#685 (the repair script for the 156 twin Transactions).

**Also `ready-for-agent`:** #684 (ZAP), #441 (better-auth 1.7).
- #684: drop `unsafe-eval`; COOP `same-origin` on self-host only; accept the rest
  in `.zap/rules.tsv` and §8 of `docs/casa/08-dast-remediation-report.md`.

**`wayfinder:grilling`:** #314 (cash payments, starting from Felix's cash-on-the-File
direction), #566 (Zusammenfassende Meldung).

## Steps that need a human

- #644, #685, #441: the agent ships each script or migration with a dry run. Running it on the
  homelab instance and fibuki.com is for a person.
- #685: the 15 pairs where each twin holds a different File need a per-pair decision:
  Copy or two documents.
- #314: the BMD Kassa account question goes to the Steuerberater.

## Suggested order

1. #632 early, after #625. Every identity save currently wipes the FinanzOnline
   status: a live data-loss bug.
2. #625, which unblocks most of #624.
3. #688, which unblocks #647's slices.
4. The small, self-contained bugs: #652, #642, #644, #674.
