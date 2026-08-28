"use client";

import { useTranslations } from "next-intl";

/**
 * Resolve a document presentation label for the interface locale.
 *
 * `lib/documents/document-type-presentation.js` decides what a document IS and
 * carries two forms of the word: `labelKey` for the message catalogue, and
 * `label` as the English default for callers with no translator (the agent
 * tools, the exports, the node tests). This hook is the only place the UI turns
 * one into the other, so a badge in the files table and the same fact in the
 * file panel cannot end up in different languages.
 *
 * The fallback is deliberate. next-intl throws on a missing key rather than
 * degrading, and these labels render on every row of two tables, so one absent
 * catalogue entry would blank a screen instead of one word.
 *
 * Only UI chrome comes through here. The § 11 element names stay German in
 * every locale because they are citations the user quotes to a supplier, and
 * the supplier request text stays German because its reader is an Austrian
 * supplier rather than the person using the app.
 */
export interface LabelledPresentation {
  label: string;
  labelKey?: string;
}

export function useDocumentLabel(): (presentation: LabelledPresentation) => string {
  const t = useTranslations();
  return (presentation: LabelledPresentation) => {
    if (!presentation.labelKey) return presentation.label;
    try {
      return t(presentation.labelKey);
    } catch {
      return presentation.label;
    }
  };
}
