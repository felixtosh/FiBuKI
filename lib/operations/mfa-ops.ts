import {
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
  onSnapshot,
  Unsubscribe,
} from "firebase/firestore";
import {
  MfaSettings,
  MfaStatusResponse,
  PasskeyCredential,
} from "@/types/mfa";
import { OperationsContext } from "./types";

// Collection paths (subcollections under users/{userId})
const getMfaSettingsPath = (userId: string) =>
  `users/${userId}/mfaSettings`;
const getPasskeysPath = (userId: string) =>
  `users/${userId}/passkeys`;
const getBackupCodesPath = (userId: string) =>
  `users/${userId}/backupCodes`;

// ============ MFA Settings ============

/**
 * Get MFA settings for the current user
 */
export async function getMfaSettings(
  ctx: OperationsContext
): Promise<MfaSettings | null> {
  const docRef = doc(ctx.db, getMfaSettingsPath(ctx.userId), "config");
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) return null;

  return { ...snapshot.data() } as MfaSettings;
}

/**
 * Subscribe to MFA settings changes (realtime)
 */
export function subscribeMfaSettings(
  ctx: OperationsContext,
  callback: (settings: MfaSettings | null) => void
): Unsubscribe {
  const docRef = doc(ctx.db, getMfaSettingsPath(ctx.userId), "config");

  return onSnapshot(docRef, (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }
    callback({ ...snapshot.data() } as MfaSettings);
  });
}

/**
 * Check if user has any MFA enabled
 */
export async function hasMfaEnabled(ctx: OperationsContext): Promise<boolean> {
  const settings = await getMfaSettings(ctx);
  if (!settings) return false;

  return settings.totpEnabled || settings.passkeysEnabled;
}

// ============ Passkeys ============

/**
 * List all passkeys for the current user
 */
export async function listPasskeys(
  ctx: OperationsContext
): Promise<PasskeyCredential[]> {
  const q = query(
    collection(ctx.db, getPasskeysPath(ctx.userId)),
    where("userId", "==", ctx.userId)
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as PasskeyCredential[];
}

/**
 * Subscribe to passkeys changes (realtime)
 */
export function subscribePasskeys(
  ctx: OperationsContext,
  callback: (passkeys: PasskeyCredential[]) => void
): Unsubscribe {
  const q = query(
    collection(ctx.db, getPasskeysPath(ctx.userId)),
    where("userId", "==", ctx.userId)
  );

  return onSnapshot(q, (snapshot) => {
    const passkeys = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as PasskeyCredential[];
    callback(passkeys);
  });
}

/**
 * Get a passkey by credential ID
 */
export async function getPasskeyByCredentialId(
  ctx: OperationsContext,
  credentialId: string
): Promise<PasskeyCredential | null> {
  const q = query(
    collection(ctx.db, getPasskeysPath(ctx.userId)),
    where("credentialId", "==", credentialId)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  return {
    id: snapshot.docs[0].id,
    ...snapshot.docs[0].data(),
  } as PasskeyCredential;
}

// ============ Backup Codes ============

/**
 * Get count of remaining (unused) backup codes
 */
export async function getBackupCodesRemaining(
  ctx: OperationsContext
): Promise<number> {
  const q = query(
    collection(ctx.db, getBackupCodesPath(ctx.userId)),
    where("userId", "==", ctx.userId),
    where("used", "==", false)
  );

  const snapshot = await getDocs(q);
  return snapshot.size;
}

// ============ MFA Status (Composite) ============

/**
 * Get comprehensive MFA status for current user
 * Combines settings, passkeys, and backup codes info
 */
export async function getMfaStatus(
  ctx: OperationsContext
): Promise<MfaStatusResponse> {
  const [settings, passkeys, backupCodesRemaining] = await Promise.all([
    getMfaSettings(ctx),
    listPasskeys(ctx),
    getBackupCodesRemaining(ctx),
  ]);

  return {
    totpEnabled: settings?.totpEnabled ?? false,
    passkeysEnabled: settings?.passkeysEnabled ?? false,
    passkeyCount: passkeys.length,
    passkeys: passkeys.map((p) => ({
      id: p.id,
      deviceName: p.deviceName,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt,
    })),
    backupCodesRemaining,
    hasAnyMfa:
      (settings?.totpEnabled ?? false) ||
      (settings?.passkeysEnabled ?? false) ||
      passkeys.length > 0,
  };
}
