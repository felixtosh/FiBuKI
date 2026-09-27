const { getNeighbourRowId } = require("./row-neighbour");

/**
 * Queue triage (#251): after dispositioning the row the detail panel shows,
 * open the next row in the displayed order.
 *
 * The next row's identity is captured BEFORE the write, from the order as it
 * stands at that moment. The write can make the current row leave the list
 * (marking not-invoice turns its Document Type into `other`, which an active
 * Document filter may exclude), and "the row after this one" looked up
 * afterwards would find nothing.
 *
 * At the end of the list there is nothing to advance to and the panel stays
 * on the row: wrapping would re-serve Files already dealt with, and closing
 * would throw away where the user was. A failed write does not navigate.
 *
 * @param {{
 *   orderedIds: string[],
 *   currentId: string | null | undefined,
 *   mutate: () => Promise<unknown>,
 *   navigateTo: (id: string) => void,
 * }} args
 * @returns {Promise<string | null>} the row navigated to, or null
 */
async function advanceAfterDisposition({ orderedIds, currentId, mutate, navigateTo }) {
  const nextId = getNeighbourRowId(orderedIds, currentId, 1);
  await mutate();
  if (nextId) navigateTo(nextId);
  return nextId;
}

module.exports = { advanceAfterDisposition };
