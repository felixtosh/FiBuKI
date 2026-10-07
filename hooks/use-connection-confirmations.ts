"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import { connectFileToTransaction, type OperationsContext } from "@/lib/operations";

/** How a File Connection was made: by the User (confirmed) or by the matcher or the AI. */
export type ConnectionConfirmation = "confirmed" | "automated";

/** The connection types the matcher and the AI write; every other one is the User's. */
const AUTOMATED_TYPES: ReadonlySet<string> = new Set(["auto_matched", "ai_matched"]);

type ConfirmationMap = Map<string, ConnectionConfirmation>;
const EMPTY: ConfirmationMap = new Map();

/**
 * For one File (or one Transaction), whether each of its Connections is the
 * User's own or automated, keyed by the id on the other side. Realtime, so a
 * confirm shows the moment the record changes. A pair with no record is
 * absent from the map.
 */
export function useConnectionConfirmations(
  side: "fileId" | "transactionId",
  id: string | null | undefined
): ConfirmationMap {
  const { userId } = useAuth();
  const key = userId && id ? `${userId}:${side}:${id}` : null;
  // The map with the query it answers, so a stale answer never shows for a new id.
  const [state, setState] = useState<{ key: string; map: ConfirmationMap } | null>(null);

  useEffect(() => {
    if (!userId || !id || !key) return;
    const other = side === "fileId" ? "transactionId" : "fileId";
    const q = query(collection(db, "fileConnections"), where("userId", "==", userId), where(side, "==", id));
    return onSnapshot(
      q,
      (snap) => {
        const next: ConfirmationMap = new Map();
        for (const d of snap.docs) {
          const data = d.data();
          const otherId = data[other];
          if (typeof otherId !== "string") continue;
          const confirmation: ConnectionConfirmation = AUTOMATED_TYPES.has(data.connectionType) ? "automated" : "confirmed";
          // A pair written twice before #612: confirmed only if every record is.
          if (next.get(otherId) === "automated") continue;
          next.set(otherId, confirmation);
        }
        setState({ key, map: next });
      },
      (error) => {
        console.error("[useConnectionConfirmations] listener failed:", error);
        setState({ key, map: EMPTY });
      }
    );
  }, [userId, side, id, key]);

  return state && state.key === key ? state.map : EMPTY;
}

/**
 * Make an automatic File Connection the User's own: a manual connect of the
 * pair, which the writer turns into a manual record the matcher learns from.
 * Also which pair is in flight (`${fileId}:${transactionId}`), for a spinner.
 */
export function useConfirmConnection(): {
  confirm: (fileId: string, transactionId: string) => Promise<void>;
  pendingPair: string | null;
} {
  const { userId } = useAuth();
  const ctx: OperationsContext = useMemo(() => ({ db, userId: userId ?? "" }), [userId]);
  const [pendingPair, setPendingPair] = useState<string | null>(null);
  const confirm = useCallback(
    async (fileId: string, transactionId: string) => {
      setPendingPair(`${fileId}:${transactionId}`);
      try {
        await connectFileToTransaction(ctx, fileId, transactionId, "manual");
      } catch (error) {
        console.error("[useConfirmConnection] confirm failed:", error);
      } finally {
        setPendingPair(null);
      }
    },
    [ctx]
  );
  return { confirm, pendingPair };
}
