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

/**
 * The response keys a stored file field was read from (#301).
 *
 * `repairAmbiguousFields` holds the keys of the RESPONSE the pass guessed in
 * (`address`, `date_raw`, a line item's `description`), not the file record's
 * names, so a later reader can still correlate it with the parse. A correction
 * writes the record's names. This is the bridge between the two.
 *
 * A key with no field here cannot be corrected by hand — `rawText`,
 * `invoiceNumber` — so a flag naming it stays until re-extraction. So does one
 * naming an additional field's `label` or `value`: the panel posts those rows
 * whole on every save, and without a reliable "did this move" for them a plain
 * save would retire a warning nobody acted on.
 */
const RESPONSE_KEYS_BY_FILE_FIELD: Record<string, string[]> = {
  extractedAmount: ["amount", "amount_raw"],
  extractedVatPercent: ["vatPercent", "vatPercent_raw"],
  extractedDate: ["date", "date_raw"],
  extractedTipAmount: ["tipAmount"],
  extractedLineItems: ["description"],
  // The counterparty is the issuer's or the recipient's `name`, depending on
  // direction; the legacy flat key is `partner`.
  extractedPartner: ["partner", "partner_raw", "name"],
  extractedVatId: ["vatId", "vatId_raw"],
  extractedIban: ["iban", "iban_raw"],
  extractedAddress: ["address", "address_raw"],
};

/**
 * Retire the repair flag field by field as a person corrects those fields
 * (#301).
 *
 * The flag is a parse-time fact, so there is nothing to recompute the way the
 * VAT review is recomputed. What changes is whether the guess is still worth
 * warning about: a hand-corrected value is authoritative by the same rule that
 * makes every other correction authoritative, so the field it replaced is
 * dropped from the list, and the flag clears when the list empties.
 *
 * `correctedFields` are file-record names, and must be fields the correction
 * actually MOVED — a save that re-posts the stored value corrected nothing.
 * Returns an empty object when the record is not flagged or nothing it names
 * was corrected, so a caller can merge it unconditionally.
 */
export function retireRepairAmbiguity(
  record: Record<string, unknown>,
  correctedFields: string[]
): Record<string, unknown> {
  const stored = record.repairAmbiguousFields;
  if (!Array.isArray(stored) || stored.length === 0) return {};

  const retired = new Set<string>();
  for (const field of correctedFields) {
    for (const key of RESPONSE_KEYS_BY_FILE_FIELD[field] ?? []) retired.add(key);
  }

  const remaining = stored.filter(
    (key): key is string => typeof key === "string" && !retired.has(key)
  );
  if (remaining.length === stored.length) return {};

  return repairReviewFields({ ambiguousFields: remaining, needsReview: remaining.length > 0 });
}
