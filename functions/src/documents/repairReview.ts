/**
 * Detector: an extracted value that came through a repaired escape (#275).
 *
 * When the model's response does not parse, `repairJson` neutralises the
 * backslashes JSON cannot interpret and leaves the ones it defines alone. Both
 * rules are right on their own and they disagree inside a single value: a
 * document that prints `C:\temp\scan.pdf` arrives as a `\t` the repair honours
 * and a `\s` it neutralises, and the transcription is stored with a TAB in it.
 *
 * The ambiguity is irreducible at that layer — given `\t`, "the model escaped a
 * real tab" and "the document prints backslash-t" are the same two bytes, and
 * #231 chose the JSON-correct reading. What was missing is that nobody was ever
 * told a coin had been flipped: the response parses, the value is written like
 * any other, and it reaches the detail panel, matching and the export unmarked.
 *
 * So this module does not decide anything about the escape. It takes the verdict
 * the pass already reached — the only place that knows which literals it had to
 * modify — and turns it into the stored review flag, the same shape as
 * `vatRateReview` (#203) and `directionReview` (#233).
 */

/** The repair facts an extraction produces, as far as this rule cares. */
export interface RepairFacts {
  /**
   * Field names the backslash pass had to guess at. Empty or absent on every
   * response that parsed first time, and on every record written before #275 —
   * the raw response is gone by then, so those stay unflagged deliberately.
   */
  ambiguousFields?: string[] | null;
  /** Already ruled out as a financial document — its values were cleared. */
  isNotInvoice?: boolean;
}

export interface RepairReviewResult {
  /** The affected field names, deduplicated, in the order the pass saw them. */
  ambiguousFields: string[];
  /** True exactly when `ambiguousFields` is non-empty. */
  needsReview: boolean;
}

export function reviewRepair(facts: RepairFacts): RepairReviewResult {
  if (facts.isNotInvoice) {
    return { ambiguousFields: [], needsReview: false };
  }

  const seen = new Set<string>();
  for (const field of facts.ambiguousFields ?? []) {
    if (typeof field === "string" && field.trim().length > 0) seen.add(field.trim());
  }

  const ambiguousFields = [...seen];
  return { ambiguousFields, needsReview: ambiguousFields.length > 0 };
}

/**
 * The fields a repair review writes onto a file record.
 *
 * `needsRepairReview` is the queryable flag; the field names are what let the
 * record be read without opening the PDF — the `vatRatesOutsideSet` idea.
 */
export function repairReviewFields(result: RepairReviewResult): Record<string, unknown> {
  return {
    needsRepairReview: result.needsReview,
    repairAmbiguousFields: result.ambiguousFields,
  };
}
