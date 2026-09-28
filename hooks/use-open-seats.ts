"use client";

import { useEffect, useState } from "react";
import { callFunction } from "@/lib/firebase/callable";

export interface OpenSeats {
  total: number;
  remaining: number;
  claimed: number;
}

interface OpenSeatsCounts {
  totalSeats: number;
  remainingSeats: number;
  claimedSeats: number;
}

/**
 * Open seats for the register page, fetched ONCE on mount through the public
 * getOpenSeats callable (#415). Not a listener: on self-host an onSnapshot
 * polls the authenticated-only data plane, which a signed-out tab can only
 * answer with a 401 every cycle. Any error, or no remaining seats, is null:
 * the page then shows its invite-only copy.
 */
export function useOpenSeats(): OpenSeats | null {
  const [openSeats, setOpenSeats] = useState<OpenSeats | null>(null);

  useEffect(() => {
    let cancelled = false;
    callFunction<null, OpenSeatsCounts | null>("getOpenSeats", null)
      .then((counts) => {
        if (cancelled) return;
        if (counts && counts.remainingSeats > 0) {
          setOpenSeats({
            total: counts.totalSeats,
            remaining: counts.remainingSeats,
            claimed: counts.claimedSeats || 0,
          });
        } else {
          setOpenSeats(null);
        }
      })
      .catch(() => {
        if (!cancelled) setOpenSeats(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return openSeats;
}
