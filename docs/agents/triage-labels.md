# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Which of these exist today

`ready-for-agent` and `wontfix` already exist on `yazzbert/FiBuKI-selfhost` and carry
exactly these meanings. `needs-triage`, `needs-info` and `ready-for-human` do **not**
exist yet — create them on first use:

```bash
gh label create needs-triage -R yazzbert/FiBuKI-selfhost --description "Maintainer needs to evaluate this issue" --color FBCA04
gh label create needs-info -R yazzbert/FiBuKI-selfhost --description "Waiting on reporter for more information" --color D4C5F9
gh label create ready-for-human -R yazzbert/FiBuKI-selfhost --description "Requires human implementation" --color 5319E7
```
