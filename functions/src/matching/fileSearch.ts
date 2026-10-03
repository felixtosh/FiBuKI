/**
 * The Connect File window's search predicate (#555): which of a File's fields
 * hold the typed text.
 *
 * Called by BOTH halves of the search, as transactionSearch.ts is on the other
 * side: the server candidate gate in findFileMatches.ts and the window's
 * client filter. The window shows the server's scores over the client's File
 * list, so a predicate on only one side would make a File appear and then
 * disappear as the debounce resolves.
 *
 * A search filter, not a Match Source: a hit never contributes to Confidence.
 * Dependency-free on purpose: the app imports it through
 * `@/functions/src/matching/fileSearch`.
 */

export interface SearchableFile {
  fileName?: string | null;
  extractedPartner?: string | null;
  gmailSubject?: string | null;
  gmailSenderEmail?: string | null;
  gmailSenderName?: string | null;
  extractedVatId?: string | null;
  extractedIban?: string | null;
  extractedWebsite?: string | null;
  extractedText?: string | null;
}

/**
 * Below this, a query is too short to search a document's text: three
 * letters turn up in nearly every invoice.
 */
const MIN_TEXT_QUERY_LENGTH = 4;

const includes = (value: string | null | undefined, needle: string) =>
  !!value && value.toLowerCase().includes(needle);

/**
 * The fields of `file` that contain `query`, as the labels the window prints
 * ("Matched: partner, email subject"). Empty when nothing matches, or when the
 * query is blank. The document text is named only when nothing else matched.
 */
export function fileSearchMatches(file: SearchableFile, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matched: string[] = [];
  if (includes(file.fileName, needle)) matched.push("filename");
  if (includes(file.extractedPartner, needle)) matched.push("partner");
  if (includes(file.gmailSubject, needle)) matched.push("email subject");
  if (includes(file.gmailSenderEmail, needle) || includes(file.gmailSenderName, needle)) {
    matched.push("email sender");
  }
  if (includes(file.extractedVatId, needle)) matched.push("VAT ID");
  if (includes(file.extractedIban, needle)) matched.push("IBAN");
  if (includes(file.extractedWebsite, needle)) matched.push("website");
  if (
    matched.length === 0 &&
    needle.length >= MIN_TEXT_QUERY_LENGTH &&
    includes(file.extractedText, needle)
  ) {
    matched.push("document text");
  }
  return matched;
}
