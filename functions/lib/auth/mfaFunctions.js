"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setUserPassword = exports.updateTotpStatus = exports.recordMfaSuccess = exports.deletePasskey = exports.verifyPasskeyAuth = exports.generatePasskeyAuthOptions = exports.verifyPasskeyRegistration = exports.generatePasskeyRegistrationOptions = exports.adminResetMfa = exports.getMfaStatus = exports.verifyBackupCode = exports.generateBackupCodes = void 0;
const https_1 = require("firebase-functions/v2/https");
const auth_1 = require("firebase-admin/auth");
const firestore_1 = require("firebase-admin/firestore");
const crypto_1 = require("crypto");
const server_1 = require("@simplewebauthn/server");
const SUPER_ADMIN_EMAIL = "felix@i7v6.com";
const RP_NAME = "FiBuKI";
const CORS_ORIGINS = [
    "https://fibuki.com",
    "https://taxstudio-f12fb.firebaseapp.com",
    "https://taxstudio-f12fb.web.app",
    "http://localhost:3000",
];
// WebAuthn configuration for different environments
// Passkeys are domain-bound, so we need to track which RP ID was used during registration
const WEBAUTHN_CONFIG = {
    "http://localhost:3000": { rpId: "localhost", origin: "http://localhost:3000" },
    "https://fibuki.com": { rpId: "fibuki.com", origin: "https://fibuki.com" },
    "https://www.fibuki.com": { rpId: "fibuki.com", origin: "https://www.fibuki.com" },
};
// Helper to get WebAuthn config from client-provided origin
function getWebAuthnConfig(clientOrigin) {
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
const getMfaSettingsPath = (userId) => `users/${userId}/mfaSettings/config`;
const getPasskeysPath = (userId) => `users/${userId}/passkeys`;
const getBackupCodesPath = (userId) => `users/${userId}/backupCodes`;
const getPasskeyChallengePath = (userId) => `users/${userId}/passkeyChallenge/current`;
// ============ Backup Codes ============
/**
 * Generate 10 backup codes for a user
 * Returns the plain codes (shown only once) and stores hashes
 */
exports.generateBackupCodes = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
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
            createdAt: firestore_1.Timestamp.now(),
            updatedAt: firestore_1.Timestamp.now(),
        });
    }
    // Delete any existing backup codes
    const existingCodes = await db
        .collection(getBackupCodesPath(userId))
        .get();
    const batch = db.batch();
    existingCodes.docs.forEach((doc) => batch.delete(doc.ref));
    // Generate 10 new backup codes (format: XXXX-XXXX)
    const codes = [];
    const now = firestore_1.Timestamp.now();
    for (let i = 0; i < 10; i++) {
        const code = (0, crypto_1.randomBytes)(4).toString("hex").toUpperCase().slice(0, 4) +
            "-" +
            (0, crypto_1.randomBytes)(4).toString("hex").toUpperCase().slice(0, 4);
        codes.push(code);
        // Hash the code for storage
        const codeHash = (0, crypto_1.createHash)("sha256").update(code).digest("hex");
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
});
/**
 * Verify a backup code during MFA challenge
 * Consumes the code if valid
 */
exports.verifyBackupCode = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { code } = request.data;
    if (!code || typeof code !== "string") {
        throw new https_1.HttpsError("invalid-argument", "Code is required");
    }
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
    // Hash the provided code
    const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const formattedCode = normalizedCode.slice(0, 4) + "-" + normalizedCode.slice(4, 8);
    const codeHash = (0, crypto_1.createHash)("sha256").update(formattedCode).digest("hex");
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
            timestamp: firestore_1.Timestamp.now(),
        });
        throw new https_1.HttpsError("invalid-argument", "Invalid or already used backup code");
    }
    const codeDoc = codesSnapshot.docs[0];
    const now = firestore_1.Timestamp.now();
    // Mark code as used
    const batch = db.batch();
    batch.update(codeDoc.ref, {
        used: true,
        usedAt: now,
    });
    // Decrement remaining codes count and update lastMfaMethod
    const settingsRef = db.doc(getMfaSettingsPath(userId));
    batch.update(settingsRef, {
        backupCodesRemaining: firestore_1.FieldValue.increment(-1),
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
});
// ============ MFA Status ============
/**
 * Get comprehensive MFA status for a user
 */
