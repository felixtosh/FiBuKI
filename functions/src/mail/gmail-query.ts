/**
 * Gmail's query dialect, in one place.
 *
 * Provider-neutral MailSearchTerms (#240) go in, a Gmail `q` string comes out.
 * Two callers compile the same terms — GmailProvider for Sync and the manual
 * attach path's callable — so a term can never mean one thing in a synced
 * mailbox and another in the attach overlay.
 *
 * Date clauses are NOT built here: the two callers format their windows
 * differently (the sync worker makes `before:` inclusive by adding a day, the
 * attach path passes the window through as the caller set it), and unifying
 * that would change behaviour neither ticket asked to change.
 */

import { MailSearchTerms } from "./provider";
import { INVOICE_KEYWORDS } from "./constants";

/**
 * One free-text term as Gmail should read it.
 *
 * Quoting rule: a caller-named keyword is quoted only when it carries
 * whitespace. Quoting a single word turns Gmail's token match into an exact
 * phrase match and would narrow what the attach path finds today, which #240
 * explicitly protects. The shared invoice keywords are the exception below —
 * the sync worker has always sent them quoted, and keeping that keeps its query
 * byte-identical to the one it sent before terms existed.
 */
function freeText(keyword: string): string {
  return /\s/.test(keyword) ? `"${keyword}"` : keyword;
}

/** `a` for one term, `(a OR b)` for several, `""` for none. */
function orClause(terms: string[]): string {
  const kept = terms.filter((t) => t.length > 0);
  if (kept.length === 0) return "";
  if (kept.length === 1) return kept[0];
  return `(${kept.join(" OR ")})`;
}

/**
 * The term half of a Gmail query. Append your own date clauses.
 *
 * A search naming no keywords is the invoice sweep: the shared keyword list,
 * quoted and ORed, exactly as `buildInvoiceSearchQuery` used to spell it inline.
 */
export function buildGmailQuery(terms: MailSearchTerms): string {
  const parts: string[] = [];
  // Naming a term — even an empty list of keywords — opts out of the invoice
  // sweep below. Only a caller that names nothing at all gets it.
  const namesATerm =
    terms.keywords !== undefined ||
    terms.from !== undefined ||
    terms.filenames !== undefined;

  // Named keywords are ANDed by juxtaposition, which is Gmail's own default and
  // therefore the string the attach path has always sent: "netflix rechnung"
  // stays two words that must both appear. ORing them here would widen every
  // two-word suggestion the pattern layer emits into "any invoice, or anything
  // from Netflix", which is the recall #240 protects (the sweep below is the
  // one place ANY is meant, and it says so).
  const keywordClause = terms.keywords
    ? terms.keywords.map(freeText).filter((t) => t.length > 0).join(" ")
    : orClause(INVOICE_KEYWORDS.map((k) => `"${k}"`));
  if (keywordClause) parts.push(keywordClause);

  if (terms.from) parts.push(`from:${terms.from}`);

  if (terms.hasAttachment !== false) parts.push("has:attachment");

  // The invoice sweep has always been PDFs only; a caller that names terms of
  // its own gets exactly the filenames it asked for, including none. Filenames
  // are alternatives (one attachment cannot be named two things), so unlike
  // keywords they stay ORed.
  const filenames = namesATerm ? terms.filenames ?? [] : ["pdf"];
  const filenameClause = orClause(filenames.map((f) => `filename:${f}`));
  if (filenameClause) parts.push(filenameClause);

  return parts.join(" ");
}
