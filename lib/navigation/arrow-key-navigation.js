/**
 * Keyboard guard for detail-panel prev/next navigation.
 *
 * Left/right step the open detail panel through the rows the table displays,
 * using the same navigate functions as the prev/next buttons. The keys belong
 * to whatever is on top, so they are dropped while the user is typing and
 * while a portalled surface (dialog, menu, select popup, popover) is open.
 * Overlays that render inline with no role of their own — the full-screen file
 * viewer, the connect overlays — are not visible to `isOverlayOpen`; the page
 * folds those into the `enabled` flag it hands the hook.
 */

/** Elements that own every key pressed into them. */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * @param {{ tagName?: string, isContentEditable?: boolean } | null | undefined} target
 *   the keydown event's target
 * @returns {boolean} true while the target is a field the user types into
 */
function isTypingTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable === true) return true;
  const tagName = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  return TYPING_TAGS.has(tagName);
}

/**
 * Radix renders every portalled surface with one of these roles while it is
 * open. Nothing in the app's own markup carries them.
 */
const OVERLAY_ROLE_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

/**
 * @param {{ querySelector?: (selector: string) => unknown } | null | undefined} doc
 * @returns {boolean} true while something is layered over the page
 */
function isOverlayOpen(doc) {
  if (!doc || typeof doc.querySelector !== "function") return false;
  return Boolean(doc.querySelector(OVERLAY_ROLE_SELECTOR));
}

/**
 * @param {{ key?: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean,
 *   shiftKey?: boolean, target?: unknown } | null | undefined} event
 * @returns {number | null} -1 for previous, 1 for next, null when the key is
 *   not ours. Up/down stay unbound.
 */
function getArrowNavigationStep(event) {
  if (!event) return null;
  // A modified arrow is the browser's (back/forward) or the OS's, never ours.
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return null;
  if (isTypingTarget(event.target)) return null;
  return event.key === "ArrowLeft" ? -1 : 1;
}

module.exports = { getArrowNavigationStep, isOverlayOpen, isTypingTarget };