exports.getMfaStatus = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
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
    const auth = (0, auth_1.getAuth)();
    const userRecord = await auth.getUser(userId);
    const totpEnrolled = userRecord.multiFactor?.enrolledFactors?.some((factor) => factor.factorId === "totp") ?? false;
    return {
        totpEnabled: settings.totpEnabled || totpEnrolled,
        passkeysEnabled: passkeys.length > 0,
        passkeyCount: passkeys.length,
        passkeys,
        backupCodesRemaining,
        hasAnyMfa: settings.totpEnabled || totpEnrolled || passkeys.length > 0,
        lastMfaMethod: settings.lastMfaMethod || null,
    };
});
// ============ Admin Functions ============
/**
 * Admin function to reset MFA for a locked-out user
 */
exports.adminResetMfa = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    // Verify caller is admin
    const callerEmail = request.auth.token.email;
    const callerIsAdmin = request.auth.token.admin === true;
    if (!callerIsAdmin && callerEmail !== SUPER_ADMIN_EMAIL) {
        throw new https_1.HttpsError("permission-denied", "Only admins can reset MFA");
    }
    const { targetUserId, reason } = request.data;
    if (!targetUserId) {
        throw new https_1.HttpsError("invalid-argument", "targetUserId is required");
    }
    const db = (0, firestore_1.getFirestore)();
    const auth = (0, auth_1.getAuth)();
    const now = firestore_1.Timestamp.now();
    try {
        // Get target user info for logging
        const targetUser = await auth.getUser(targetUserId);
        // Unenroll all MFA factors from Firebase Auth
        if (targetUser.multiFactor?.enrolledFactors?.length) {
            // Firebase Admin SDK doesn't have direct MFA unenroll
            // We need to use a workaround by setting custom claims
            // The user will need to re-enroll
            console.log(`User ${targetUser.email} has ${targetUser.multiFactor.enrolledFactors.length} MFA factors`);
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
        batch.set(settingsRef, {
            userId: targetUserId,
            totpEnabled: false,
            totpFactorId: null,
            totpEnrolledAt: null,
            passkeysEnabled: false,
            backupCodesGenerated: false,
            backupCodesGeneratedAt: null,
            backupCodesRemaining: 0,
            updatedAt: now,
        }, { merge: true });
        await batch.commit();
        // Log audit event
        await db.collection("mfaAuditLogs").add({
            userId: targetUserId,
            action: "admin_reset",
            performedBy: request.auth.uid,
            metadata: { reason, adminEmail: callerEmail },
            timestamp: now,
        });
        console.log(`MFA reset for user ${targetUser.email} by admin ${callerEmail}`);
        return {
            success: true,
            targetEmail: targetUser.email,
        };
    }
    catch (error) {
        console.error("Error resetting MFA:", error);
        throw new https_1.HttpsError("internal", "Failed to reset MFA");
    }
});
// ============ Passkey Functions ============
/**
 * Generate WebAuthn registration options for passkey enrollment
 */
exports.generatePasskeyRegistrationOptions = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { origin: clientOrigin } = request.data || {};
    const config = getWebAuthnConfig(clientOrigin);
    const userId = request.auth.uid;
    const userEmail = request.auth.token.email || "user@example.com";
    const db = (0, firestore_1.getFirestore)();
    // Get existing passkeys to exclude
    const existingPasskeys = await db
        .collection(getPasskeysPath(userId))
        .get();
    const excludeCredentials = existingPasskeys.docs.map((doc) => ({
        id: doc.data().credentialId,
        transports: doc.data().transports,
    }));
    const options = await (0, server_1.generateRegistrationOptions)({
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
        createdAt: firestore_1.Timestamp.now(),
        expiresAt: firestore_1.Timestamp.fromMillis(Date.now() + 5 * 60 * 1000), // 5 min
    });
    return options;
});
/**
 * Verify passkey registration and store credential
 */
