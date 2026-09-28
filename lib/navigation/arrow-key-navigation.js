/**
 * Keyboard guard for detail-panel prev/next navigation.
 *
 * Left/right step the open detail panel through the rows the table displays,
 * using the same navigate functions as the prev/next buttons. The keys belong
 * to whatever is on top, so they are dropped while the user is typing and
 * while a portalled surface (dialog, menu, select popup, popover) is open.
 * The connect overlays render inline with no role of their own, so
 * `isOverlayOpen` cannot see them; the page folds them into the `enabled` flag
 * through `isRowNavigationEnabled`.
 *
 * The full-screen file viewer is NOT an exclusion. It stays open while moving
 * between Files so a stack of documents can be read through, and the keys work
 * there too (felixtosh/FiBuKI#234, reversing yazzbert/FiBuKI-selfhost#158). It
 * binds no arrow keys of its own, so nothing collides.
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

/**
 * Whether the page should hand the hook live keys.
 *
 * @param {{ panelOpen: boolean, connectOverlayOpen: boolean }} state
 *   `panelOpen`: a detail panel is showing. `connectOverlayOpen`: a connect
 *   overlay (pick a transaction or a file to attach) covers the list. That is a
 *   distinct task, not document browsing, so it keeps the keys switched off.
 *   The file viewer is deliberately not an input: it never disables the keys.
 * @returns {boolean}
 */
function isRowNavigationEnabled(state) {
  if (!state) return false;
  return Boolean(state.panelOpen) && !state.connectOverlayOpen;
}

module.exports = {
  getArrowNavigationStep,
  isOverlayOpen,
  isRowNavigationEnabled,
  isTypingTarget,
};
