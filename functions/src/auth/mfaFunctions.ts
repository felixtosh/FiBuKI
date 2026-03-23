import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { createHash, randomBytes } from "crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "";
const RP_NAME = "FiBuKI";

const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

// WebAuthn configuration for different environments
// Passkeys are domain-bound, so we need to track which RP ID was used during registration
const WEBAUTHN_CONFIG: Record<string, { rpId: string; origin: string }> = {
  "http://localhost:3000": { rpId: "localhost", origin: "http://localhost:3000" },
  "https://fibuki.com": { rpId: "fibuki.com", origin: "https://fibuki.com" },
  "https://www.fibuki.com": { rpId: "fibuki.com", origin: "https://www.fibuki.com" },
};

// Helper to get WebAuthn config from client-provided origin
function getWebAuthnConfig(clientOrigin?: string): { rpId: string; origin: string } {
  if (clientOrigin && WEBAUTHN_CONFIG[clientOrigin]) {
    return WEBAUTHN_CONFIG[clientOrigin];
  }
  // Default based on environment
  if (process.env.FUNCTIONS_EMULATOR) {
    return WEBAUTHN_CONFIG["http://localhost:3000"];
  }
  // Production default
  return WEBAUTHN_CONFIG["https://fibuki.com"];
}

// Helper to get Firestore paths
const getMfaSettingsPath = (userId: string) =>
  `users/${userId}/mfaSettings/config`;
const getPasskeysPath = (userId: string) => `users/${userId}/passkeys`;
const getBackupCodesPath = (userId: string) => `users/${userId}/backupCodes`;
const getPasskeyChallengePath = (userId: string) =>
  `users/${userId}/passkeyChallenge/current`;

// ============ Backup Codes ============

/**
 * Generate 10 backup codes for a user
 * Returns the plain codes (shown only once) and stores hashes
 */
export const generateBackupCodes = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const userId = request.auth.uid;
    const db = getFirestore();

    // Check if user has MFA enabled (must have at least TOTP or passkey)
    const settingsRef = db.doc(getMfaSettingsPath(userId));
    const settings = await settingsRef.get();

    if (!settings.exists) {
      // Initialize settings
      await settingsRef.set({
        userId,
        totpEnabled: false,
        passkeysEnabled: false,
        backupCodesGenerated: false,
        backupCodesRemaining: 0,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
    }

    // Delete any existing backup codes
    const existingCodes = await db
      .collection(getBackupCodesPath(userId))
      .get();
    const batch = db.batch();
    existingCodes.docs.forEach((doc) => batch.delete(doc.ref));

    // Generate 10 new backup codes (format: XXXX-XXXX)
    const codes: string[] = [];
    const now = Timestamp.now();

    for (let i = 0; i < 10; i++) {
      const code =
        randomBytes(4).toString("hex").toUpperCase().slice(0, 4) +
        "-" +
        randomBytes(4).toString("hex").toUpperCase().slice(0, 4);
      codes.push(code);

      // Hash the code for storage
      const codeHash = createHash("sha256").update(code).digest("hex");

      const codeRef = db.collection(getBackupCodesPath(userId)).doc();
      batch.set(codeRef, {
        userId,
        codeHash,
        used: false,
        createdAt: now,
      });
    }

    // Update MFA settings
    batch.update(settingsRef, {
      backupCodesGenerated: true,
      backupCodesGeneratedAt: now,
      backupCodesRemaining: 10,
      updatedAt: now,
    });

    await batch.commit();

    // Log audit event
    await db.collection("mfaAuditLogs").add({
      userId,
      action: settings.exists ? "backup_codes_regenerated" : "backup_codes_generated",
      method: "backup_code",
      timestamp: now,
    });

    console.log(`Generated 10 backup codes for user ${userId}`);

    return {
      codes,
      generatedAt: now.toDate().toISOString(),
    };
  }
);

/**
 * Verify a backup code during MFA challenge
 * Consumes the code if valid
 */
