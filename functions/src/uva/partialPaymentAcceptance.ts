/**
 * Accepted Partial Payment (#554): the recorded ruling that a tipped
 * Transaction's bank line really is short of `document + tip`.
 *
 * Arithmetic alone cannot tell the two cases apart. A Beleg of 100,00 + 10,00
 * tip paid with 55,00 is either a mistyped tip or a split bill where the user
 * paid their half, and only the second one may be claimed at 50%. So the UVA
 * claims nothing on such a line and lists it as `tip-partial-payment`, and a
 * person rules: this shortfall is real. With a live ruling the line takes the
 * ordinary partial-payment path (R2), and the BMD Export scales the tip row
 * with it.
 *
 * Modelled on Accepted Receipt (#165): a ruling, never a hide. It records who
 * ruled, when, why, and over which figures, and it never deletes itself. It
 * goes STALE, derived on read, the moment the figures it ruled over change:
 * the set of connected Files, a File's total or tip, or the bank amount. The
 * line then returns to review, because the person ruled on numbers that are
 * no longer the ones on the record.
 *
 * Pure: no Firestore types on this surface, so the adapter, the callable, the
 * MCP tool and the UI can all read it.
 */

/** One connected File's figures, as the ruling saw them. Cents, as stored. */
export interface RuledFileFigures {
  id: string;
  /** `extractedAmount`, the document total. Null when the File had none. */
  total: number | null;
  /** `extractedTipAmount`. Null when the File carried no tip. */
  tip: number | null;
}

/** The figures a ruling is made over. */
export interface PartialPaymentFigures {
  /** The bank line, signed cents as on the Transaction. */
  bankAmount: number;
  /** Every connected File, in `fileIds` order. */
  files: RuledFileFigures[];
}

export interface PartialPaymentAcceptance extends PartialPaymentFigures {
  /** Who ruled - the user id the acting party authenticated as. */
  by: string;
  /**
   * When the ruling was made. Opaque here (admin Timestamp in Firestore,
   * client Timestamp in the UI): liveness never reads it.
   */
  at: unknown;
  /** Why the shortfall is real (a split bill, an instalment). Required - the reason IS the record. */
  reason: string;
}

/** The slice of a stored File the figures are read from. */
export interface RuledFileRecord {
  extractedAmount?: number | null;
  extractedTipAmount?: number | null;
}

/** The slice of a stored Transaction the figures and liveness read. */
export interface PartialPaymentSubject {
  amount: number;
  fileIds?: string[] | null;
  partialPaymentAcceptance?: PartialPaymentAcceptance | null;
}

/** A tip of zero and no tip are the same fact. */
function tipOf(f: RuledFileRecord | undefined): number | null {
  const tip = f?.extractedTipAmount ?? null;
  return tip !== null && tip > 0 ? tip : null;
}

/**
 * The figures a ruling made now would record. A File id that does not
 * resolve is kept, with no total and no tip, so it still counts towards the
 * set: a ruling over a File nobody could read is not a ruling over no File.
 * A File listed twice counts once, as liveness compares SETS: a ruling that
 * recorded it twice could never be live again.
 */
export function partialPaymentFigures(
  tx: Pick<PartialPaymentSubject, "amount" | "fileIds">,
  filesById: ReadonlyMap<string, RuledFileRecord>
): PartialPaymentFigures {
  return {
    bankAmount: tx.amount,
    files: [...new Set(tx.fileIds ?? [])].map((id) => {
      const f = filesById.get(id);
      return { id, total: f?.extractedAmount ?? null, tip: tipOf(f) };
    }),
  };
}

/**
 * Is the recorded ruling still about the figures the Transaction holds?
 *
 * Live exactly while the bank amount, the SET of connected Files, and each
 * File's total and tip are what the ruling named. Anything else makes it
 * stale: it stays on the record as history, but it no longer lets the line
 * take the partial-payment path.
 */
export function isPartialPaymentAcceptanceLive(
  tx: PartialPaymentSubject,
  filesById: ReadonlyMap<string, RuledFileRecord>
): boolean {
  const ruling = tx.partialPaymentAcceptance;
  if (!ruling) return false;
  if (ruling.bankAmount !== tx.amount) return false;

  const now = partialPaymentFigures(tx, filesById).files;
  const ruled = ruling.files ?? [];
  if (now.length !== ruled.length) return false;

  const ruledById = new Map(ruled.map((f) => [f.id, f]));
  if (ruledById.size !== ruled.length) return false;
  return now.every((f) => {
    const then = ruledById.get(f.id);
    return (
      then !== undefined &&
      (then.total ?? null) === f.total &&
      (then.tip ?? null) === f.tip
    );
  });
}
