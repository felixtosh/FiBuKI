/**
 * File Cloud Functions
 *
 * All file mutations go through these callable functions.
 * Realtime listeners (onSnapshot) stay client-side in hooks.
 */

export { createFileCallable } from "./createFile";
export { updateFileCallable } from "./updateFile";
export { deleteFileCallable } from "./deleteFile";
export { restoreFileCallable } from "./restoreFile";
export { markFileAsNotInvoiceCallable } from "./markFileAsNotInvoice";
export { unmarkFileAsNotInvoiceCallable } from "./unmarkFileAsNotInvoice";
export { connectFileToTransactionCallable } from "./connectFileToTransaction";
export { disconnectFileFromTransactionCallable } from "./disconnectFileFromTransaction";
export { dismissTransactionSuggestionCallable } from "./dismissTransactionSuggestion";
export { undismissTransactionSuggestionCallable } from "./undismissTransactionSuggestion";
export { unrejectFileFromTransactionCallable } from "./unrejectFileFromTransaction";
