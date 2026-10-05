/**
 * Roll a Transaction back to the values an earlier edit replaced (#616).
 *
 * The chat assistant used to write the rollback itself, restoring whatever
 * keys the history entry held with no server rule at all. Now the entry's
 * previous values go through update_transaction: only the fields an edit may
 * write are restored (an entry naming any other field is refused whole),
 * they are validated as an edit would be, the Documentation State is
 * re-derived, and the rollback leaves its own history entry.
 */

import { createCallable } from "../utils/createCallable";
import { rollbackTransaction } from "../tools/handlers";
import { toolError } from "../tools/runToolCallable";

interface RollbackTransactionRequest {
  transactionId: string;
  historyId: string;
}

interface RollbackTransactionResponse {
  success: boolean;
  transactionId: string;
  restoredValues: Record<string, unknown>;
  historyId: string | null;
}

export const rollbackTransactionCallable = createCallable<
  RollbackTransactionRequest,
  RollbackTransactionResponse
>({ name: "rollbackTransaction" }, async (ctx, request) => {
  try {
    return await rollbackTransaction(ctx.userId, (request ?? {}) as unknown as Record<string, unknown>);
  } catch (err) {
    throw toolError(err);
  }
});