export const verifyBackupCode = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { code } = request.data;
    if (!code || typeof code !== "string") {
      throw new HttpsError("invalid-argument", "Code is required");
    }

    const userId = request.auth.uid;
    const db = getFirestore();

    // Hash the provided code
    const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const formattedCode =
      normalizedCode.slice(0, 4) + "-" + normalizedCode.slice(4, 8);
    const codeHash = createHash("sha256").update(formattedCode).digest("hex");

    // Find matching unused backup code
    const codesSnapshot = await db
      .collection(getBackupCodesPath(userId))
      .where("codeHash", "==", codeHash)
      .where("used", "==", false)
      .limit(1)
      .get();

    if (codesSnapshot.empty) {
      // Log failed attempt
      await db.collection("mfaAuditLogs").add({
        userId,
        action: "challenge_failed",
        method: "backup_code",
        timestamp: Timestamp.now(),
      });

      throw new HttpsError("invalid-argument", "Invalid or already used backup code");
    }

    const codeDoc = codesSnapshot.docs[0];
    const now = Timestamp.now();

    // Mark code as used
    const batch = db.batch();
    batch.update(codeDoc.ref, {
      used: true,
      usedAt: now,
    });

    // Decrement remaining codes count and update lastMfaMethod
    const settingsRef = db.doc(getMfaSettingsPath(userId));
    batch.update(settingsRef, {
      backupCodesRemaining: FieldValue.increment(-1),
      lastMfaMethod: "backup_code",
      lastMfaMethodAt: now,
      updatedAt: now,
    });

    await batch.commit();

    // Log success
    await db.collection("mfaAuditLogs").add({
      userId,
      action: "challenge_success",
      method: "backup_code",
      timestamp: now,
    });

    console.log(`Backup code verified for user ${userId}`);

    return { success: true };
  }
);

// ============ MFA Status ============

/**
 * Get comprehensive MFA status for a user
 */
export const getMfaStatus = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const userId = request.auth.uid;
    const db = getFirestore();

    // Get settings
    const settingsDoc = await db.doc(getMfaSettingsPath(userId)).get();
    const settings = settingsDoc.data() || {
      totpEnabled: false,
      passkeysEnabled: false,
      backupCodesRemaining: 0,
    };

    // Get passkeys
    const passkeysSnapshot = await db
      .collection(getPasskeysPath(userId))
      .orderBy("createdAt", "desc")
      .get();

    const passkeys = passkeysSnapshot.docs.map((doc) => ({
      id: doc.id,
      deviceName: doc.data().deviceName,
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
      lastUsedAt: doc.data().lastUsedAt?.toDate?.()?.toISOString() || null,
    }));

    // Get remaining backup codes count
    const backupCodesSnapshot = await db
      .collection(getBackupCodesPath(userId))
      .where("used", "==", false)
      .count()
      .get();

    const backupCodesRemaining = backupCodesSnapshot.data().count;

    // Check Firebase Auth MFA enrollment
    const auth = getAuth();
    const userRecord = await auth.getUser(userId);
    const totpEnrolled =
      userRecord.multiFactor?.enrolledFactors?.some(
        (factor) => factor.factorId === "totp"
      ) ?? false;

    return {
      totpEnabled: settings.totpEnabled || totpEnrolled,
      passkeysEnabled: passkeys.length > 0,
      passkeyCount: passkeys.length,
      passkeys,
      backupCodesRemaining,
      hasAnyMfa: settings.totpEnabled || totpEnrolled || passkeys.length > 0,
      lastMfaMethod: settings.lastMfaMethod || null,
    };
  }
);

// ============ Admin Functions ============

/**
 * Admin function to reset MFA for a locked-out user
 */
