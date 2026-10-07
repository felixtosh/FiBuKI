"use client";

import { Fragment, useState, type ReactNode } from "react";

/**
 * Lets an animation play only when `value` changes while this is on screen,
 * never when it first appears. A row that loads or scrolls into view shows its
 * pills and checks as they are; a Partner assigned while you watch pops in.
 *
 * `changed` is false on the first render and true once the value has changed.
 * Every change remounts the children, so a CSS animation on them plays again.
 *
 * Key `value` on the row's own data (an id, a count), not on something that
 * arrives later from a lookup: a lookup finishing would read as a change.
 */
export function PlayOnChange({
  value,
  children,
}: {
  value: unknown;
  children: (changed: boolean) => ReactNode;
}) {
  // Storing the previous value in state and updating it during render is
  // React's pattern for reacting to a prop change without an effect.
  const [seen, setSeen] = useState({ value, run: 0 });
  if (!Object.is(seen.value, value)) {
    setSeen({ value, run: seen.run + 1 });
  }
  return <Fragment key={seen.run}>{children(seen.run > 0)}</Fragment>;
}
