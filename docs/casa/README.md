# FiBuKI — CASA Tier 2 Documentation

This directory contains the security artifacts required for the Google Cloud Application Security Assessment (CASA) Tier 2 review, conducted as part of OAuth verification for the `gmail.readonly` restricted scope.

| Application | FiBuKI (https://fibuki.com) |
| --- | --- |
| Operator | Infinity Vertigo GmbH (FN571837m, ATU77919424) |
| Restricted scope under review | `https://www.googleapis.com/auth/gmail.readonly` |
| Assessment tier | CASA Tier 2 |
| Framework | OWASP ASVS v4.0 (134 requirements) |
| Document set version | 2.0 |
| Last updated | 2026-06-21 |

## Artifacts

| # | Document | Purpose |
| --- | --- | --- |
| 01 | [Security Architecture](./01-security-architecture.md) | Trust boundaries, auth flows, data-protection layers |
| 02 | [PII Data Flow](./02-pii-data-flow.md) | PII entry points, storage, access controls |
| 03 | [OAuth Scope Justification](./03-oauth-scope-justification.md) | Rationale for `gmail.readonly`, minimum-scope argument |
| 04 | [Data Retention Policy](./04-data-retention-policy.md) | Storage duration and deletion procedures per data type |
| 05 | [Tier 2 Checklist](./05-tier2-checklist.md) | ASVS v4.0 mapping with status + evidence pointers |
| 06 | [Self-Assessment Questionnaire](./06-saq.md) | Responses to the 54 CASA Tier 2 controls |
| 07 | [SAST Remediation Report](./07-sast-remediation-report.md) | Static-analysis scan results and fixes |
| 08 | [DAST Remediation Report](./08-dast-remediation-report.md) | Dynamic-scan results (OWASP ZAP, Fluid Attacks) and fixes |

## Companion documents

- Public Security hub: https://fibuki.com/casa
- Privacy Policy: https://fibuki.com/privacy
- Terms of Service: https://fibuki.com/terms
- Limited Use Disclosure: included in `/casa` and `/privacy`
- Vulnerability Disclosure: [`/SECURITY.md`](../../SECURITY.md) and https://fibuki.com/.well-known/security.txt

## Submission bundle

To produce the PDF bundle for the assessor:

```sh
# Render each markdown to PDF (via the /make-pdf workflow or pandoc)
pandoc docs/casa/01-security-architecture.md -o build/casa/01-security-architecture.pdf
# ...repeat for 02-08
```

## Change log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0 | 2026-01 | Felix Häusler | Initial submission as single `/casa` page |
| 2.0 | 2026-06-21 | Felix Häusler | Split into 8 artifacts per CASA Tier 2 best practice |