export const adminResetMfa = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    // Verify caller is admin
    const callerEmail = request.auth.token.email;
    const callerIsAdmin = request.auth.token.admin === true;

    if (!callerIsAdmin && callerEmail !== SUPER_ADMIN_EMAIL) {
      throw new HttpsError("permission-denied", "Only admins can reset MFA");
    }

    const { targetUserId, reason } = request.data;
    if (!targetUserId) {
      throw new HttpsError("invalid-argument", "targetUserId is required");
    }

    const db = getFirestore();
    const auth = getAuth();
    const now = Timestamp.now();

    try {
      // Get target user info for logging
      const targetUser = await auth.getUser(targetUserId);

      // Unenroll all MFA factors from Firebase Auth
      if (targetUser.multiFactor?.enrolledFactors?.length) {
        // Firebase Admin SDK doesn't have direct MFA unenroll
        // We need to use a workaround by setting custom claims
        // The user will need to re-enroll
        console.log(
          `User ${targetUser.email} has ${targetUser.multiFactor.enrolledFactors.length} MFA factors`
        );
      }

      // Delete all passkeys
      const passkeysSnapshot = await db
        .collection(getPasskeysPath(targetUserId))
        .get();
      const batch = db.batch();
      passkeysSnapshot.docs.forEach((doc) => batch.delete(doc.ref));

      // Delete all backup codes
      const codesSnapshot = await db
        .collection(getBackupCodesPath(targetUserId))
        .get();
      codesSnapshot.docs.forEach((doc) => batch.delete(doc.ref));

      // Reset MFA settings
      const settingsRef = db.doc(getMfaSettingsPath(targetUserId));
      batch.set(
        settingsRef,
        {
          userId: targetUserId,
          totpEnabled: false,
          totpFactorId: null,
          totpEnrolledAt: null,
          passkeysEnabled: false,
          backupCodesGenerated: false,
          backupCodesGeneratedAt: null,
          backupCodesRemaining: 0,
          updatedAt: now,
        },
        { merge: true }
      );

      await batch.commit();

      // Log audit event
      await db.collection("mfaAuditLogs").add({
        userId: targetUserId,
        action: "admin_reset",
        performedBy: request.auth.uid,
        metadata: { reason, adminEmail: callerEmail },
        timestamp: now,
      });

      console.log(
        `MFA reset for user ${targetUser.email} by admin ${callerEmail}`
      );

      return {
        success: true,
        targetEmail: targetUser.email,
      };
    } catch (error) {
      console.error("Error resetting MFA:", error);
      throw new HttpsError("internal", "Failed to reset MFA");
    }
  }
);

// ============ Passkey Functions ============

/**
 * Generate WebAuthn registration options for passkey enrollment
 */
export const generatePasskeyRegistrationOptions = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { origin: clientOrigin } = request.data || {};
    const config = getWebAuthnConfig(clientOrigin);

    const userId = request.auth.uid;
    const userEmail = request.auth.token.email || "user@example.com";
    const db = getFirestore();

    // Get existing passkeys to exclude
    const existingPasskeys = await db
      .collection(getPasskeysPath(userId))
      .get();

    const excludeCredentials = existingPasskeys.docs.map((doc) => ({
      id: doc.data().credentialId as string,
      transports: doc.data().transports as AuthenticatorTransportFuture[],
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: config.rpId,
      userID: Buffer.from(userId),
      userName: userEmail,
      userDisplayName: userEmail.split("@")[0],
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
        authenticatorAttachment: undefined, // Allow any
      },
      timeout: 60000,
    });

    // Store challenge and RP ID for verification
    await db.doc(getPasskeyChallengePath(userId)).set({
      challenge: options.challenge,
      type: "registration",
      rpId: config.rpId,
      origin: config.origin,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000), // 5 min
    });

    return options;
  }
);

/**
 * Verify passkey registration and store credential
 */