exports.verifyPasskeyRegistration = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { credential, deviceName } = request.data;
    if (!credential) {
        throw new https_1.HttpsError("invalid-argument", "Credential is required");
    }
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
    // Get stored challenge
    const challengeDoc = await db.doc(getPasskeyChallengePath(userId)).get();
    if (!challengeDoc.exists) {
        throw new https_1.HttpsError("failed-precondition", "No registration in progress");
    }
    const challengeData = challengeDoc.data();
    if (challengeData.type !== "registration") {
        throw new https_1.HttpsError("failed-precondition", "Invalid challenge type");
    }
    if (challengeData.expiresAt.toMillis() < Date.now()) {
        throw new https_1.HttpsError("deadline-exceeded", "Registration challenge expired");
    }
    // Use the stored RP ID and origin from challenge
    const rpId = challengeData.rpId || getWebAuthnConfig().rpId;
    const expectedOrigin = challengeData.origin || getWebAuthnConfig().origin;
    let verification;
    try {
        verification = await (0, server_1.verifyRegistrationResponse)({
            response: credential,
            expectedChallenge: challengeData.challenge,
            expectedOrigin,
            expectedRPID: rpId,
        });
    }
    catch (error) {
        console.error("Passkey registration verification failed:", error);
        throw new https_1.HttpsError("invalid-argument", "Invalid registration response");
    }
    if (!verification.verified || !verification.registrationInfo) {
        throw new https_1.HttpsError("invalid-argument", "Registration verification failed");
    }
    const { registrationInfo } = verification;
    const now = firestore_1.Timestamp.now();
    // Store the credential with RP ID for future authentication
    const credentialIdBase64 = Buffer.from(registrationInfo.credential.id).toString("base64url");
    await db.collection(getPasskeysPath(userId)).doc(credentialIdBase64).set({
        userId,
        credentialId: credentialIdBase64,
        publicKey: Buffer.from(registrationInfo.credential.publicKey).toString("base64url"),
        counter: registrationInfo.credential.counter,
        deviceName: deviceName || "Security Key",
        transports: registrationInfo.credential.transports || [],
        aaguid: registrationInfo.aaguid,
        rpId, // Store the RP ID used during registration
        createdAt: now,
    });
    // Update MFA settings
    await db.doc(getMfaSettingsPath(userId)).set({
        passkeysEnabled: true,
        updatedAt: now,
    }, { merge: true });
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
});
/**
 * Generate WebAuthn authentication options for passkey verification
 */
exports.generatePasskeyAuthOptions = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { origin: clientOrigin } = request.data || {};
    const config = getWebAuthnConfig(clientOrigin);
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
    // Get user's passkeys - only include those that match the current RP ID
    const passkeysSnapshot = await db.collection(getPasskeysPath(userId)).get();
    if (passkeysSnapshot.empty) {
        throw new https_1.HttpsError("failed-precondition", "No passkeys registered");
    }
    // Filter passkeys by RP ID (for backwards compatibility, include passkeys without rpId)
    const matchingPasskeys = passkeysSnapshot.docs.filter((doc) => {
        const data = doc.data();
        // Include if no rpId stored (legacy) or if rpId matches
        return !data.rpId || data.rpId === config.rpId;
    });
    if (matchingPasskeys.length === 0) {
        throw new https_1.HttpsError("failed-precondition", `No passkeys registered for this domain (${config.rpId}). Your passkeys may be registered for a different domain.`);
    }
    const allowCredentials = matchingPasskeys.map((doc) => ({
        id: doc.data().credentialId,
        transports: doc.data().transports,
    }));
    const options = await (0, server_1.generateAuthenticationOptions)({
        rpID: config.rpId,
        allowCredentials,
        userVerification: "preferred",
        timeout: 60000,
    });
    // Store challenge and config for verification
    await db.doc(getPasskeyChallengePath(userId)).set({
        challenge: options.challenge,
        type: "authentication",
        rpId: config.rpId,
        origin: config.origin,
        createdAt: firestore_1.Timestamp.now(),
        expiresAt: firestore_1.Timestamp.fromMillis(Date.now() + 5 * 60 * 1000), // 5 min
    });
    return options;
});
/**
 * Verify passkey authentication response
 */
