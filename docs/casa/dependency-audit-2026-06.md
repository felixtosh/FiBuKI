# Dependency Audit — 2026-06-22

This report captures the state of `npm audit` before and after the
2026-06 remediation pass, and documents the remaining moderate-severity
findings with their compensating controls.

## Baseline (before remediation)

| Package set | Total | Critical | High | Moderate | Low |
| --- | --- | --- | --- | --- | --- |
| Root (`package.json`) | 30 | 3 | 10 | 15 | 2 |
| Functions (`functions/package.json`) | 22 | 1 | 7 | 13 | 1 |

GitHub Dependabot reported 84 alerts on `main`, counting each affected
manifest path separately.

## After non-breaking remediation (`npm audit fix`)

| Package set | Total | Critical | High | Moderate | Low |
| --- | --- | --- | --- | --- | --- |
| Root | 10 | 0 | 0 | 10 | 0 |
| Functions | 8 | 0 | 0 | 8 | 0 |

All critical and high-severity findings closed. Build, typecheck, and
the 469-case functions test suite still pass.

## Remaining moderates: assessment

Both remaining sets reduce to two underlying issues that npm's resolver
refuses to fix without a destructive downgrade:

### 1. `uuid` < 11.1.1 — missing buffer bounds check (CVSS 5.3, moderate)

| Field | Value |
| --- | --- |
| Advisory | GHSA-w5hq-g745-h8pq |
| Affected pathway | `firebase-admin` 13.10.0 → transitive uuid |
| `npm audit fix --force` suggestion | Downgrade to `firebase-admin@10.3.0` (rejected — would lose 3 major versions of bug fixes and feature support) |
| Real impact on FiBuKI | None. The bounds check triggers only when callers pass a custom `buf` argument to `uuid.v3`/`v5`/`v6`. FiBuKI never invokes uuid with a custom buffer; we use the default behaviour. firebase-admin itself does not call those code paths. |
| Compensating control | Track upstream: monitor `firebase-admin` releases for the uuid bump. |

### 2. `postcss` < 8.5.10 inside Next.js dev tooling

| Field | Value |
| --- | --- |
| Affected pathway | Build-time, dev-mode CSS pipeline of Next.js |
| `npm audit fix --force` suggestion | Downgrade to `next@9.3.3` (rejected — would break the entire app, we are on `next@16`) |
| Real impact on FiBuKI | None at runtime. postcss is build-time only and runs against trusted CSS in our own repo; it is not exposed to user input. |
| Compensating control | Will resolve when Next.js bumps its bundled postcss in a future patch release. |

## Decision

Accept both remaining moderate findings with the compensating controls
above. Re-evaluate on the next dependency-audit cycle (target:
quarterly).

## Re-scan log

| Date | Tool | Findings | Notes |
| --- | --- | --- | --- |
| 2026-06-22 | `npm audit` (root + functions) | 0 critical, 0 high, 18 moderate | Pre-CASA submission baseline. |

## How to re-run

```sh
npm audit              # root
cd functions && npm audit
# To apply non-breaking patches again after future Dependabot alerts:
npm audit fix
cd functions && npm audit fix
```

For supply-chain visibility outside `npm audit`, the GitHub Dependabot
dashboard at https://github.com/felixtosh/FiBuKI/security/dependabot is
the source of truth.
