# FiBuKI

**AI-powered bookkeeping for freelancers and small businesses.**

FiBuKI automates the tedious parts of accounting: importing bank transactions, scanning receipts, matching invoices to payments, and preparing tax reports — so you can focus on your business.

## Features

- **Bank Transaction Import** — CSV upload or direct bank connections via TrueLayer / finAPI / Plaid
- **Receipt & Invoice Scanning** — AI-powered extraction from PDFs, images, and emails (Gemini via Vertex AI)
- **Automatic Matching** — Smart scoring engine connects receipts to transactions with confidence scores
- **Partner Management** — Auto-detects vendors/clients, learns billing patterns, validates VAT IDs via VIES
- **Gmail Integration** — Scans your inbox for invoices and receipts automatically
- **AI Chat Assistant** — Ask questions about your finances using Claude with tool access
- **Tax Reports** — UVA (Austrian VAT return) generation, BMD export, FinanzOnline submission
- **Multi-Country Expansion** — Community-backed rollout to additional EU countries
- **MFA & Passkeys** — WebAuthn passkey support alongside TOTP and backup codes
- **Browser Extension** — Capture receipts from web portals directly into FiBuKI
- **MCP Server** — Expose your financial data to AI assistants via Model Context Protocol

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS v4, Radix UI, CVA |
| Backend | Firebase Cloud Functions (Node.js 20) |
| Database | Cloud Firestore |
| Storage | Firebase Storage (receipts, exports) |
| Auth | Firebase Auth (email/password, Google, passkeys) |
| AI — Chat | Anthropic Claude (via LangChain / LangGraph) |
| AI — Extraction | Google Gemini Flash via Vertex AI |
| Banking | TrueLayer, finAPI, Plaid |
| Payments | Stripe (subscriptions, credits, country backing) |
| Email | SendGrid (transactional), Gmail API (receipt scanning) |
| Hosting | Firebase App Hosting (frontend), Cloud Functions (API) |

## Architecture

All data mutations flow through Cloud Functions, ensuring a single source of truth regardless of the caller:

```
┌─────────────────────────────────────────────────────────────────┐
│                        CONSUMERS                                │
│  React UI  │  MCP Server  │  LangGraph Agent  │  Browser Ext    │
└─────────────────────────────────────────────────────────────────┘
                              │
                    httpsCallable / HTTP
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  CLOUD FUNCTIONS (europe-west1)                 │
│  createCallable() wrapper — auth, usage logging, error handling │
│                                                                 │
│  transactions/ │ files/ │ partners/ │ matching/ │ billing/      │
└─────────────────────────────────────────────────────────────────┘
                              │
                         Admin SDK
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         FIRESTORE                               │
│  transactions │ files │ partners │ sources │ subscriptions      │
└─────────────────────────────────────────────────────────────────┘
```

Frontend reads use realtime Firestore listeners (`onSnapshot`) in React hooks. Writes always go through Cloud Functions via `callFunction()`.

## Getting Started

### Prerequisites

- Node.js 20.x
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project with Firestore, Storage, and Auth enabled

### Setup

```bash
# Clone the repository
git clone https://github.com/YOUR_ORG/fibuki.git
cd fibuki

# Install dependencies
npm install
cd functions && npm install && cd ..

# Configure environment
cp .env.example .env.local
# Fill in your Firebase config and API keys (see .env.example for details)

# Start Firebase emulators + Next.js dev server
npm run dev:all
```

The app will be available at `http://localhost:3000` with emulators providing Firestore, Auth, Storage, and Cloud Functions locally.

### Generate Test Data

Once running, navigate to **Sources** (`/sources`) and toggle **Enable Test Data** to create a test bank account with 100 sample transactions.

## Project Structure

```
app/
├── (auth)/              # Login, registration pages
├── (dashboard)/         # Main app (sources, transactions, files, partners, settings)
├── (marketing)/         # Landing pages
└── api/                 # Next.js API routes (banking, Gmail, MCP proxy)

components/              # React components (Radix UI + CVA)
hooks/                   # Custom React hooks (realtime listeners, mutations)
lib/                     # Utilities, Firebase clients, banking providers
types/                   # Shared TypeScript interfaces

functions/
└── src/
    ├── auth/            # Registration, admin claims, MFA, passkeys
    ├── billing/         # Stripe integration, quotas, AI budget
    ├── extraction/      # Document parsing (Gemini, Vision API)
    ├── files/           # File CRUD, connect/disconnect
    ├── imports/         # CSV import, column matching
    ├── matching/        # Score engine, partner detection, learning
    ├── partners/        # Partner CRUD, VIES lookup
    ├── transactions/    # Transaction CRUD, bulk operations
    └── utils/           # createCallable wrapper, AI usage logger

extensions/
└── taxstudio-browser/   # Chrome extension for receipt capture
```

## Deployment

### Frontend (Next.js)

Hosted on **Firebase App Hosting**. Auto-deploys on push to `main`.

### Cloud Functions

Cloud Functions are **not** auto-deployed. After changes:

```bash
firebase deploy --only functions
# Or deploy specific functions:
firebase deploy --only functions:functionName
```

### Firestore Rules & Indexes

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

## Browser Extension

The Chrome extension lives in `extensions/taxstudio-browser/`. See [`extensions/taxstudio-browser/RELEASING.md`](extensions/taxstudio-browser/RELEASING.md) for release instructions.

## Contributing

Contributions are welcome! Please open an issue before starting work on large changes.

A few things to know:

- **All mutations go through Cloud Functions** — never write directly to Firestore from the frontend
- **Type duplication** — `functions/tsconfig.json` has `rootDir: "src"`, so shared types must be duplicated between `types/` (frontend) and `functions/src/` (backend)
- **Scoring is server-side only** — file/transaction matching logic lives exclusively in Cloud Functions

## License

[MIT](LICENSE)
