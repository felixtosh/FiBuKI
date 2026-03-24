# Contributing to FiBuKI

Thanks for your interest in contributing! This guide will help you get started.

## Quick Start

1. Fork the repository and clone your fork
2. Run the setup script:
   ```bash
   npm run setup
   ```
3. Start the dev environment:
   ```bash
   npm run dev:all
   ```

See the [README](README.md) for prerequisites and more details.

## Architecture

FiBuKI follows a **Cloud Functions-first** pattern: all data mutations go through Firebase Cloud Functions, while the frontend reads data via realtime Firestore listeners (`onSnapshot`).

```
React UI / MCP / Agent  →  Cloud Functions  →  Firestore
                         (auth, logging, validation)
```

This ensures consistent business logic regardless of the caller (UI, API, AI agent).

## Key Rules

1. **All mutations go through Cloud Functions** — never write directly to Firestore from the frontend. Use `callFunction()` from `lib/firebase/callable.ts`.

2. **Type duplication** — `functions/tsconfig.json` has `rootDir: "src"`, so shared types must be duplicated between `types/` (frontend) and `functions/src/` (backend). Keep both in sync.

3. **Scoring is server-side only** — file/transaction matching logic lives exclusively in Cloud Functions. Never implement local scoring in hooks or components.

4. **Transactions cannot be deleted individually** — they're tied to bank account imports. Delete the entire source instead, or mark the transaction with a category/note.

## Adding a New Feature

1. Add types to `types/your-feature.ts`
2. Create a callable in `functions/src/feature/yourCallable.ts` using the `createCallable()` wrapper
3. Export from `functions/src/index.ts`
4. Call from the frontend via `callFunction()` in `lib/firebase/callable.ts`
5. Use `onSnapshot` in hooks for realtime reads

See [CLAUDE.md](CLAUDE.md) for the full architecture reference and examples.

## Running Checks

```bash
# Lint
npm run lint

# Type-check frontend
npx tsc --noEmit

# Type-check and build Cloud Functions
cd functions && npm run build
```

## PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a summary of what changed and why
- Run lint and type-check before submitting
- For large changes, open an issue first to discuss the approach

## Project Layout

| Directory | Purpose |
|-----------|---------|
| `app/` | Next.js pages (App Router) |
| `components/` | React components (Radix UI + CVA) |
| `hooks/` | Custom React hooks |
| `lib/` | Utilities, Firebase clients |
| `types/` | Shared TypeScript interfaces |
| `functions/src/` | Cloud Functions |
| `extensions/` | Browser extension |
