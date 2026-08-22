"use client";

import { useEffect } from "react";
import {
  getArrowNavigationStep,
  isOverlayOpen,
} from "@/lib/navigation/arrow-key-navigation";

interface UseRowNavigationKeysOptions {
  /**
   * Whether the keys are live. Pass `true` only while a detail panel is open
   * and none of the page's own inline overlays (the file viewer, the connect
   * overlays) are covering the list — those render without a dialog role, so
   * the guard inside cannot see them.
   */
  enabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

/**
 * Left/right arrow keys step the open detail panel through the displayed rows.
 *
 * The handlers are the same ones the panel's prev/next buttons call, so the
 * keys follow the order the table paints and stop at its ends — no wrap-around.
 * The listener only exists while `enabled` is true and is removed when that
 * flips or the page unmounts.
 */
export function useRowNavigationKeys({
  enabled,
  onPrevious,
  onNext,
}: UseRowNavigationKeysOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const step = getArrowNavigationStep(event);
      if (step === null) return;
      // A dialog, menu or select popup on top owns its own arrow keys.
      if (isOverlayOpen(document)) return;

      // The key is ours from here: don't let it scroll the list sideways.
      event.preventDefault();
      if (step < 0) {
        onPrevious();
      } else {
        onNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onPrevious, onNext]);
}
