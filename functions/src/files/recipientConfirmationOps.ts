/**
 * A human's ruling that the recipient on a document really is the user (#229).
 *
 * The identity comparison behind `recipientIdentityMatch` is a name, UID and
 * IBAN match, and names are the weakest of the three. A maiden name, a c/o
 * address, an employer's name on a hotel folio and plain OCR noise all produce
 * a recipient that does not match — and a rule that hard-refused those would
 * cost the user real deductions to catch the invoice that belongs to somebody
 * else. So the rule flags and this reverses the flag, the same shape as the
 * not-invoice and non-claimable marks.
 *
 * Nothing extracted is touched. The document still names whoever it names;
 * what changes is who we understand that to be. That is why this cannot be
 * expressed through `update_file_extraction`, which rewrites what the document
 * is taken to SAY, and why it survives re-extraction: the ruling is about the
 * user, not about the page.
 */

import { FieldValue } from "firebase-admin/firestore";

/**
 * Confirm the recipient is the user, lifting the § 12 block.
 *
 * `recipientConfirmedAsUser` is read by the documents adapter ahead of the
 * matcher's own verdict, so the file reclassifies as an ordinary invoice on
 * the next classification — which the caller runs in the same write.
 */
export function buildConfirmRecipientIsUserUpdates(): Record<string, unknown> {
  return {
    recipientConfirmedAsUser: true,
    recipientConfirmedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Withdraw the confirmation and let the matcher's verdict stand again.
 *
 * `false` rather than a deletion: a record that says a person looked and said
 * no is worth more than one that looks like it was never asked, and both read
 * the same way through `recipientConfirmedAsUser === true`.
 */
export function buildClearRecipientConfirmationUpdates(): Record<string, unknown> {
  return {
    recipientConfirmedAsUser: false,
    recipientConfirmedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}
