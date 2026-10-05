/**
 * Reading a Hand Correction refusal (#639).
 *
 * A re-extraction of a File a person corrected by hand is refused by the
 * server, which alone decides which fields count as corrected. The refusal
 * carries them as structured details, `{ code: "HAND_CORRECTED", fields }`, on
 * the callable error (the Firebase SDK's FunctionsError and the self-host
 * client's both expose `details`). The browser holds no copy of the rule; it
 * only reads the answer.
 */

/** The corrected fields a Hand Correction refusal names, or null for any other error. */
export function handCorrectedFieldsOf(error: unknown): string[] | null {
  const details = (error as { details?: unknown } | null)?.details as
    | { code?: unknown; fields?: unknown }
    | null
    | undefined;
  if (!details || details.code !== "HAND_CORRECTED") return null;
  const fields = Array.isArray(details.fields) ? details.fields : [];
  return fields.filter((field): field is string => typeof field === "string");
}

/** What a bulk "Mark as invoice" did. */
export interface BulkMarkAsInvoiceResult {
  marked: number;
  /** Refused for a Hand Correction: left as they are, no override in bulk. */
  skipped: number;
  /** Any other error. */
  failed: number;
}

/**
 * Un-mark each File in turn. A File refused for its Hand Correction is
 * skipped and counted apart from a real failure, so the summary can tell the
 * person to open it rather than call it broken.
 */
export async function markFilesAsInvoice(
  fileIds: string[],
  unmark: (fileId: string) => Promise<void>,
  onEach?: () => void
): Promise<BulkMarkAsInvoiceResult> {
  const result: BulkMarkAsInvoiceResult = { marked: 0, skipped: 0, failed: 0 };
  for (const fileId of fileIds) {
    try {
      await unmark(fileId);
      result.marked++;
    } catch (error) {
      if (handCorrectedFieldsOf(error)) {
        result.skipped++;
      } else {
        console.error(`Failed to mark file ${fileId} as invoice:`, error);
        result.failed++;
      }
    }
    onEach?.();
  }
  return result;
}

type Translate = (key: string, values?: Record<string, number>) => string;

/**
 * The bulk summary, from `files.bulkMarkAsInvoice`: what was marked, what was
 * skipped for a Hand Correction, what failed. A part with nothing to say is
 * left out.
 */
export function bulkMarkAsInvoiceSummary(
  t: Translate,
  { marked, skipped, failed }: BulkMarkAsInvoiceResult
): { message: string; tone: "success" | "error" } {
  const parts = [t("marked", { count: marked })];
  if (skipped > 0) parts.push(t("skipped", { skipped }));
  if (failed > 0) parts.push(t("failed", { failed }));
  return { message: parts.join(" "), tone: failed > 0 ? "error" : "success" };
}
