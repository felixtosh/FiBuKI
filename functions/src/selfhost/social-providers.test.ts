/**
 * Gating for the shared login / register social buttons
 * (lib/auth/social-providers.ts).
 *
 * The self-host auth client only services Google; the GitHub button is a dead
 * control there (signInWithPopup rejects every non-Google provider). The
 * shared UI hides it based on these helpers, so pin the flag logic. The JSX
 * conditional itself is trivial and covered by the app's lint + build job —
 * there is no React render harness in this tree.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSelfhostBuild, githubSignInEnabled } from "../../../lib/auth/social-providers";

describe("social-providers — GitHub button gating", () => {
  const KEY = "NEXT_PUBLIC_FIBUKI_BACKEND";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("Firebase build (flag unset): GitHub sign-in is enabled", () => {
    delete process.env[KEY];
    expect(isSelfhostBuild()).toBe(false);
    expect(githubSignInEnabled()).toBe(true);
  });

  it("self-host build: GitHub is a dead control and stays hidden", () => {
    process.env[KEY] = "selfhost";
    expect(isSelfhostBuild()).toBe(true);
    expect(githubSignInEnabled()).toBe(false);
  });

  it("an unrelated backend value leaves GitHub enabled (exact match only)", () => {
    process.env[KEY] = "firebase";
    expect(isSelfhostBuild()).toBe(false);
    expect(githubSignInEnabled()).toBe(true);
  });
});
