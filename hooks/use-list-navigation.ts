"use client";

import { useCallback } from "react";
import { getNeighbourRowId } from "@/lib/navigation/row-neighbour";
import { advanceAfterDisposition } from "@/lib/navigation/advance-after-disposition";
import { isRowNavigationEnabled } from "@/lib/navigation/arrow-key-navigation";
import { useRowNavigationKeys } from "@/hooks/use-row-navigation-keys";

interface UseListNavigationOptions {
  /** Row ids in the order the table displays them (sort, filters, search applied). */
  orderedIds: string[];
  /** The row the detail panel shows. */
  currentId: string | null | undefined;
  /** Opens a row in the panel. */
  onNavigate: (id: string) => void;
  /** Whether the panel this navigation drives is open; the arrow keys live only then. */
  panelOpen: boolean;
  /**
   * Whether a connect overlay covers the list. It renders inline with no
   * dialog role, so it has to be named; portalled dialogs and menus switch the
   * keys off on their own.
   */
  connectOverlayOpen?: boolean;
}

/**
 * Prev/next for a list page's detail panel: the neighbours in display order,
 * whether there is one on each side, the left/right arrow keys, and the
 * advance to the next row after a disposition (#251). The ends stop; nothing
 * wraps around.
 */
export function useListNavigation({
  orderedIds,
  currentId,
  onNavigate,
  panelOpen,
  connectOverlayOpen = false,
}: UseListNavigationOptions) {
  const previousId = getNeighbourRowId(orderedIds, currentId, -1);
  const nextId = getNeighbourRowId(orderedIds, currentId, 1);

  const goPrevious = useCallback(() => {
    if (previousId) onNavigate(previousId);
  }, [previousId, onNavigate]);

  const goNext = useCallback(() => {
    if (nextId) onNavigate(nextId);
  }, [nextId, onNavigate]);

  // The next row is captured before the write: the write can drop the current
  // row from the list, and "the row after it" would then find nothing. The
  // navigation uses this render's `onNavigate`, so it resolves the row against
  // the list as it stood before the write too. A failed write does not move.
  const advanceAfter = useCallback(
    (mutate: () => Promise<unknown>) =>
      advanceAfterDisposition({ orderedIds, currentId, mutate, navigateTo: onNavigate }),
    [orderedIds, currentId, onNavigate]
  );

  useRowNavigationKeys({
    enabled: isRowNavigationEnabled({ panelOpen, connectOverlayOpen }),
    onPrevious: goPrevious,
    onNext: goNext,
  });

  return {
    hasPrevious: previousId !== null,
    hasNext: nextId !== null,
    goPrevious,
    goNext,
    advanceAfter,
  };
}
