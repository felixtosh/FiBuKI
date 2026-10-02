/**
 * Who may open an account, in one place for both builds.
 *
 * FiBuKI is invite-only with a few open seats: an email passes if it is the super admin, is in
 * `allowedEmails`, or can claim a seat from `config/openSeats`. A claimed seat writes the
 * `allowedEmails` row in the same transaction, so the email stays allowed and the seat is spent
 * once. The Firebase callables (validateRegistration / markInviteUsed) and the self-host Better Auth
 * create hook both go through here; before this, self-host checked the invite list only, so the
 * register page promised "open seats" that nothing ever claimed.
 *
 * One rule for every origin: someone arriving from ChatGPT, Claude, Codex or the web is treated alike.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore";

export type GateDecision =
  | { allowed: true; via: "super-admin" | "invite" | "open-seat" }
  | { allowed: false; reason: "not-invited" | "invite-used" };

export interface AdmitOptions {
  /** Refuse an invite that already registered someone (the Firebase behaviour). */
  rejectUsedInvite?: boolean;
}

export async function admitEmail(
  db: Firestore,
  email: string,
  superAdminEmail: string | undefined,
  options: AdmitOptions = {}
): Promise<GateDecision> {
  const normalized = email.trim().toLowerCase();
  if (superAdminEmail && normalized === superAdminEmail.trim().toLowerCase()) {
    return { allowed: true, via: "super-admin" };
  }

  const invite = await db.collection("allowedEmails").where("email", "==", normalized).limit(1).get();
  if (!invite.empty) {
    if (options.rejectUsedInvite && invite.docs[0].data().usedAt) {
      return { allowed: false, reason: "invite-used" };
    }
    return { allowed: true, via: "invite" };
  }

  const configRef = db.collection("config").doc("openSeats");
  const claimed = await db.runTransaction(async (tx) => {
    const config = await tx.get(configRef);
    if (!config.exists) return false;
    const remaining = config.data()?.remainingSeats;
    if (typeof remaining !== "number" || remaining <= 0) return false;

    tx.update(configRef, { remainingSeats: remaining - 1 });
    tx.set(db.collection("allowedEmails").doc(), {
      email: normalized,
      addedBy: "open-seat",
      addedAt: new Date(),
    });
    return true;
  });

  return claimed ? { allowed: true, via: "open-seat" } : { allowed: false, reason: "not-invited" };
}

/**
 * After the account exists: mark the invite used, count the registration, and close any access
 * request the person filed earlier (for example from a failed attempt before they were invited).
 */
export async function recordRegistration(
  db: Firestore,
  email: string,
  uid: string,
  superAdminEmail: string | undefined
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (superAdminEmail && normalized === superAdminEmail.trim().toLowerCase()) return;

  const invite = await db.collection("allowedEmails").where("email", "==", normalized).limit(1).get();
  if (!invite.empty) {
    await invite.docs[0].ref.update({ usedAt: new Date(), registeredUserId: uid });
  }

  await db.collection("config").doc("openSeats").set({ claimedSeats: FieldValue.increment(1) }, { merge: true });

  const pending = await db
    .collection("accessRequests")
    .where("email", "==", normalized)
    .where("status", "==", "pending")
    .get();
  for (const request of pending.docs) {
    await request.ref.update({
      status: "dismissed",
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy: "system:registration",
    });
  }
}
