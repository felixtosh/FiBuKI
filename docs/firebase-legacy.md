# Firebase (legacy)

Moved out of `CLAUDE.md`. `fibuki.com` runs the self-host stack; this applies only to the retained `taxstudio-f12fb` project.

## Firebase (legacy, for the retained project only)
The sections below still describe the Firebase deployment. They apply to the
retained `taxstudio-f12fb` project, which is the rollback anchor until the soak
window closes (see [`docs/w4-cutover-runbook.md`](docs/w4-cutover-runbook.md)
step 9), and NOT to what serves `fibuki.com` today.

**Never delete `taxstudio-f12fb`:** it owns the Google OAuth client
(`GOOGLE_CLIENT_ID`) that Gmail connections on fibuki.com use. Its Firestore and
Storage rules are deny-all for clients (the frozen data copy serves no one);
they are not the access policy, `data-policy.ts` is.

## Cloud Functions
- Deploy manually: `firebase deploy --only functions`
- Region: `europe-west1`
- Deploy specific functions: `firebase deploy --only functions:functionName`
- **IMPORTANT**: Cloud Functions are NOT auto-deployed on push. When you create or modify Cloud Functions, you MUST deploy them after pushing:
  ```bash
  firebase deploy --only functions:fn1,functions:fn2
  ```
- CORS origins are configured in `createCallable()` wrapper (`functions/src/utils/createCallable.ts`). New callables using `createCallable()` inherit CORS automatically. Standalone `onCall()` functions must include the same CORS origins array.

## Firestore Rules & Indexes
- `firestore.rules` and `storage.rules` are deny-all on purpose (see above).
  They only change if the project is ever used again; a rollback restores the
  pre-cutover rules from git history.
- **NOT auto-deployed on push**. When modifying them, deploy after pushing:
  ```bash
  firebase deploy --only firestore:rules,storage --project taxstudio-f12fb
  firebase deploy --only firestore:indexes --project taxstudio-f12fb
  ```
