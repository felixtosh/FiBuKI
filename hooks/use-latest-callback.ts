"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { invokeLatest } from "@/lib/react/latest-callback";

// useLayoutEffect warns when a client component is rendered on the server.
// Nothing can call a row handler before hydration, so fall back there.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Give a handler a stable identity and a closure that is always this render's.
 *
 * Use it for any callback a memoised child holds on to across renders — above
 * all the ones reaching the virtualised table's rows. VirtualRow's comparator
 * ignores `onClick` on purpose (see components/ui/data-table/virtual-row.tsx),
 * so a row that skips a render keeps the handler it last painted with: a raw
 * closure over component state there reads that state as of the row's last
 * render, not as of the click. That is what made the Files checkboxes act like
 * a radio group and shift-click behave as a plain click (#232, #298).
 *
 * The returned function is stable, so passing it does not bust a memo either —
 * and if React ever dropped the cache below, a row holding the older dispatcher
 * would still read the same box, so correctness does not rest on that.
 *
 * Do not call it during render: the closure it runs is only swapped in on
 * commit, which is exactly what makes it safe for event handlers.
 */
export function useLatestCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  const box = useRef(callback);
  useIsomorphicLayoutEffect(() => {
    box.current = callback;
  });

  // No deps: the whole point is a dispatcher whose identity never changes. It
  // reads the box at call time, so it is never the one that goes stale.
  return useCallback((...args: TArgs) => invokeLatest(box, args) as TResult, []);
}
