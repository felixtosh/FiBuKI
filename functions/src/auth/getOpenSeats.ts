/**
 * Public read of the open-seats counters for the register page (#415).
 *
 * allowUnauthenticated: true, called before sign-in. Returns ONLY the three
 * seat counts from config/openSeats (never updatedBy/updatedAt), or null when
 * no seats have been configured. Replaces the page's onSnapshot listener,
 * which on self-host polled the authenticated-only data plane and got a 401
 * every cycle. firestore.rules still makes config/* public for the legacy
 * build; this callable is the one read path both builds share.
 */

import { createCallable } from "../utils/createCallable";

export interface OpenSeatsCounts {
  totalSeats: number;
  remainingSeats: number;
  claimedSeats: number;
}

export type GetOpenSeatsResponse = OpenSeatsCounts | null;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const getOpenSeatsCallable = createCallable<unknown, GetOpenSeatsResponse>(
  { name: "getOpenSeats", allowUnauthenticated: true, skipUsageLogging: true },
  async (ctx) => {
    const snap = await ctx.db.collection("config").doc("openSeats").get();
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    return {
      totalSeats: count(data.totalSeats),
      remainingSeats: count(data.remainingSeats),
      claimedSeats: count(data.claimedSeats),
    };
  }
);
