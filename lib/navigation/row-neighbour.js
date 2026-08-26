/**
 * Neighbour lookup for detail-panel prev/next navigation.
 *
 * The table owns the order the user sees — the page's filters and search fold
 * into the rows it is given, the sort column and direction are its own state —
 * so pages hand that ordered id list in here instead of re-deriving order from
 * their own data array.
 *
 * @param {string[]} orderedIds row ids in the order the table displays them
 * @param {string | null | undefined} currentId id the detail panel is showing
 * @param {number} step -1 for previous, 1 for next
 * @returns {string | null} the neighbour id, or null at the ends of the order
 *   and when the current id is not part of it
 */
function getNeighbourRowId(orderedIds, currentId, step) {
  if (!Array.isArray(orderedIds) || !currentId) return null;

  const currentIndex = orderedIds.indexOf(currentId);
  if (currentIndex === -1) return null;

  const targetIndex = currentIndex + step;
  if (targetIndex < 0 || targetIndex >= orderedIds.length) return null;

  return orderedIds[targetIndex] ?? null;
}

module.exports = { getNeighbourRowId };
