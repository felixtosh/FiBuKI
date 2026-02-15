## Chrome Web Store release contract

This extension is published automatically when a GitHub Release is published.

Workflow file:
- `.github/workflows/chrome-web-store-release.yml`

Trigger:
- `release.published` on the repository

### Required repository secrets

These secrets must exist in GitHub repo settings for the workflow to succeed:
- `CWS_SERVICE_ACCOUNT_EMAIL`
- `CWS_SERVICE_ACCOUNT_KEY`
- `CWS_PUBLISHER_ID`
- `CWS_EXTENSION_ID`

### Required pre-release step

Before creating a release, always bump:
- `extensions/taxstudio-browser/manifest.json` -> `version`

Chrome Web Store rejects uploads when the version does not increase.

### Release procedure

1. Update extension code if needed.
2. Increase `manifest.json` version.
3. Commit and push.
4. Create and publish a GitHub Release.
5. Verify workflow run `Publish Chrome Extension` completed successfully.
6. Confirm new version appears in Chrome Web Store dashboard status.

### If permissions or data usage change

When modifying extension permissions, host permissions, data access behavior, or remote code behavior:
- update Chrome Web Store listing questionnaire fields
- update privacy disclosures if needed
- expect potentially longer review time

### Agent checklist for extension-related changes

If a change touches files in `extensions/taxstudio-browser/` or `.github/workflows/chrome-web-store-release.yml`, verify:
- `manifest.json` version policy is respected
- release workflow still points to `extensions/taxstudio-browser`
- no required CWS secret names were changed
- packaging excludes test/dev-only files as intended
