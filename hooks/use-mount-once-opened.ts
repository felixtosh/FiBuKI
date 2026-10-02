"use client";

import { useState } from "react";

/**
 * True from the first time `open` is true, and from then on.
 *
 * For dialogs in the detail panel: rendered while closed, their hooks ran on
 * every row selection although nothing showed. Mounting them on first open
 * removes that cost from the rows they are never opened on, and keeping them
 * mounted afterwards keeps their close animation.
 */
export function useMountOnceOpened(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
