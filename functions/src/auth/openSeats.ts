import { createCallable, HttpsError } from "../utils/createCallable";
import { defineSecret } from "firebase-functions/params";
import { FieldValue, Firestore } from "firebase-admin/firestore";
import { sendInviteEmail } from "./sendInviteEmail";

const sendgridApiKey = defineSecret("SENDGRID_API_KEY");

interface SetOpenSeatsRequest {
  totalSeats: number;
}

interface SetOpenSeatsResponse {
  success: boolean;
  totalSeats: number;
  remainingSeats: number;
}

export const setOpenSeatsCallable = createCallable<
  SetOpenSeatsRequest,
  SetOpenSeatsResponse
>(
  { name: "setOpenSeats", secrets: [sendgridApiKey] },
  async (ctx, request) => {
    // Admin only
    if (!ctx.request.auth?.token.admin) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    const { totalSeats } = request;

    if (typeof totalSeats !== "number" || totalSeats < 0 || !Number.isInteger(totalSeats)) {
      throw new HttpsError("invalid-argument", "totalSeats must be a non-negative integer");
    }

    const configRef = ctx.db.collection("config").doc("openSeats");

    // Count all used invites for cumulative claimed seats
    const usedInvites = await ctx.db
      .collection("allowedEmails")
      .where("usedAt", "!=", null)
      .count()
      .get();
    const claimedSeats = usedInvites.data().count;

    const remainingSeats = Math.max(0, totalSeats - claimedSeats);

    await configRef.set({
      totalSeats,
      remainingSeats,
      claimedSeats,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: ctx.userId,
    });

    const result = { totalSeats, remainingSeats };

    // Auto-approve pending access requests if seats are available
    if (result.remainingSeats > 0) {
      const autoApproved = await autoApprovePendingRequests(
        ctx.db,
        result.remainingSeats,
        ctx.userId
      );
      if (autoApproved > 0) {
        // Update remaining seats and claimed seats after auto-approvals
        await configRef.update({
          remainingSeats: FieldValue.increment(-autoApproved),
          claimedSeats: FieldValue.increment(autoApproved),
        });
      }
    }

    return { success: true, ...result };
  }
);

/**
 * Auto-approve pending access requests up to the number of available seats.
 */
async function autoApprovePendingRequests(
  db: Firestore,
  maxApprovals: number,
  adminUserId: string
): Promise<number> {
  const pendingRequests = await db
    .collection("accessRequests")
    .where("status", "==", "pending")
    .orderBy("requestedAt", "asc")
    .limit(maxApprovals)
    .get();

  if (pendingRequests.empty) return 0;

  let approved = 0;
  for (const requestDoc of pendingRequests.docs) {
    const data = requestDoc.data();

    // Create allowedEmails doc if not already there
    const existingAllowed = await db
      .collection("allowedEmails")
      .where("email", "==", data.email)
      .limit(1)
      .get();

    if (existingAllowed.empty) {
      await db.collection("allowedEmails").doc().set({
        email: data.email,
        addedBy: adminUserId,
        addedAt: FieldValue.serverTimestamp(),
        source: "open-seat-auto-approve",
      });
    }

    // Mark request as approved
    await requestDoc.ref.update({
      status: "approved",
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy: adminUserId,
    });

    // Fire-and-forget invite email
    sendInviteEmail(data.email).catch((err) =>
      console.error("[autoApprove] Failed to send invite email:", err)
    );

    approved++;
  }

  return approved;
}
