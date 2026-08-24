# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on **`yazzbert/FiBuKI-selfhost`**
(the fork). Use the `gh` CLI for all operations.

## Always pass `-R yazzbert/FiBuKI-selfhost`

This clone has **two remotes**: `origin` is `felixtosh/FiBuKI` (upstream, not ours to
write to) and `fork` is `yazzbert/FiBuKI-selfhost` (ours). `gh` infers the repo from
`origin`, so **a bare `gh issue create` opens the issue on Felix's repo**. Every `gh`
command in this repo must carry `-R yazzbert/FiBuKI-selfhost` unless you deliberately
mean upstream.

Upstream issues (`-R felixtosh/FiBuKI`) are reserved for the merge-lane conversation —
one issue per lane, opened by hand, e.g. #82–#89 "Fork merge N/8".

## Conventions

- **Create an issue**: `gh issue create -R yazzbert/FiBuKI-selfhost --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R yazzbert/FiBuKI-selfhost --comments`.
- **List issues**: `gh issue list -R yazzbert/FiBuKI-selfhost --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> -R yazzbert/FiBuKI-selfhost --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R yazzbert/FiBuKI-selfhost --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R yazzbert/FiBuKI-selfhost --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `yazzbert/FiBuKI-selfhost`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R yazzbert/FiBuKI-selfhost --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create -R yazzbert/FiBuKI-selfhost --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**. Add an edge with `gh api --method POST repos/yazzbert/FiBuKI-selfhost/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/yazzbert/FiBuKI-selfhost/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> -R yazzbert/FiBuKI-selfhost --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer to the map's Decisions-so-far.