export const verifyPasskeyRegistration = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { credential, deviceName } = request.data;
    if (!credential) {
      throw new HttpsError("invalid-argument", "Credential is required");
    }

    const userId = request.auth.uid;
    const db = getFirestore();

    // Get stored challenge
    const challengeDoc = await db.doc(getPasskeyChallengePath(userId)).get();
    if (!challengeDoc.exists) {
      throw new HttpsError("failed-precondition", "No registration in progress");
    }

    const challengeData = challengeDoc.data()!;
    if (challengeData.type !== "registration") {
      throw new HttpsError("failed-precondition", "Invalid challenge type");
    }

    if (challengeData.expiresAt.toMillis() < Date.now()) {
      throw new HttpsError("deadline-exceeded", "Registration challenge expired");
    }

    // Use the stored RP ID and origin from challenge
    const rpId = challengeData.rpId || getWebAuthnConfig().rpId;
    const expectedOrigin = challengeData.origin || getWebAuthnConfig().origin;

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response: credential as RegistrationResponseJSON,
        expectedChallenge: challengeData.challenge,
        expectedOrigin,
        expectedRPID: rpId,
      });
    } catch (error) {
      console.error("Passkey registration verification failed:", error);
      throw new HttpsError("invalid-argument", "Invalid registration response");
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpsError("invalid-argument", "Registration verification failed");
    }

    const { registrationInfo } = verification;
    const now = Timestamp.now();

    // Store the credential with RP ID for future authentication
    // credential.id is already a base64url string in @simplewebauthn/server v10+
    const credentialIdBase64 = typeof registrationInfo.credential.id === "string"
      ? registrationInfo.credential.id
      : Buffer.from(registrationInfo.credential.id).toString("base64url");

    await db.collection(getPasskeysPath(userId)).doc(credentialIdBase64).set({
      userId,
      credentialId: credentialIdBase64,
      publicKey: Buffer.from(registrationInfo.credential.publicKey).toString(
        "base64url"
      ),
      counter: registrationInfo.credential.counter,
      deviceName: deviceName || "Security Key",
      transports: registrationInfo.credential.transports || [],
      aaguid: registrationInfo.aaguid,
      rpId, // Store the RP ID used during registration
      createdAt: now,
    });

    // Update MFA settings
    await db.doc(getMfaSettingsPath(userId)).set(
      {
        passkeysEnabled: true,
        updatedAt: now,
      },
      { merge: true }
    );

    // Delete challenge
    await db.doc(getPasskeyChallengePath(userId)).delete();

    // Log audit event
    await db.collection("mfaAuditLogs").add({
      userId,
      action: "passkey_registered",
      method: "passkey",
      metadata: { deviceName },
      timestamp: now,
    });

    console.log(`Passkey registered for user ${userId}: ${deviceName}`);

    return { success: true, credentialId: credentialIdBase64 };
  }
);

/**
 * Generate WebAuthn authentication options for passkey verification
 */
export const generatePasskeyAuthOptions = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { origin: clientOrigin } = request.data || {};
    const config = getWebAuthnConfig(clientOrigin);

    const userId = request.auth.uid;
    const db = getFirestore();

    // Get user's passkeys - only include those that match the current RP ID
    const passkeysSnapshot = await db.collection(getPasskeysPath(userId)).get();

    if (passkeysSnapshot.empty) {
      throw new HttpsError("failed-precondition", "No passkeys registered");
    }

    // Filter passkeys by RP ID (for backwards compatibility, include passkeys without rpId)
    const matchingPasskeys = passkeysSnapshot.docs.filter((doc) => {
      const data = doc.data();
      // Include if no rpId stored (legacy) or if rpId matches
      return !data.rpId || data.rpId === config.rpId;
    });

    if (matchingPasskeys.length === 0) {
      throw new HttpsError(
        "failed-precondition",
        `No passkeys registered for this domain (${config.rpId}). Your passkeys may be registered for a different domain.`
      );
    }

    // Use discoverable credential flow (no allowCredentials).
    // This lets the browser/OS query ALL authenticators (1Password, iCloud Keychain,
    // security keys, etc.) for matching passkeys, instead of searching for specific
    // credential IDs — which fails for third-party providers like 1Password that
    // Chrome can't query directly by ID.
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: "preferred",
      timeout: 60000,
    });

    // Store challenge and config for verification
    await db.doc(getPasskeyChallengePath(userId)).set({
      challenge: options.challenge,
      type: "authentication",
      rpId: config.rpId,
      origin: config.origin,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000), // 5 min
    });

    return options;
  }
);

/**
 * Verify passkey authentication response
 */
