/**
 * Call whatever is in a mutable box right now.
 *
 * `box` is a React ref holding the newest version of a callback, rewritten on
 * every commit. A dispatcher built on this — `(...args) => invokeLatest(box,
 * args)` — can be handed to a consumer that holds it for as long as it likes:
 * its identity never has to change, and every call still runs the current
 * render's closure instead of the one that was current when the consumer took
 * its copy.
 *
 * The consumer this exists for is the virtualised table: VirtualRow is
 * memoised and its comparator deliberately ignores `onClick`, so a row that
 * skips a render keeps the handler it last painted with (#232, #298).
 *
 * Kept framework-free so the trap it closes can be exercised without a DOM;
 * the React binding is `useLatestCallback` in hooks/use-latest-callback.ts.
 */
function invokeLatest(box, args) {
  const callback = box.current;
  if (!callback) return undefined;
  return callback(...args);
}

module.exports = { invokeLatest };
