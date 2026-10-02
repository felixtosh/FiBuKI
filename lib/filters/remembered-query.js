/**
 * Which part of a list's URL is worth remembering, and when to put it back
 * (#530): the filters and search a user set on Files or Partners survive a
 * trip to another page, the way Transactions already keeps its own.
 *
 * Remembered per browser, never on the server: two screens on two lists (or
 * on one list with two filters) must not overwrite each other, and a filter is
 * a working view, not account data. Plain data in, plain data out, so it is
 * testable with node --test.
 */

/** Params that address a row or an overlay, never a filter. */
const NON_FILTER_PARAMS = ["id", "connect", "preview", "invoiceId"];

/**
 * The filter-and-search part of a query string, sorted so equal filters are
 * equal strings. Empty when nothing is filtered.
 *
 * @param {string} search  a query string, with or without the leading "?"
 * @returns {string}
 */
function rememberableQuery(search) {
  const params = new URLSearchParams(search);
  for (const key of NON_FILTER_PARAMS) params.delete(key);
  params.sort();
  return params.toString();
}

/**
 * The query to restore on arriving at a list, or null to leave the URL alone.
 *
 * Restores only onto a bare list: a URL that already carries a filter is an
 * explicit ask, and one that opens a row (?id=) is a deep link whose row has
 * to stay visible, which an old filter could hide.
 *
 * @param {string} search  the query string the list was opened with
 * @param {string | null | undefined} stored  what rememberableQuery saved last
 * @returns {string | null}
 */
function queryToRestore(search, stored) {
  if (!stored) return null;
  const params = new URLSearchParams(search);
  if (params.has("id") || params.has("invoiceId")) return null;
  if (rememberableQuery(search) !== "") return null;
  return stored;
}

module.exports = { rememberableQuery, queryToRestore, NON_FILTER_PARAMS };