export const verifyPasskeyAuth = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { credential } = request.data;
    if (!credential) {
      throw new HttpsError("invalid-argument", "Credential is required");
    }

    const userId = request.auth.uid;
    const db = getFirestore();

    // Get stored challenge
    const challengeDoc = await db.doc(getPasskeyChallengePath(userId)).get();
    if (!challengeDoc.exists) {
      throw new HttpsError("failed-precondition", "No authentication in progress");
    }

    const challengeData = challengeDoc.data()!;
    if (challengeData.type !== "authentication") {
      throw new HttpsError("failed-precondition", "Invalid challenge type");
    }

    if (challengeData.expiresAt.toMillis() < Date.now()) {
      await db.collection("mfaAuditLogs").add({
        userId,
        action: "challenge_failed",
        method: "passkey",
        metadata: { reason: "expired" },
        timestamp: Timestamp.now(),
      });
      throw new HttpsError("deadline-exceeded", "Authentication challenge expired");
    }

    // Get the passkey credential
    const credentialId =
      (credential as AuthenticationResponseJSON).id ||
      (credential as AuthenticationResponseJSON).rawId;

    // Try direct doc lookup first (fastest — works for correctly-stored passkeys)
    let passkeyDoc = await db
      .collection(getPasskeysPath(userId))
      .doc(credentialId)
      .get();

    // Fallback: lookup by double-encoded ID (handles passkeys stored before
    // the base64url double-encoding bug was fixed — Buffer.from(base64urlString)
    // was treating the string as UTF-8 bytes and re-encoding)
    if (!passkeyDoc.exists) {
      const doubleEncoded = Buffer.from(credentialId).toString("base64url");
      console.log(`Direct lookup miss, trying double-encoded: ${doubleEncoded.slice(0, 20)}...`);
      passkeyDoc = await db
        .collection(getPasskeysPath(userId))
        .doc(doubleEncoded)
        .get();
    }

    if (!passkeyDoc.exists) {
      console.error(`Passkey not found for credentialId: ${credentialId.slice(0, 30)}...`);
      await db.collection("mfaAuditLogs").add({
        userId,
        action: "challenge_failed",
        method: "passkey",
        metadata: { reason: "credential_not_found", credentialIdPrefix: credentialId.slice(0, 30) },
        timestamp: Timestamp.now(),
      });
      throw new HttpsError("not-found", "Passkey not found");
    }

    const passkeyData = passkeyDoc.data()!;

    // Use stored config from challenge
    const rpId = challengeData.rpId || getWebAuthnConfig().rpId;
    const expectedOrigin = challengeData.origin || getWebAuthnConfig().origin;

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential as AuthenticationResponseJSON,
        expectedChallenge: challengeData.challenge,
        expectedOrigin,
        expectedRPID: rpId,
        credential: {
          // Use the auth response credentialId (correctly encoded), not the
          // potentially double-encoded stored value
          id: credentialId,
          publicKey: Buffer.from(passkeyData.publicKey, "base64url"),
          counter: passkeyData.counter,
          transports: passkeyData.transports,
        },
      });
    } catch (error) {
      console.error("Passkey authentication verification failed:", error);
      await db.collection("mfaAuditLogs").add({
        userId,
        action: "challenge_failed",
        method: "passkey",
        metadata: { reason: "verification_failed" },
        timestamp: Timestamp.now(),
      });
      throw new HttpsError("invalid-argument", "Invalid authentication response");
    }

    if (!verification.verified) {
      await db.collection("mfaAuditLogs").add({
        userId,
        action: "challenge_failed",
        method: "passkey",
        timestamp: Timestamp.now(),
      });
      throw new HttpsError("invalid-argument", "Authentication verification failed");
    }

    const now = Timestamp.now();

    // Update counter and last used
    await passkeyDoc.ref.update({
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: now,
    });

    // Update lastMfaMethod in settings
    await db.doc(getMfaSettingsPath(userId)).set(
      {
        lastMfaMethod: "passkey",
        lastMfaMethodAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    // Delete challenge
    await db.doc(getPasskeyChallengePath(userId)).delete();

    // Log success
    await db.collection("mfaAuditLogs").add({
      userId,
      action: "challenge_success",
      method: "passkey",
      metadata: { deviceName: passkeyData.deviceName },
      timestamp: now,
    });

    console.log(`Passkey auth success for user ${userId}`);

    return { success: true };
  }
);

