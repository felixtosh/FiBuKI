# Who FiBuKI is for

> **Status:** Product focus, settled 2026-07-17 by Felix and Stefan.
> This document is the reference for positioning decisions. When a feature request,
> roadmap item, or design question comes up, check it against this page first.

## The one-line pitch

**FiBuKI is pre-accounting for Austrian one-person businesses.**

Not bookkeeping. Not tax filing. The part before that — getting your receipts,
invoices, and bank lines into a state your Steuerberater can actually use.

## The problem

Every quarter, the same ritual: dig through email for invoices, match them against
bank lines, guess at categories, and send your Steuerberater a folder they'll have
to clean up anyway. It takes a weekend. It's the least interesting part of running
your own business, and it never gets easier.

## The person we build for

An Austrian **EPU** (Ein-Personen-Unternehmen) or freelancer who:

- runs their own business and does their own Belegwesen
- has a Steuerberater who does the actual books
- is comfortable letting AI do the sorting and matching
- would rather spend an hour a month than a weekend a quarter

They are not an accountant. They don't want to become one. They want the pile to
turn into a clean export and to stop thinking about it.

**Early on, we reach the AI-minded end of this group first** — people who already
use AI tools daily and will try something new. That's who finds us first, not who
we build for. The product is for Austrian EPUs generally.

## The second audience: their Steuerberater

The Steuerberater doesn't pay for FiBuKI. But they can veto it, so they matter.

A client can invite their Steuerberater into FiBuKI — free, read-only, no setup.
The advisor sees clean data and a correct BMD export. Their life gets easier for
zero effort and zero cost.

**We are not building a Kanzlei product.** No practice dashboard, no mandant
hierarchy, no bulk operations — not until advisors with several FiBuKI clients ask
for them. Demand pulls those features; we don't push them.

**The BMD export is sacred.** It is the one thing an advisor judges us on. One bad
export and we're out of that Kanzlei permanently, and they talk to each other.
It gets the strictest test coverage in the codebase.

## How it works

This is a real sequence, and the order matters:

1. **Belege come in** — connect your mailbox (Gmail or any IMAP), forward things,
   or upload them.
2. **FiBuKI sorts and matches** — reads the documents, pulls out the numbers,
   matches them to your bank lines, suggests categories.
3. **Your Steuerberater gets clean data** — a correct BMD export, or an invite to
   look directly.

## Where it runs — your choice

FiBuKI is open source. You have two honest options, and they have the same features:

**Our cloud** — you sign in and it works. We've done the parts that are genuinely
hard to do yourself: the Google OAuth verification and CASA security assessment for
mailbox access, the bank connection contracts, the AI models, the compliance.

**Your own** — pull the repo, `docker compose up`, done. Same features. You bring
your own OAuth apps, your own model keys, your own bank contracts, your own
compliance. Nothing is held back or crippled; some of it is just genuinely a lot
of work, and in the cloud we've already done it.

If you're a Steuerberater with a duty of professional secrecy
(Berufsverschwiegenheit, §91 WTBG), the second option exists precisely for you.

## Where we are

**Austria.** Only Austria.

Not because Germany isn't bigger — it's roughly ten times bigger — but because
being the obvious choice for Austrian EPUs beats being a rounding error across
DACH. Austrian tax rules, Austrian bank connections, BMD export. Depth in one
market, not breadth across three.

Germany means DATEV, not BMD, and a different set of tax rules. The codebase keeps
export formats and country tax logic behind a seam so that stays *possible* — but
it is not the plan, and we don't build for it speculatively.

## What FiBuKI is not

Saying this plainly saves everyone time:

- **Not a bookkeeping system.** Your Steuerberater does the books. We feed them.
- **Not a tax filing tool.** We don't submit anything to the Finanzamt.
- **Not an invoicing tool.** Plenty of those exist and they're fine.
- **Not a practice management system** for Kanzleien.
- **Not multi-country.** Austria.

## For contributors and LLMs

If you are proposing a feature, a schema change, or a roadmap item, check it
against this document. The most common failure mode is building for the
Steuerberater as a *buyer* instead of as a *gatekeeper* — that's how you end up
with a practice-management product nobody asked for.

The self-host and cloud versions ship the **same features**. Any proposal that
gates a feature behind the cloud tier is wrong; the split is effort and
infrastructure, never capability.

See also:

- [`docs/rewrite-goals.md`](./rewrite-goals.md) — the architecture this focus implies
- [`docs/casa/`](./casa/) — the OAuth/security work behind the cloud tier
</content>
</invoke>
