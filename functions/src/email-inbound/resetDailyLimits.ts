/**
 * Scheduled Function: Reset Daily Limits
 *
 * Runs daily at midnight (Europe/Berlin) to reset the todayCount
 * for all inbound email addresses.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

const INBOUND_ADDRESSES_COLLECTION = "inboundEmailAddresses";

/**
 * Reset daily email counts for all inbound addresses
 * Runs at 00:05 every day (Europe/Berlin timezone)
 */
export const resetInboundDailyLimits = onSchedule(
  {
    schedule: "5 0 * * *", // 00:05 daily
    timeZone: "Europe/Berlin",
    region: "europe-west1",
  },
  async () => {
    console.log("[resetInboundDailyLimits] Starting daily reset");

    // Get yesterday's date (since we're running after midnight)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    // Find all addresses with yesterday's date (they need to be reset)
    // We could also reset all, but this is more efficient
    const snapshot = await db
      .collection(INBOUND_ADDRESSES_COLLECTION)
      .where("todayDate", "==", yesterdayStr)
      .get();

    if (snapshot.empty) {
      console.log("[resetInboundDailyLimits] No addresses need reset");
      return;
    }

    let resetCount = 0;
    const batch = db.batch();

    for (const doc of snapshot.docs) {
      batch.update(doc.ref, {
        todayCount: 0,
        todayDate: null,
      });
      resetCount++;
    }

    await batch.commit();

    console.log(
      `[resetInboundDailyLimits] Reset ${resetCount} addresses`
    );
  }
);