/**
 * Delete a passkey
 */
export const deletePasskey = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { credentialId } = request.data;
    if (!credentialId) {
      throw new HttpsError("invalid-argument", "credentialId is required");
    }

    const userId = request.auth.uid;
    const db = getFirestore();

    // Verify ownership
    const passkeyDoc = await db
      .collection(getPasskeysPath(userId))
      .doc(credentialId)
      .get();

    if (!passkeyDoc.exists) {
      throw new HttpsError("not-found", "Passkey not found");
    }

    if (passkeyDoc.data()?.userId !== userId) {
      throw new HttpsError("permission-denied", "Not your passkey");
    }

    const deviceName = passkeyDoc.data()?.deviceName;
    await passkeyDoc.ref.delete();

    // Check if any passkeys remain
    const remainingPasskeys = await db
      .collection(getPasskeysPath(userId))
      .count()
      .get();

    if (remainingPasskeys.data().count === 0) {
      await db.doc(getMfaSettingsPath(userId)).update({
        passkeysEnabled: false,
        updatedAt: Timestamp.now(),
      });
    }

    // Log audit event
    await db.collection("mfaAuditLogs").add({
      userId,
      action: "passkey_removed",
      method: "passkey",
      metadata: { deviceName, credentialId },
      timestamp: Timestamp.now(),
    });

    console.log(`Passkey deleted for user ${userId}: ${deviceName}`);

    return { success: true };
  }
);

/**
 * Record successful MFA verification
 * Called by client after any successful MFA method verification to track the preferred method
 */
export const recordMfaSuccess = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { method } = request.data;
    if (!method || !["totp", "passkey", "backup_code"].includes(method)) {
      throw new HttpsError("invalid-argument", "Valid method is required (totp, passkey, backup_code)");
    }

    const userId = request.auth.uid;
    const db = getFirestore();
    const now = Timestamp.now();

    await db.doc(getMfaSettingsPath(userId)).set(
      {
        lastMfaMethod: method,
        lastMfaMethodAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    console.log(`Recorded MFA success (${method}) for user ${userId}`);

    return { success: true };
  }
);

/**
 * Update TOTP enrollment status after Firebase MFA enrollment
 * Called by client after successful TOTP enrollment via Firebase Auth
 */
export const updateTotpStatus = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { enabled, factorId } = request.data;
    const userId = request.auth.uid;
    const db = getFirestore();
    const now = Timestamp.now();

    await db.doc(getMfaSettingsPath(userId)).set(
      {
        userId,
        totpEnabled: enabled,
        totpFactorId: enabled ? factorId : null,
        totpEnrolledAt: enabled ? now : null,
        updatedAt: now,
      },
      { merge: true }
    );

    // Log audit event
    await db.collection("mfaAuditLogs").add({
      userId,
      action: enabled ? "totp_enabled" : "totp_disabled",
      method: "totp",
      timestamp: now,
    });

    console.log(`TOTP ${enabled ? "enabled" : "disabled"} for user ${userId}`);

    return { success: true };
  }
);

/**
 * Set password for an OAuth-only user
 * Uses Admin SDK to add password authentication to existing account
 */
export const setUserPassword = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { password } = request.data;
    if (!password || typeof password !== "string") {
      throw new HttpsError("invalid-argument", "Password is required");
    }

    if (password.length < 8) {
      throw new HttpsError("invalid-argument", "Password must be at least 8 characters");
    }

    const userId = request.auth.uid;
    const auth = getAuth();

    try {
      // Get current user to check providers
      const userRecord = await auth.getUser(userId);

      // Check if user already has password provider
      const hasPassword = userRecord.providerData.some(
        (provider) => provider.providerId === "password"
      );

      if (hasPassword) {
        throw new HttpsError("already-exists", "Password is already set. Use password reset to change it.");
      }

      // Update user with new password - this adds the password provider
      await auth.updateUser(userId, {
        password: password,
      });

      console.log(`Password set for user ${userId}`);

      return { success: true };
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      console.error("Error setting password:", error);
      throw new HttpsError("internal", "Failed to set password");
    }
  }
);
