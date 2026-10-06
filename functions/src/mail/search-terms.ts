/**
 * Undoing Gmail's dialect: a written query in, provider-neutral terms out.
 *
 * The manual attach path is full of strings that were written as Gmail queries
 * — a learned Partner pattern stored as `from:amazon.de invoice`, a Gemini
 * suggestion prompted in Gmail's syntax, whatever the user typed into the
 * search box. #240 lowers all of them to MailSearchTerms before they reach a
 * mailbox, so one operator cannot mean a search on Gmail and a literal word
 * on IMAP.
 *
 * The counterpart is mail/gmail-query.ts, which compiles terms back into a
 * Gmail query for the mailbox that does speak it.
 */

import type { MailSearchTerms } from "./provider";

/**
 * Words and quotes, with a quoted phrase kept whole — including the phrase an
 * operator introduces, so `subject:"Ihre Rechnung"` stays one term instead of
 * splitting into a broken operator and a stray word.
 */
const TOKEN = /(?:[A-Za-z]+\s*:\s*)?"[^"]*"|\S+/g;

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

/**
 * The operators this module reads off a written query.
 *
 * Four have a neutral equivalent (`from`, `filename`, `subject`, `has`). The
 * rest are Gmail's alone and are dropped — they are listed rather than matched
 * by shape so that a colon inside an ordinary search term survives: an invoice
 * number written `RE:2024-88` is text, not an operator, and Gmail reads it as
 * text too.
 */
const OPERATOR =
  /^(from|filename|subject|has|to|cc|bcc|label|is|in|list|category|deliveredto|rfc822msgid|size|larger|smaller|after|before|older|newer|older_than|newer_than)\s*:\s*(.+)$/i;

/**
 * Read one written query as terms.
 *
 * Operators that have a neutral equivalent become it (`from:`, `filename:`,
 * `has:attachment`). `subject:` lowers to a plain keyword — no provider term
 * says "in the subject only", and dropping the word instead would lose the
 * search. A negated term is dropped, because no provider term says "not" and a
 * literal "-word" would match nothing. Anything else is free text.
 *
 * Juxtaposed words stay ANDed keywords, because `${partner} rechnung` is what
 * the pattern layer emits constantly and it means both words. Words joined by a
 * bare `OR` become one `anyOf` group instead (#274): `(rechnung OR invoice)`
 * means either word, and ANDing it would miss every mail carrying only one.
 * Parens are stripped; an OR only joins two free-text words, so an OR next to
 * an operator or at either end of the query is dropped.
 */
export function termsFromQuery(query: string): MailSearchTerms {
  // Free-text words in order, each a list of alternatives: a word joined to the
  // one before it by OR lands in that word's list.
  const groups: string[][] = [];
  const filenames: string[] = [];
  let from: string | undefined;
  let hasAttachment: boolean | undefined;
  // True right after an OR that follows a free-text word.
  let joinNext = false;
  let lastWasWord = false;

  for (const raw of query.match(TOKEN) ?? []) {
    const token = raw.replace(/^\(+|\)+$/g, "").trim();
    if (!token || token === "AND") continue;
    if (token === "OR") {
      joinNext = lastWasWord;
      continue;
    }
    const join = joinNext;
    joinNext = false;
    lastWasWord = false;

    // A leading `-` is Gmail's negation, and nothing in the neutral vocabulary
    // says "not". Kept as a keyword it would search for a literal "-word" and
    // find nothing; dropped, the search is only wider than the writer asked
    // for. Wider is the honest failure of the two.
    if (token.startsWith("-")) continue;

    const operator = OPERATOR.exec(token);
    if (!operator) {
      const text = unquote(token);
      if (text) {
        if (join) groups[groups.length - 1].push(text);
        else groups.push([text]);
        lastWasWord = true;
      }
      continue;
    }

    const value = unquote(operator[2]);
    switch (operator[1].toLowerCase()) {
      case "from":
        from = value;
        break;
      case "filename":
        filenames.push(value);
        break;
      case "subject":
        if (value) {
          if (join) groups[groups.length - 1].push(value);
          else groups.push([value]);
          lastWasWord = true;
        }
        break;
      case "has":
        // `has:attachment`; any other `has:` value is Gmail-only and dropped.
        if (value.toLowerCase() === "attachment") hasAttachment = true;
        break;
      default:
        // A Gmail-only operator with no neutral equivalent. Dropped, never kept
        // as a keyword: `label:Rechnungen` held as free text is re-emitted
        // unquoted, so Gmail reads it back as the operator it always was and
        // IMAP searches for the literal string — provider syntax smuggled
        // through a request that is supposed to carry none (#240's first
        // acceptance criterion). Dropping it only widens the search, which is
        // this module's standing choice for a term it cannot express.
        break;
    }
  }

  const keywords = groups.filter((g) => g.length === 1).map((g) => g[0]);
  const anyOf = groups.filter((g) => g.length > 1);

  return {
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(anyOf.length > 0 ? { anyOf } : {}),
    ...(from ? { from } : {}),
    ...(filenames.length > 0 ? { filenames } : {}),
    ...(hasAttachment !== undefined ? { hasAttachment } : {}),
  };
}

/**
 * One suggestion's terms as a search names them: an omitted keyword or
 * filename list means the suggestion named none, never the invoice sweep a
 * provider falls back to when nothing is named. Null when the terms name
 * nothing a mailbox can search for, so a caller skips them rather than search
 * the whole window (#746).
 */
export function namedSearchTerms(terms: MailSearchTerms): MailSearchTerms | null {
  const named =
    (terms.keywords?.length ?? 0) > 0 ||
    (terms.anyOf?.length ?? 0) > 0 ||
    Boolean(terms.from) ||
    (terms.filenames?.length ?? 0) > 0;
  if (!named) return null;
  return { ...terms, keywords: terms.keywords ?? [], filenames: terms.filenames ?? [] };
}