exports.verifyPasskeyAuth = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { credential } = request.data;
    if (!credential) {
        throw new https_1.HttpsError("invalid-argument", "Credential is required");
    }
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
    // Get stored challenge
    const challengeDoc = await db.doc(getPasskeyChallengePath(userId)).get();
    if (!challengeDoc.exists) {
        throw new https_1.HttpsError("failed-precondition", "No authentication in progress");
    }
    const challengeData = challengeDoc.data();
    if (challengeData.type !== "authentication") {
        throw new https_1.HttpsError("failed-precondition", "Invalid challenge type");
    }
    if (challengeData.expiresAt.toMillis() < Date.now()) {
        await db.collection("mfaAuditLogs").add({
            userId,
            action: "challenge_failed",
            method: "passkey",
            metadata: { reason: "expired" },
            timestamp: firestore_1.Timestamp.now(),
        });
        throw new https_1.HttpsError("deadline-exceeded", "Authentication challenge expired");
    }
    // Get the passkey credential
    const credentialId = credential.id ||
        credential.rawId;
    const passkeyDoc = await db
        .collection(getPasskeysPath(userId))
        .doc(credentialId)
        .get();
    if (!passkeyDoc.exists) {
        await db.collection("mfaAuditLogs").add({
            userId,
            action: "challenge_failed",
            method: "passkey",
            metadata: { reason: "credential_not_found" },
            timestamp: firestore_1.Timestamp.now(),
        });
        throw new https_1.HttpsError("not-found", "Passkey not found");
    }
    const passkeyData = passkeyDoc.data();
    // Use stored config from challenge
    const rpId = challengeData.rpId || getWebAuthnConfig().rpId;
    const expectedOrigin = challengeData.origin || getWebAuthnConfig().origin;
    let verification;
    try {
        verification = await (0, server_1.verifyAuthenticationResponse)({
            response: credential,
            expectedChallenge: challengeData.challenge,
            expectedOrigin,
            expectedRPID: rpId,
            credential: {
                id: passkeyData.credentialId,
                publicKey: Buffer.from(passkeyData.publicKey, "base64url"),
                counter: passkeyData.counter,
                transports: passkeyData.transports,
            },
        });
    }
    catch (error) {
        console.error("Passkey authentication verification failed:", error);
        await db.collection("mfaAuditLogs").add({
            userId,
            action: "challenge_failed",
            method: "passkey",
            metadata: { reason: "verification_failed" },
            timestamp: firestore_1.Timestamp.now(),
        });
        throw new https_1.HttpsError("invalid-argument", "Invalid authentication response");
    }
    if (!verification.verified) {
        await db.collection("mfaAuditLogs").add({
            userId,
            action: "challenge_failed",
            method: "passkey",
            timestamp: firestore_1.Timestamp.now(),
        });
        throw new https_1.HttpsError("invalid-argument", "Authentication verification failed");
    }
    const now = firestore_1.Timestamp.now();
    // Update counter and last used
    await passkeyDoc.ref.update({
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: now,
    });
    // Update lastMfaMethod in settings
    await db.doc(getMfaSettingsPath(userId)).set({
        lastMfaMethod: "passkey",
        lastMfaMethodAt: now,
        updatedAt: now,
    }, { merge: true });
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
});
/**
 * Delete a passkey
 */
