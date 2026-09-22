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
 * Gmail's grouping punctuation (parens, a bare `OR`) is stripped, and the terms
 * it grouped become ordinary keywords — which `buildGmailQuery` then ANDs. That
 * NARROWS a query that meant "either word": `(rechnung OR invoice)` goes out as
 * `rechnung invoice`. Named keywords have to AND, because `${partner} rechnung`
 * is what the pattern layer emits constantly and it means both words; there is
 * no term in the vocabulary for "any of these" that would not also widen that.
 * Recording the trade rather than hiding it — see the discussion on #240.
 */
export function termsFromQuery(query: string): MailSearchTerms {
  const keywords: string[] = [];
  const filenames: string[] = [];
  let from: string | undefined;
  let hasAttachment: boolean | undefined;

  for (const raw of query.match(TOKEN) ?? []) {
    const token = raw.replace(/^\(+|\)+$/g, "").trim();
    if (!token || token === "OR" || token === "AND") continue;

    // A leading `-` is Gmail's negation, and nothing in the neutral vocabulary
    // says "not". Kept as a keyword it would search for a literal "-word" and
    // find nothing; dropped, the search is only wider than the writer asked
    // for. Wider is the honest failure of the two.
    if (token.startsWith("-")) continue;

    const operator = OPERATOR.exec(token);
    if (!operator) {
      const text = unquote(token);
      if (text) keywords.push(text);
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
        if (value) keywords.push(value);
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

  return {
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(from ? { from } : {}),
    ...(filenames.length > 0 ? { filenames } : {}),
    ...(hasAttachment !== undefined ? { hasAttachment } : {}),
  };
}
