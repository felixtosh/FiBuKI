# Architecture review, 2026-10-04: handoff for candidates 4 to 7

An architecture review (`/improve-codebase-architecture`) of the whole repo surfaced eight
deepening candidates. Stefan took 1 to 7. Candidates 1 to 3 were grilled in the first
session and became tickets #612 to #616 (see "Filed" below). This file carries 4 to 7 to the next
session, which grills them the same way: `/grilling` per candidate, facts gathered by one
background agent at a time (no parallel agents on the audit box).

## Rulings that hold for every candidate

- Each candidate becomes one issue on `felixtosh/FiBuKI`, drafted first and filed only
  after Stefan has read the draft.
- No stopgap patches. A live defect inside a candidate is fixed by that candidate's first
  slice.
- Order: 1, 2, 3 (done), then **6, 4, 5, 7**.
- Candidates 1 to 4 and 7 are Stefan's call. **5 and 6 go to Felix as `needs-triage`**
  before anyone builds them: 5 changes the build layout, 6 changes the client access
  policy.
- Every ticket's acceptance: behaviour unchanged apart from the named defects; tests at the
  new module's interface come first; the per-path tests they replace are removed, not kept
  beside them.

## Filed

- #612: one File Connection writer (`ready-for-agent`, absorbs #597, blocks #606 and #613)
- #613: one matcher (`ready-for-agent`, blocked by #612)
- #614: date window to the Due Date or Debit Date (`wayfinder:grilling`, blocked by #613)
- #615: multi-payment, one File paid by several Transactions (`wayfinder:grilling`, blocked by #613)
- #616: chat tools wrap the MCP tools (`ready-for-agent`, independent)

## Candidate 6: retire the client-side write modules (next up)

**Ruling already made:** a parent issue with one child per table. Each child moves that
table's writes behind its callables, then makes the table read-only for the client in the
data policy. #612 already does this for File Connections.

**Evidence from the review, 2026-10-03:** most of the client operations layer still writes
directly. Re-count each before grilling, since #611 removed some of it on 2026-10-04.

| Area | Direct writes |
|---|---|
| Partners | about 23 |
| Categories | about 16 |
| Mail Integrations | about 15 |
| the rest of Files | about 20 |

The data policy gives `files`, `transactions` and `fileConnections` owner read/write.
Commit 0fefe126 is the precedent (Not Invoice moved server-side).

**To grill:**

- Which tables go first?
- Does each table's lock land with its last writer?
- Which client reads stay? Reads are only thin wrappers, and the deletion test says they
  merely move.

## Candidate 4: one Extraction writer for the File record

Three writers set a File's extracted fields: Extraction, the UI correction callable and
the MCP correction tool. Each recomputes the derived fields itself:

- Due Date and Debit Date
- repair flags
- the Documentation State sync when the Document Type changes

The header of the corrected-update builder records the UI path forgetting one. The scorer
derives the Due Date once more. Adding the Debit Date touched 21 files (61576847).

**The deepening:** one module turns an Extraction or a correction into the complete File
update.

**To grill:**

- Where provenance (who corrected what) lives.
- Whether hand-corrected fields block re-extraction inside the module (#184).
- How the scorer's own Due Date derivation is retired.

## Candidate 5: a shared source root (Felix)

The backend's `rootDir: "src"` stops it importing frontend types, so several modules are
hand-copied between the two, each pair guarded by a text-parsing sync test:

- model roles: a mismatch mis-bills
- field vocabulary
- invoice totals
- Transaction Type
- date parsing
- capital gains
- card reconciliation

Callable request types are also written twice: about 132 inline generics on the client.
The function-call union (147 members) and the display-name map are kept by hand.

**The deepening:**

- a shared root that both builds include
- a callable contract registry there (name to request and response)
- the union derived from the registry

**Risk:** the Docker build contexts and the Firebase deploy assume the backend directory
stands alone. Check the build before the code.

## Candidate 7: a shared list-page shell (speculative)

Page sizes:

| Page | Lines | `useState` calls |
|---|---|---|
| Files | 1372 | 20 |
| Transactions | 637 | |
| Partners | 335 | |

Panel-resize logic is copied into 7 pages. Six commits had to edit two or three pages for
one change.

**The deepening:** a list and detail shell that owns selection, prev/next, keyboard
handling, panel width and URL state.

**To grill:**

- How much of the CLAUDE.md list-page pattern it absorbs.
- Transactions keeps its own filter memory (#530).

## Not proposed: already deep

- the self-host Firestore shim
- the self-host host, which mounts every callable from the barrel
- UVA: one period loader, a pure calculation, BMD agreement test
- the Extraction runner
- the data policy table
