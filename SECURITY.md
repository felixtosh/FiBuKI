# Security Policy

FiBuKI is operated by Infinity Vertigo GmbH (Austria). We take security seriously. If you believe you have found a vulnerability, please report it responsibly using the channels below.

## Reporting a vulnerability

- **Email:** hello@fibuki.com — please use subject prefix `[Security]`.
- **PGP:** available on request.
- **Acknowledgement:** within 72 hours of receipt.
- **Status update:** within 7 days.
- **Coordinated disclosure:** we ask that you give us a reasonable remediation window (90 days for high/critical) before public disclosure.

## In scope

- `https://fibuki.com` and subdomains
- Firebase Cloud Functions deployed to `taxstudio-f12fb`
- Chrome extension `taxstudio-browser` (`/extensions/taxstudio-browser`)
- Mobile clients (none yet — PWA only)

## Out of scope

- Findings against third-party infrastructure (Google Cloud, Firebase, Stripe, Anthropic, Vertex AI, TrueLayer, finAPI, Plaid, SendGrid, LangFuse). Please report those directly to the vendor.
- Automated scanner output without a verified impact.
- Self-XSS or social-engineering attacks that require the user to paste attacker-supplied code.
- Best-practice findings without security impact (e.g. missing minor headers on assets that contain no PII).

## SLA

| Severity | Acknowledgement | Target fix |
| --- | --- | --- |
| Critical | 24 hours | 7 days |
| High | 72 hours | 30 days |
| Medium | 7 days | 90 days |
| Low | 14 days | Best effort |

## Safe harbour

We will not pursue legal action against good-faith security researchers who:

1. Avoid privacy violations, destruction of data, or interruption of service.
2. Do not exploit a vulnerability beyond what is necessary to confirm its existence.
3. Give us a reasonable window to fix the issue before publishing.
4. Do not access, modify, or delete other users' data.

## Hall of fame

Researchers who have responsibly disclosed valid issues are credited here (with their permission).

_No entries yet — be the first!_

## Related

- Privacy policy: https://fibuki.com/privacy
- CASA / security overview: https://fibuki.com/casa
- security.txt: https://fibuki.com/.well-known/security.txt