exports.deletePasskey = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { credentialId } = request.data;
    if (!credentialId) {
        throw new https_1.HttpsError("invalid-argument", "credentialId is required");
    }
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
    // Verify ownership
    const passkeyDoc = await db
        .collection(getPasskeysPath(userId))
        .doc(credentialId)
        .get();
    if (!passkeyDoc.exists) {
        throw new https_1.HttpsError("not-found", "Passkey not found");
    }
    if (passkeyDoc.data()?.userId !== userId) {
        throw new https_1.HttpsError("permission-denied", "Not your passkey");
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
            updatedAt: firestore_1.Timestamp.now(),
        });
    }
    // Log audit event
    await db.collection("mfaAuditLogs").add({
        userId,
        action: "passkey_removed",
        method: "passkey",
        metadata: { deviceName, credentialId },
        timestamp: firestore_1.Timestamp.now(),
    });
    console.log(`Passkey deleted for user ${userId}: ${deviceName}`);
    return { success: true };
});
/**
 * Record successful MFA verification
 * Called by client after any successful MFA method verification to track the preferred method
 */
exports.recordMfaSuccess = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { method } = request.data;
    if (!method || !["totp", "passkey", "backup_code"].includes(method)) {
        throw new https_1.HttpsError("invalid-argument", "Valid method is required (totp, passkey, backup_code)");
    }
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
    const now = firestore_1.Timestamp.now();
    await db.doc(getMfaSettingsPath(userId)).set({
        lastMfaMethod: method,
        lastMfaMethodAt: now,
        updatedAt: now,
    }, { merge: true });
    console.log(`Recorded MFA success (${method}) for user ${userId}`);
    return { success: true };
});
/**
 * Update TOTP enrollment status after Firebase MFA enrollment
 * Called by client after successful TOTP enrollment via Firebase Auth
 */
exports.updateTotpStatus = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { enabled, factorId } = request.data;
    const userId = request.auth.uid;
    const db = (0, firestore_1.getFirestore)();
    const now = firestore_1.Timestamp.now();
    await db.doc(getMfaSettingsPath(userId)).set({
        userId,
        totpEnabled: enabled,
        totpFactorId: enabled ? factorId : null,
        totpEnrolledAt: enabled ? now : null,
        updatedAt: now,
    }, { merge: true });
    // Log audit event
    await db.collection("mfaAuditLogs").add({
        userId,
        action: enabled ? "totp_enabled" : "totp_disabled",
        method: "totp",
        timestamp: now,
    });
    console.log(`TOTP ${enabled ? "enabled" : "disabled"} for user ${userId}`);
    return { success: true };
});
/**
 * Set password for an OAuth-only user
 * Uses Admin SDK to add password authentication to existing account
 */
exports.setUserPassword = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const { password } = request.data;
    if (!password || typeof password !== "string") {
        throw new https_1.HttpsError("invalid-argument", "Password is required");
    }
    if (password.length < 8) {
        throw new https_1.HttpsError("invalid-argument", "Password must be at least 8 characters");
    }
    const userId = request.auth.uid;
    const auth = (0, auth_1.getAuth)();
    try {
        // Get current user to check providers
        const userRecord = await auth.getUser(userId);
        // Check if user already has password provider
        const hasPassword = userRecord.providerData.some((provider) => provider.providerId === "password");
        if (hasPassword) {
            throw new https_1.HttpsError("already-exists", "Password is already set. Use password reset to change it.");
        }
        // Update user with new password - this adds the password provider
        await auth.updateUser(userId, {
            password: password,
        });
        console.log(`Password set for user ${userId}`);
        return { success: true };
    }
    catch (error) {
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        console.error("Error setting password:", error);
        throw new https_1.HttpsError("internal", "Failed to set password");
    }
});
//# sourceMappingURL=mfaFunctions.js.map