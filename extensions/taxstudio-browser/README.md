FiBuKI Browser Plugin (Dev)

1) Open Chrome and go to `chrome://extensions`.
2) Enable Developer mode (top right).
3) Click "Load unpacked" and select this folder.
4) Open `http://localhost:3000/integrations/browser` to verify the connection.
5) Add a source URL and click "Run visible pull" to open a tagged tab.
6) The plugin will scan for invoice links and upload up to 5 PDFs it can access.

Edits to `content.js`, `background.js`, or `manifest.json` require clicking "Reload" on the extension card.

Release automation and Chrome Web Store requirements are documented in:
- `extensions/taxstudio-browser/RELEASING.md`
