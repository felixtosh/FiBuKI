# Licensing and contributor terms: decision brief

> **Status:** open decision, owner Felix. Written 2026-07-29, before Stefan's
> self-host work (PR #64, 139 commits / 238 files) is merged into
> `felixtosh/FiBuKI`.
>
> **Not legal advice.** This frames the decision and the tradeoffs. FiBuKI already
> contains a working Stripe billing implementation, so this is a commercial
> product and an hour with an Austrian IP lawyer before anything goes public is
> proportionate to what is at stake.

## The one-paragraph version

There are **two** decisions here, and they are usually confused for one. The first
is *what license FiBuKI ships under*, which determines whether someone can run a
competing hosted FiBuKI. The second is *what terms contributors agree to*, which
determines whether you can still change your mind about the first one later. Both
are nearly free to settle today, with two contributors and nothing public. Both
get harder with every contributor and every merged commit, and the difficulty
never goes back down.

## Where things actually stand

| Fact | Detail |
|---|---|
| Current license | MIT, `Copyright (c) 2025-2026 FiBuKI Contributors` |
| Repo visibility | Private |
| Contributors | Two: Felix, Stefan (`yazzbert`) |
| Unmerged contribution | PR #64: 139 commits, 238 files, ~39.5k insertions |
| Contributor agreement | None |
| Commercial surface | Stripe checkout, portal, webhooks, 4 paid tiers, credit purchases |

## Correcting one premise

The reasoning "I own the code and can relicense it, since it is not public" does
not hold, in one specific respect.

**Copyright attaches on authorship, not on publication.** Stefan has owned the
copyright in their contributions since the moment they wrote them. A private repo
changes nothing about that. There is no doctrine under which unpublished code
belongs to the project owner.

What *is* true:

- **You own what you wrote**, which is most of the original product, and you can
  relicense that freely, today, without asking anyone.
- **You cannot unilaterally relicense Stefan's 238 files.** After a merge,
  separating them stops being practical.

## What MIT already gives you, and what it doesn't

Inbound-equals-outbound is the standard convention, and GitHub's Terms of Service
codify it: a pull request opened against an MIT-licensed repo arrives under MIT.
So MIT is not blocking you from shipping or selling. A CLA is not what unlocks
commercialising.

What MIT-without-a-contributor-agreement actually costs:

1. **Stefan retains their copyright.** They may reuse their own contributions
   anywhere, including in something that competes with FiBuKI.
2. **Attribution travels forever.** You can build proprietary work on top, but you
   cannot strip the notice covering their portions.
3. **No clean exclusive-ownership claim.** This is the one that surfaces in
   investment or acquisition due diligence, when someone's counsel reads the
   contributor history and asks who owns what.
4. **A future relicense needs every contributor's agreement.** Today that is one
   person you know well. It only ever grows.

## The question hiding underneath

Under MIT, anyone may fork FiBuKI in full, billing system included, and operate a
competing hosted service. Stefan may. So may a stranger who finds the repo the day
it goes public.

If that is deliberate, it is a legitimate strategy and plenty of good businesses
run it. If it is not, then **the license is the real decision and the contributor
agreement is merely what preserves your ability to make it.**

### License options

| Option | Self-host freely? | Competitor can run it as a service? | Notes |
|---|---|---|---|
| **MIT** (today) | Yes | **Yes** | Maximum adoption, zero protection |
| **AGPL-3.0** | Yes | Only if they publish all their changes | Standard copyleft answer; some companies avoid AGPL dependencies |
| **BSL 1.1** | Yes, non-competing | **No**, for a set term | Converts to an open license after N years. Sentry/HashiCorp pattern |
| **Open-core** | Core only | Core only | Needs a defensible split; ongoing overhead |

Given the stated positioning (pre-accounting for Austrian one-person businesses,
self-host and cloud shipping identical features), **AGPL or BSL fit the intent
better than MIT.** Both keep the self-host promise intact while removing the
"someone else runs your product as a service" outcome.

### Contributor-terms options

| Instrument | Effect | Enables a future relicense? |
|---|---|---|
| **DCO** (`Signed-off-by`) | Certifies the contributor had the right to submit | **No** |
| **CLA** (e.g. Apache ICLA) | Broad licence + patent grant; contributor keeps copyright | Usually yes, if drafted for it |
| **CAA / assignment** (e.g. Harmony) | Contributor assigns, or grants you relicensing rights | **Yes** |

DCO is the lightest and the most commonly reached for, and it does **not** solve
this problem. If the point is preserving your ability to change the license, it
has to be a CLA drafted for that, or a CAA.

## Recommended sequence

1. **Ask Stefan for a one-page CAA covering past and future contributions**, before
   #64 merges. Between two friends, pre-merge, this is a five-minute ask. It stops
   being one once the code is in and the contributor list grows.
2. **Decide the license separately, and before the repo goes public.** The default
   answer for this product shape is AGPL or BSL rather than MIT.
3. **Update the copyright line.** `FiBuKI Contributors` already reads as shared
   ownership. If a CAA lands, make it reflect reality.
4. **Have a lawyer review both**, given there is live billing code.

## Why the timing matters more than the choice

Every one of these gets more expensive on exactly the same curve: number of
contributors multiplied by volume of merged code. Right now that product is at its
lowest value it will ever be, and the repo is private, so nobody has relied on the
current terms yet. After #64 merges, Stefan's copyright is threaded through 238
files. After the repo goes public, third parties have MIT rights you cannot
retract.

None of this blocks the Hetzner deployment or the cutover, which touch neither
question. It blocks **merging #64** and **going public**, in that order.
