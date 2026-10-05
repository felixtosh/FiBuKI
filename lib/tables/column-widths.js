/**
 * Remembered column widths (#674): a table's resized columns survive a reload,
 * per browser, the way the detail panel's width and the list filters do. Never
 * server-side: a column width is a working view, not account data.
 *
 * What is stored is a JSON object of column id to width in px. It is read back
 * against the columns the table has now: a column that no longer exists is
 * ignored, and a width outside a column's min/max is clamped into it, so a
 * changed column definition can never be squeezed or blown up by an old value.
 * Plain data in, plain data out, so it is testable with node --test.
 */

/**
 * The widths a stored string holds, unchecked against any column: every entry
 * that is a positive finite number, rounded to whole px. Anything unreadable
 * reads as nothing stored.
 *
 * @param {string | null | undefined} saved
 * @returns {Record<string, number>}
 */
function parseColumnWidths(saved) {
  if (!saved) return {};
  let parsed;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  /** @type {Record<string, number>} */
  const widths = {};
  for (const [id, width] of Object.entries(parsed)) {
    if (typeof width === "number" && Number.isFinite(width) && width > 0) {
      widths[id] = Math.round(width);
    }
  }
  return widths;
}

/**
 * A width held inside one column's limits.
 *
 * @param {number} width
 * @param {{ min: number, max: number }} limits
 * @returns {number}
 */
function clampColumnWidth(width, limits) {
  return Math.min(limits.max, Math.max(limits.min, width));
}

/**
 * The width a column renders at: its sized width clamped to its limits, or
 * undefined when it has none (the table then uses the column's default).
 *
 * @param {Record<string, number>} sizing
 * @param {string} columnId
 * @param {{ min: number, max: number }} limits
 * @returns {number | undefined}
 */
function sizedColumnWidth(sizing, columnId, limits) {
  const width = sizing[columnId];
  if (typeof width !== "number" || !Number.isFinite(width)) return undefined;
  return clampColumnWidth(width, limits);
}

/**
 * The string to store for a table's sizing: only the columns it has now, each
 * clamped to its limits and rounded to whole px.
 *
 * @param {Record<string, number>} sizing
 * @param {Record<string, { min: number, max: number }>} limitsById
 * @returns {string}
 */
function columnWidthsToStore(sizing, limitsById) {
  /** @type {Record<string, number>} */
  const widths = {};
  for (const [id, limits] of Object.entries(limitsById)) {
    const width = sizedColumnWidth(sizing, id, limits);
    if (width !== undefined) widths[id] = Math.round(width);
  }
  return JSON.stringify(widths);
}

/**
 * Read a key, or null when storage is missing or refuses (a private window,
 * blocked site data). Takes a getter because touching `window.localStorage`
 * can itself throw.
 *
 * @param {() => Pick<Storage, "getItem">} getStorage
 * @param {string} key
 * @returns {string | null}
 */
function readStoredColumnWidths(getStorage, key) {
  try {
    return getStorage().getItem(key);
  } catch {
    return null;
  }
}

/**
 * Write a key; a refusal is swallowed, the widths then just last until reload.
 *
 * @param {() => Pick<Storage, "setItem">} getStorage
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function writeStoredColumnWidths(getStorage, key, value) {
  try {
    getStorage().setItem(key, value);
  } catch {
    // Private mode or blocked storage: nothing to remember the widths in.
  }
}

module.exports = {
  parseColumnWidths,
  clampColumnWidth,
  sizedColumnWidth,
  columnWidthsToStore,
  readStoredColumnWidths,
  writeStoredColumnWidths,
};
