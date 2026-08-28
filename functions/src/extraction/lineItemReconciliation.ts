/**
 * Line-item reconciliation against the document's own totals (fork #64/#67).
 *
 * Pure arithmetic over extracted values — no Firestore, no SDK. Split out of
 * extractionCore so the correction path (#203) can re-derive
 * `lineItemsUnreconciled` through exactly the same rules extraction used to
 * set it, without importing the extraction pipeline and everything it drags
 * in. extractionCore re-exports the public names, so its callers and tests
 * are unaffected.
 */

import { ExtractedLineItem, ExtractedRateGroup } from "../types/extraction";

function isLikelyNonBillableLine(description: string): boolean {
  const normalized = description.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  const patterns: RegExp[] = [
    /^subtotal\b/,
    /^total\b/,
    /^total excluding tax\b/,
    /^amount paid\b/,
    /^payment history\b/,
    /^vat\b/,
    /^tax\b/,
    /^first\s+\d+/,
    /\band above\b/,
    /^description\b/,
    /^qty\b/,
    /^unit price\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function inferLineItemAmountsAreNet(lineItems: ExtractedLineItem[]): boolean {
  let comparedItems = 0;
  let netInterpretationError = 0;
  let grossInterpretationError = 0;

  for (const item of lineItems) {
    if (
      item.vatPercent === null ||
      !Number.isFinite(item.vatPercent) ||
      item.vatPercent <= 0 ||
      !Number.isFinite(item.vatAmount)
    ) {
      continue;
    }

    const rate = item.vatPercent;
    const expectedVatIfNet = Math.round((item.amount * rate) / 100);
    const expectedVatIfGross = Math.round((item.amount * rate) / (100 + rate));

    netInterpretationError += Math.abs(expectedVatIfNet - item.vatAmount);
    grossInterpretationError += Math.abs(expectedVatIfGross - item.vatAmount);
    comparedItems += 1;
  }

  if (comparedItems === 0) {
    return false;
  }

  return netInterpretationError < grossInterpretationError;
}


export function consolidateLineItems(
  lineItems: ExtractedLineItem[],
  extractedDocumentAmount?: number | null
): {
  totalAmount: number;
  totalVatAmount: number;
  consolidatedVatPercent: number | null;
} {
  const totalAmountFromItems = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const totalVatAmount = lineItems.reduce((sum, item) => sum + item.vatAmount, 0);
  const totalAmountFromNetPlusVat = totalAmountFromItems + totalVatAmount;

  const firstRate = lineItems[0]?.vatPercent ?? null;
  const hasSingleRate = firstRate !== null && lineItems.every((item) =>
    item.vatPercent !== null && Math.abs(item.vatPercent - firstRate) < 0.0001
  );

  let totalAmount = totalAmountFromItems;

  if (typeof extractedDocumentAmount === "number" && Number.isFinite(extractedDocumentAmount)) {
    const distanceToAsIs = Math.abs(totalAmountFromItems - extractedDocumentAmount);
    const distanceToNetPlusVat = Math.abs(totalAmountFromNetPlusVat - extractedDocumentAmount);

    if (distanceToNetPlusVat < distanceToAsIs) {
      totalAmount = totalAmountFromNetPlusVat;
    } else {
      totalAmount = totalAmountFromItems;
    }
  } else {
    const amountsLookNet = totalVatAmount > 0 && inferLineItemAmountsAreNet(lineItems);
    totalAmount = amountsLookNet ? totalAmountFromNetPlusVat : totalAmountFromItems;
  }

  return {
    totalAmount,
    totalVatAmount,
    consolidatedVatPercent: hasSingleRate ? firstRate : null,
  };
}

/** Reconciliation tolerance for a figure: 5 cents or 0.5%, whichever is larger. */
function amountTolerance(amount: number): number {
  return Math.max(5, Math.round(amount * 0.005));
}

/**
 * Validate the document's printed VAT summary block (fork #67, spec §6
 * item 3) before anything is allowed to trust it.
 *
 * The block earns its authority from being PRINTED, so a transcription we
 * cannot verify is worth less than no block at all — a hallucinated
 * summary would silently become the VAT truth for the whole document.
 * Three gates, all-or-nothing across the block:
 *
 *  1. each row is internally consistent (net + vat = gross, and vat is
 *     what the row's own rate implies),
 *  2. the rows sum to the document total,
 *  3. no negative or empty figures.
 *
 * A block that fails any gate is discarded, and the caller falls back to
 * whole-document reconciliation exactly as before fork #67.
 */
export function validateRateGroups(
  rateGroups: ExtractedRateGroup[] | null | undefined,
  extractedAmount: number | null | undefined
): ExtractedRateGroup[] | null {
  if (!Array.isArray(rateGroups) || rateGroups.length === 0) {
    return null;
  }

  for (const g of rateGroups) {
    if (
      typeof g?.rate !== "number" || !Number.isFinite(g.rate) ||
      g.rate < 0 || g.rate > 100 ||
      typeof g.net !== "number" || !Number.isFinite(g.net) ||
      typeof g.vat !== "number" || !Number.isFinite(g.vat) ||
      typeof g.gross !== "number" || !Number.isFinite(g.gross)
    ) {
      return null;
    }
    if (g.net < 0 || g.vat < 0 || g.gross <= 0) {
      return null;
    }
    // net + vat = gross, allowing per-row cent rounding.
    if (Math.abs(g.net + g.vat - g.gross) > 2) {
      return null;
    }
    // The printed vat must be what the printed rate implies for the
    // printed net — this is what catches a column read off the wrong row.
    const impliedVat = Math.round((g.net * g.rate) / 100);
    if (Math.abs(g.vat - impliedVat) > Math.max(2, Math.round(g.gross * 0.002))) {
      return null;
    }
  }

  if (typeof extractedAmount === "number" && Number.isFinite(extractedAmount) && extractedAmount > 0) {
    const summed = rateGroups.reduce((sum, g) => sum + g.gross, 0);
    if (Math.abs(summed - extractedAmount) > amountTolerance(extractedAmount)) {
      console.warn(
        `[ExtractionCore] Printed rate groups sum to ${summed} cents but the ` +
        `document total is ${extractedAmount}. Discarding the block.`
      );
      return null;
    }
  }

  return rateGroups;
}

/**
 * The VAT-bearing Summe, once a printed Trinkgeld is out of it (#172).
 *
 * A restaurant Beleg paid by card prints three figures — Summe, Trinkgeld,
 * Gesamt — and only the Summe carries the printed rate groups. The prompt
 * asks for the Summe in `amount`, but when the model hands back the Gesamt
 * anyway the printed block is the arbiter: a block that reconciles against
 * `amount - tip` and NOT against `amount` says `amount` is the Gesamt.
 *
 * Nothing weaker moves the figure. Subtracting a tip on the model's word
 * alone would be the loose-tolerance fix this ticket exists to avoid — it
 * would let a hallucinated tip line eat 3,20 EUR of a real VAT base.
 */
export function totalWithoutPrintedTip(
  extractedAmount: number | null | undefined,
  tipAmount: number | null | undefined,
  rateGroups: ExtractedRateGroup[] | null | undefined
): number | null | undefined {
  if (typeof extractedAmount !== "number" || !Number.isFinite(extractedAmount)) {
    return extractedAmount;
  }
  if (typeof tipAmount !== "number" || tipAmount <= 0 || extractedAmount <= tipAmount) {
    return extractedAmount;
  }
  if (!Array.isArray(rateGroups) || rateGroups.length === 0) {
    return extractedAmount;
  }

  const summed = rateGroups.reduce((sum, g) => sum + (g?.gross ?? 0), 0);
  const withoutTip = extractedAmount - tipAmount;
  const fitsWithoutTip = Math.abs(summed - withoutTip) <= amountTolerance(withoutTip);
  const fitsTotal = Math.abs(summed - extractedAmount) <= amountTolerance(extractedAmount);
  if (fitsWithoutTip && !fitsTotal) {
    console.warn(
      `[ExtractionCore] Document total ${extractedAmount} includes the printed ` +
      `tip of ${tipAmount}; the rate groups sum to ${summed}. Reading ${withoutTip} ` +
      "as the VAT-bearing total."
    );
    return withoutTip;
  }
  return extractedAmount;
}

/**
 * Do the line items carrying `rate` reproduce the printed group total?
 *
 * Line item `amount` is gross on most extractions and net on some, and the
 * interpretation can differ between groups on the same receipt — so each
 * group is tested against both readings independently. That is precisely
 * the case a single global net-or-gross decision gets wrong.
 */
function rateGroupReconciles(
  group: ExtractedRateGroup,
  itemsAtRate: ExtractedLineItem[]
): boolean {
  if (itemsAtRate.length === 0) {
    return false;
  }
  const summedAmount = itemsAtRate.reduce((sum, item) => sum + item.amount, 0);
  const summedVat = itemsAtRate.reduce((sum, item) => sum + item.vatAmount, 0);
  const tolerance = amountTolerance(group.gross);

  return (
    Math.abs(summedAmount - group.gross) <= tolerance ||
    Math.abs(summedAmount + summedVat - group.gross) <= tolerance
  );
}

export interface ReconciliationResult {
  lineItems: ExtractedLineItem[];
  unreconciled: boolean;
  /**
   * The VAT rates whose printed group the line items failed to reproduce.
   * Empty while `unreconciled` is true means the damage could not be
   * localised and the whole document is suspect.
   */
  unreconciledRates: number[];
  /** The printed VAT summary block, once validated; null when unusable. */
  rateGroups: ExtractedRateGroup[] | null;
}

/**
 * Convert NET line items to the gross form every consumer of
 * `extractedLineItems` assumes (fork #137).
 *
 * A row's `amount` is read as gross throughout: UVA derivation builds a rate
 * group as `gross = amount`, `net = amount - vatAmount`, and the file view
 * shows the row as billed. Documents that itemise net and add VAT once at the
 * bottom — every outgoing invoice does — therefore have to be converted here,
 * or the file either loses its VAT entirely (rows with no rate at all) or
 * silently reports a net figure as gross (rows that carry their own VAT).
 *
 * Nothing is invented. Three shapes are accepted, each proved by arithmetic the
 * document itself printed:
 *
 *  1. every row carries its own VAT, and net + VAT is what hits the document
 *     total while the raw sum does not;
 *  2. every row carries a rate but the VAT read off it was the gross reading,
 *     so re-reading it as VAT on top of a net row is what closes;
 *  3. no row carries a rate at all, the document states a single top-level
 *     rate, and grossing the rows up at exactly that rate hits the total.
 *
 * A mixed bag (some rows rated, some not) is a structural disagreement rather
 * than a net/gross reading, and is left to the caller to flag. So is any case
 * where none of the three closes: this returns null and the document goes down
 * the ordinary reconciliation path unchanged.
 *
 * The rounding residual (at most a few cents, since the gate is the tolerance)
 * lands on the largest row, so the converted rows sum to the document total
 * exactly rather than to within a cent of it.
 */
function grossUpNetLineItems(
  lineItems: ExtractedLineItem[],
  extractedAmount: number,
  documentVatPercent: number | null | undefined
): ExtractedLineItem[] | null {
  const netSum = lineItems.reduce((sum, item) => sum + item.amount, 0);
  if (netSum <= 0 || netSum >= extractedAmount) {
    return null;
  }

  const allRated = lineItems.every((item) => item.vatPercent !== null);
  const noneRated = lineItems.every((item) => item.vatPercent === null && item.vatAmount === 0);

  // Candidate readings of "the VAT that sits on top of these rows", tried in
  // order of how much of it the document actually stated.
  const candidates: Array<{ vats: number[]; fallbackRate: number | null }> = [];
  if (allRated) {
    candidates.push({ vats: lineItems.map((item) => item.vatAmount), fallbackRate: null });
    candidates.push({
      vats: lineItems.map((item) => Math.round((item.amount * (item.vatPercent as number)) / 100)),
      fallbackRate: null,
    });
  } else if (
    noneRated &&
    typeof documentVatPercent === "number" &&
    Number.isFinite(documentVatPercent) &&
    documentVatPercent > 0
  ) {
    candidates.push({
      vats: lineItems.map((item) => Math.round((item.amount * documentVatPercent) / 100)),
      fallbackRate: documentVatPercent,
    });
  }

  let largest = 0;
  for (let i = 1; i < lineItems.length; i++) {
    if (lineItems[i].amount > lineItems[largest].amount) {
      largest = i;
    }
  }

  for (const candidate of candidates) {
    const vats = [...candidate.vats];
    const vatSum = vats.reduce((sum, vat) => sum + vat, 0);
    if (vatSum <= 0) continue;
    if (Math.abs(netSum + vatSum - extractedAmount) > amountTolerance(extractedAmount)) continue;

    vats[largest] += extractedAmount - (netSum + vatSum);
    if (vats.some((vat) => vat < 0)) continue;

    return lineItems.map((item, i) => ({
      ...item,
      vatPercent: item.vatPercent ?? candidate.fallbackRate,
      vatAmount: vats[i],
      amount: item.amount + vats[i],
    }));
  }

  return null;
}

export function reconcileLineItemsWithDocumentTotal(
  lineItems: ExtractedLineItem[],
  extractedAmount: number | null | undefined,
  rateGroups?: ExtractedRateGroup[] | null,
  documentVatPercent?: number | null
): ReconciliationResult {
  const validatedGroups = validateRateGroups(rateGroups, extractedAmount);

  if (lineItems.length === 0) {
    return { lineItems: [], unreconciled: false, unreconciledRates: [], rateGroups: validatedGroups };
  }

  // Zero rows and header/summary text are noise; a NEGATIVE row is not — it
  // is a printed discount or credit line, and dropping it re-creates exactly
  // the mismatch this function exists to detect (#203): an itemisation a
  // person completed by adding the missing discount row must reconcile.
  const filtered = lineItems.filter((item) =>
    item.amount !== 0 && !isLikelyNonBillableLine(item.description)
  );
  const candidateLineItems = filtered.length > 0 ? filtered : lineItems;

  if (typeof extractedAmount !== "number" || !Number.isFinite(extractedAmount) || extractedAmount <= 0) {
    return {
      lineItems: candidateLineItems,
      unreconciled: false,
      unreconciledRates: [],
      rateGroups: validatedGroups,
    };
  }

  // Fork #137: the rows may be NET on a document whose total is gross. That
  // is not an extraction error — it is what an outgoing invoice prints — but
  // the rows have to be converted before anything downstream reads them.
  // Only attempted when the raw sum genuinely disagrees with the total, so a
  // document that already itemises gross is never touched.
  const rawSum = candidateLineItems.reduce((sum, item) => sum + item.amount, 0);
  if (
    Math.abs(rawSum - extractedAmount) > amountTolerance(extractedAmount) &&
    (!validatedGroups || validatedGroups.length === 0)
  ) {
    const grossedUp = grossUpNetLineItems(candidateLineItems, extractedAmount, documentVatPercent);
    if (grossedUp) {
      console.log(
        `[ExtractionCore] Line items were net (sum ${rawSum} against document total ` +
        `${extractedAmount}); converted to gross at the document's own rate.`
      );
      return {
        lineItems: grossedUp,
        unreconciled: false,
        unreconciledRates: [],
        rateGroups: null,
      };
    }
  }

  const consolidated = consolidateLineItems(candidateLineItems, extractedAmount);
  const mismatch = Math.abs(consolidated.totalAmount - extractedAmount);

  if (mismatch <= amountTolerance(extractedAmount)) {
    return {
      lineItems: candidateLineItems,
      unreconciled: false,
      unreconciledRates: [],
      rateGroups: validatedGroups,
    };
  }

  // Fork #67 (spec §6 item 2): before giving up on the whole document, try
  // to reconcile each printed rate group on its own. OCR noise lands in one
  // group; the per-group totals the receipt prints are §11-sufficient on
  // their own and can clear the groups the noise never touched.
  const perGroup = reconcilePerRateGroup(candidateLineItems, validatedGroups);
  if (perGroup) {
    if (perGroup.length === 0) {
      console.log(
        "[ExtractionCore] Document total missed by the global item sum but " +
        "every printed rate group reconciles — treating as reconciled."
      );
      return {
        lineItems: candidateLineItems,
        unreconciled: false,
        unreconciledRates: [],
        rateGroups: validatedGroups,
      };
    }
    console.warn(
      `[ExtractionCore] Line items mismatch document total by ${mismatch} cents; ` +
      `localised to rate group(s) ${perGroup.join(", ")}%. Keeping items and ` +
      "flagging only those rates."
    );
    return {
      lineItems: candidateLineItems,
      unreconciled: true,
      unreconciledRates: perGroup,
      rateGroups: validatedGroups,
    };
  }

  // Fork #64 (spec §6): keep the extracted items and flag the file instead
  // of destroying them with a single document-rate fallback line — the old
  // behavior collapsed exactly the multi-rate receipts the UVA calculation
  // needs. Downstream, an unreconciled file is never trusted for VAT
  // derivation (review bucket), but a human can repair one line instead of
  // re-keying the whole receipt.
  console.warn(
    `[ExtractionCore] Line items mismatch document total by ${mismatch} cents ` +
    `(lineItems=${consolidated.totalAmount}, extractedAmount=${extractedAmount}). ` +
    `Keeping items and flagging lineItemsUnreconciled.`
  );

  return {
    lineItems: candidateLineItems,
    unreconciled: true,
    unreconciledRates: [],
    rateGroups: validatedGroups,
  };
}

/**
 * Per-rate-group reconciliation, or null when the document does not
 * support it — no validated printed block, an item without a rate, or an
 * item at a rate the printed block never mentions. Those are structural
 * disagreements between the two readings of the document, not localised
 * OCR noise, so the caller falls back to flagging the whole document.
 *
 * Returns the failing rates; an empty array means every group reconciled.
 */
function reconcilePerRateGroup(
  lineItems: ExtractedLineItem[],
  validatedGroups: ExtractedRateGroup[] | null
): number[] | null {
  if (!validatedGroups || validatedGroups.length === 0) {
    return null;
  }
  if (lineItems.some((item) => item.vatPercent === null)) {
    return null;
  }

  const groupRates = new Set(validatedGroups.map((g) => g.rate));
  if (lineItems.some((item) => !groupRates.has(item.vatPercent as number))) {
    return null;
  }

  return validatedGroups
    .filter((group) => !rateGroupReconciles(
      group,
      lineItems.filter((item) => item.vatPercent === group.rate)
    ))
    .map((group) => group.rate);
}

/** Document-level totals implied by the printed VAT summary block. */
export function rateGroupTotals(groups: ExtractedRateGroup[]): {
  totalVatAmount: number;
  consolidatedVatPercent: number | null;
} {
  return {
    totalVatAmount: groups.reduce((sum, g) => sum + g.vat, 0),
    consolidatedVatPercent: groups.length === 1 ? groups[0].rate : null,
  };
}
