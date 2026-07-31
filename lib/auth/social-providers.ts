/**
 * Which social sign-in providers this build actually supports.
 *
 * The shared login / register UI renders one button per social provider. Shipping a
 * button that cannot work is worse than shipping none, so the UI gates on these.
 *
 * Both providers now work on both tiers. The self-host host registers a provider
 * only when both halves of its OAuth credential pair are set
 * (functions/src/selfhost/better-auth.ts `socialProviders`), and the client shim
 * accepts either (lib/selfhost/auth-client.ts `signInWithPopup`).
 *
 * GitHub used to be hidden under self-host because the shim rejected every
 * non-Google provider outright. That left any GitHub-only account with NO route in
 * — one such account exists in the migrated production data — and contradicted the
 * rule that self-host and cloud ship the same features, differing only in effort
 * and infrastructure.
 */

/**
 * True in the self-host build. `next.config.ts` injects
 * `NEXT_PUBLIC_FIBUKI_BACKEND="selfhost"` when `FIBUKI_BACKEND=selfhost`.
 *
 * Read via a LITERAL `process.env.X` member expression: Next.js only inlines
 * client-side env vars by textual match of that exact access, so a computed
 * `process.env[name]` would evaluate to undefined in the browser bundle. Same
 * rule the auth-client shim documents.
 */
export function isSelfhostBuild(): boolean {
  return process.env.NEXT_PUBLIC_FIBUKI_BACKEND === "selfhost";
}

/**
 * GitHub social sign-in is available.
 *
 * Always on the Firebase build. On self-host it depends on whether the operator
 * configured GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET on the host, which the browser
 * cannot see — so the web build is told explicitly via
 * NEXT_PUBLIC_GITHUB_SIGNIN_ENABLED (a compose build arg, since NEXT_PUBLIC_* are
 * inlined at build time). Defaults to off, so an operator without a GitHub OAuth
 * app still gets no dead button.
 */
export function githubSignInEnabled(): boolean {
  if (!isSelfhostBuild()) return true;
  return process.env.NEXT_PUBLIC_GITHUB_SIGNIN_ENABLED === "true";
}
