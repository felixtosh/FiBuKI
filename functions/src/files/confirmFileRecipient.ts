/**
 * Rule from the File panel that the recipient printed on a document is the
 * User (#229): a maiden name, a c/o address, a misread line. Lifts the § 12
 * block, so the File's VAT counts again and matching runs for it.
 *
 * A delegation, like setPartnerBillingCycle: `confirm_file_recipient_is_user`
 * already owns the ruling, the reclassification and the re-match, so a ruling
 * made in the panel and one made by an AI client cannot differ.
 */

import { createCallable, HttpsError } from "../utils/createCallable";

interface ConfirmFileRecipientRequest {
  fileId: string;
}

interface ConfirmFileRecipientResponse {
  success: boolean;
  fileId: string;
  recipientConfirmedAsUser: boolean;
}

export const confirmFileRecipientIsUserCallable = createCallable<
  ConfirmFileRecipientRequest,
  ConfirmFileRecipientResponse
>(
  { name: "confirmFileRecipientIsUser" },
  async (ctx, request) => {
    if (!request?.fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    // Imported lazily: `handlers.ts` takes a Firestore handle at module scope.
    const { confirmFileRecipientIsUser } = await import("../tools/handlers");

    try {
      const result = await confirmFileRecipientIsUser(ctx.userId, { fileId: request.fileId });
      return result as ConfirmFileRecipientResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpsError(message === "File not found" ? "not-found" : "invalid-argument", message);
    }
  }
);
