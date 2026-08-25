# Issue tracker: GitHub

Issues and specs for this project live as GitHub issues on **`felixtosh/FiBuKI`** — the
one trunk. Use the `gh` CLI for all operations.

## Writing upstream needs a classic token

A fine-grained PAT can only be scoped to repositories its owner owns, so it can never
write to `felixtosh/FiBuKI`. The box's default `gh` login is fine-grained: it reads fine
and fails every write with `HTTP 403: Resource not accessible by personal access token`.
For writes, source the classic token and pass it per command:

```bash
. ~/.secrets/github-classic.env
GH_TOKEN=$GH_CLASSIC_TOKEN gh issue create -R felixtosh/FiBuKI --title "..." --body "..."
```

Never print the value; verify the file by key name only
(`awk -F= '/^[A-Z_]+=/{print $1}' ~/.secrets/github-classic.env`).

## Until the fork is archived

`yazzbert/FiBuKI-selfhost` still holds open issues and is where the lane branches live.
It is being retired — see the map, "One trunk: land the fork on main and retire the fork"
(felixtosh/FiBuKI#93). File **new** work upstream; touch fork issues only to migrate or
close them. A clone with both remotes infers `gh`'s repo from `origin`, so pass `-R`
explicitly either way.

## Conventions

- **Create an issue**: `gh issue create -R felixtosh/FiBuKI --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R felixtosh/FiBuKI --comments`.
- **List issues**: `gh issue list -R felixtosh/FiBuKI --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> -R felixtosh/FiBuKI --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R felixtosh/FiBuKI --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R felixtosh/FiBuKI --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `felixtosh/FiBuKI`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R felixtosh/FiBuKI --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create -R felixtosh/FiBuKI --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**. Add an edge with `gh api --method POST repos/felixtosh/FiBuKI/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/felixtosh/FiBuKI/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> -R felixtosh/FiBuKI --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer to the map's Decisions-so-far.
