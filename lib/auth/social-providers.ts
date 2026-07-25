/**
 * Which social sign-in providers this build actually supports.
 *
 * The shared login / register UI renders one button per social provider, but
 * the self-host build only wires **Google**: `lib/selfhost/auth-client.ts`
 * `signInWithPopup` rejects every non-Google provider outright, so the GitHub
 * button is a dead control there — it can only ever surface an error. Gate the
 * UI on this instead of shipping a button that cannot work.
 *
 * The Firebase build supports both, so both helpers return `true` there.
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

/** GitHub social sign-in is available (Firebase build only, not self-host). */
export function githubSignInEnabled(): boolean {
  return !isSelfhostBuild();
}
