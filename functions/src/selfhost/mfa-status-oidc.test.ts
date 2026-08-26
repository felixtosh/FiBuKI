/**
 * getMfaStatus against a uid Firebase Auth has never heard of (fork #122).
 *
 * In OIDC-issuer mode the self-host verifier is `createOidcVerifier`, and
 * nothing inserts an `auth_users` row for the OIDC uid — that table is
 * populated only by the built-in Better Auth path. `AuthShim.getUser` therefore
 * throws `auth/user-not-found` for a uid that is otherwise perfectly valid, and
 * every other callable on the same page load accepts it.
 *
 * The MFA panel read that record purely to ask whether Firebase Auth holds a
 * TOTP second factor. In OIDC mode it cannot, by definition — so a missing
 * record is the answer "no", not a crash.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ getUser }) }));

import { readFirebaseTotpEnrolment } from "../auth/mfaFunctions";

class ShimError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AuthShimError";
  }
}

const OIDC_UID = "5d5b322498fb4e0f9c1d";

describe("readFirebaseTotpEnrolment", () => {
  beforeEach(() => {
    getUser.mockReset();
  });

  it("reports no enrolment when the uid has no auth_users row", async () => {
    getUser.mockImplementation(async () => {
      throw new ShimError("auth/user-not-found", `selfhost auth: no user with uid ${OIDC_UID}`);
    });
    await expect(readFirebaseTotpEnrolment(OIDC_UID)).resolves.toBe(false);
  });

  it("reports no enrolment when the record carries no factors", async () => {
    getUser.mockImplementation(async () => ({ multiFactor: undefined }));
    await expect(readFirebaseTotpEnrolment(OIDC_UID)).resolves.toBe(false);
  });

  it("reports no enrolment when the only factor is not TOTP", async () => {
    getUser.mockImplementation(async () => ({ multiFactor: { enrolledFactors: [{ factorId: "phone" }] } }));
    await expect(readFirebaseTotpEnrolment(OIDC_UID)).resolves.toBe(false);
  });

  it("reports enrolment when a TOTP factor is present", async () => {
    getUser.mockImplementation(async () => ({ multiFactor: { enrolledFactors: [{ factorId: "totp" }] } }));
    await expect(readFirebaseTotpEnrolment(OIDC_UID)).resolves.toBe(true);
  });

  // The degradation is scoped to one code. A database that is down, a revoked
  // token, an argument error — those still surface, rather than being reported
  // to the user as "MFA is off".
  it("rethrows any other failure", async () => {
    getUser.mockImplementation(async () => {
      throw new ShimError("auth/argument-error", "selfhost auth: invalid or revoked token");
    });
    await expect(readFirebaseTotpEnrolment(OIDC_UID)).rejects.toThrow("invalid or revoked token");
  });

  it("rethrows a plain error with no code", async () => {
    getUser.mockImplementation(async () => {
      throw new Error("connection terminated unexpectedly");
    });
    await expect(readFirebaseTotpEnrolment(OIDC_UID)).rejects.toThrow("connection terminated");
  });
});
