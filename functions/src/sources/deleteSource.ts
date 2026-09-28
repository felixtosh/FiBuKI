/**
 * Delete a source and all associated imports/transactions (cascade delete)
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface DeleteSourceRequest {
  sourceId: string;
}

interface DeleteSourceResponse {
  success: boolean;
  deletedImports: number;
  deletedTransactions: number;
  deletedTrades?: number;
}

const BATCH_SIZE = 500;

/**
 * Whether any of the user's records still point at a Partner: the pointers a
 * Partner Merge repoints (`mergeUserPartners.ts`), plus Merged Partners whose
 * `mergedInto` names it.
 */
async function isPartnerReferenced(
  dbRef: FirebaseFirestore.Firestore,
  userId: string,
  partnerId: string
): Promise<boolean> {
  const pointers: Array<[string, string]> = [
    ["transactions", "partnerId"],
    ["files", "partnerId"],
    ["invoiceFetchQueue", "partnerId"],
    ["invoices", "recipient.partnerId"],
    ["partners", "mergedInto"],
  ];
  for (const [collection, field] of pointers) {
    const snapshot = await dbRef
      .collection(collection)
      .where("userId", "==", userId)
      .where(field, "==", partnerId)
      .limit(1)
      .get();
    if (!snapshot.empty) return true;
  }
  return false;
}

/**
 * Internal implementation for deleting a source.
 * Can be called directly from MCP handlers.
 */
export async function deleteSourceInternal(
  dbRef: FirebaseFirestore.Firestore,
  userId: string,
  sourceId: string
): Promise<DeleteSourceResponse> {
  if (!sourceId) {
    throw new HttpsError("invalid-argument", "sourceId is required");
  }

  // Verify ownership
  const sourceRef = dbRef.collection("sources").doc(sourceId);
  const sourceSnap = await sourceRef.get();

  if (!sourceSnap.exists) {
    throw new HttpsError("not-found", "Source not found");
  }

  const sourceData = sourceSnap.data()!;
  if (sourceData.userId !== userId) {
    throw new HttpsError("permission-denied", "Access denied");
  }

  const now = Timestamp.now();
  let deletedImports = 0;
  let deletedTransactions = 0;
  let deletedTrades = 0;

  // 1. Clear linkedSourceId on any credit cards that link to this bank account
  const linkedCardsQuery = await dbRef
    .collection("sources")
    .where("userId", "==", userId)
    .where("linkedSourceId", "==", sourceId)
    .get();

  if (!linkedCardsQuery.empty) {
    const batch = dbRef.batch();
    for (const cardDoc of linkedCardsQuery.docs) {
      batch.update(cardDoc.ref, {
        linkedSourceId: null,
        updatedAt: now,
      });
    }
    await batch.commit();
  }

  // 2. Delete all imports for this source
  const importsQuery = await dbRef
    .collection("imports")
    .where("userId", "==", userId)
    .where("sourceId", "==", sourceId)
    .get();

  if (!importsQuery.empty) {
    for (let i = 0; i < importsQuery.docs.length; i += BATCH_SIZE) {
      const batch = dbRef.batch();
      const chunk = importsQuery.docs.slice(i, i + BATCH_SIZE);

      for (const importDoc of chunk) {
        batch.delete(importDoc.ref);
        deletedImports++;
      }

      await batch.commit();
    }
  }

  // 3. Delete all transactions for this source
  const transactionsQuery = await dbRef
    .collection("transactions")
    .where("userId", "==", userId)
    .where("sourceId", "==", sourceId)
    .get();

  if (!transactionsQuery.empty) {
    for (let i = 0; i < transactionsQuery.docs.length; i += BATCH_SIZE) {
      const chunk = transactionsQuery.docs.slice(i, i + BATCH_SIZE);

      // First, delete file connections for each transaction
      for (const txDoc of chunk) {
        const connectionsQuery = await dbRef
          .collection("fileConnections")
          .where("transactionId", "==", txDoc.id)
          .get();

        if (!connectionsQuery.empty) {
          const connBatch = dbRef.batch();
          for (const connDoc of connectionsQuery.docs) {
            connBatch.delete(connDoc.ref);

            // Update file to remove transaction from transactionIds
            const fileRef = dbRef.collection("files").doc(connDoc.data().fileId);
            connBatch.update(fileRef, {
              transactionIds: FieldValue.arrayRemove(txDoc.id),
              updatedAt: now,
            });
          }
          await connBatch.commit();
        }
      }

      // Then delete the transactions
      const txBatch = dbRef.batch();
      for (const txDoc of chunk) {
        txBatch.delete(txDoc.ref);
        deletedTransactions++;
      }
      await txBatch.commit();
    }
  }

  // 4. Clean up API provider connections if this was an API source
  if (sourceData.type === "api" && sourceData.apiConfig) {
    const apiConfig = sourceData.apiConfig as {
      provider?: string;
      connectionId?: string;
      bankConnectionId?: number;
      userAccessToken?: string;
    };

    if (apiConfig.provider === "truelayer" && apiConfig.connectionId) {
      try {
        const connectionRef = dbRef.collection("truelayerConnections").doc(apiConfig.connectionId);
        await connectionRef.delete();
      } catch (err) {
        console.warn(`[deleteSource] Failed to delete TrueLayer connection:`, err);
      }
    }

    // Delete finAPI bank connection
    if (apiConfig.provider === "finapi" && apiConfig.bankConnectionId) {
      try {
        const clientId = process.env.FINAPI_CLIENT_ID;
        const clientSecret = process.env.FINAPI_CLIENT_SECRET;
        const environment = process.env.FINAPI_ENVIRONMENT || "sandbox";
        const baseUrl = environment === "production"
          ? "https://live.finapi.io"
          : "https://sandbox.finapi.io";

        if (clientId && clientSecret) {
          let accessToken = apiConfig.userAccessToken as string | undefined;
          const refreshToken = (sourceData.apiConfig as { userRefreshToken?: string }).userRefreshToken;

          // Try to refresh the token first if we have a refresh token
          if (refreshToken) {
            try {
              const tokenResponse = await fetch(`${baseUrl}/api/v2/oauth/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  grant_type: "refresh_token",
                  client_id: clientId,
                  client_secret: clientSecret,
                  refresh_token: refreshToken,
                }).toString(),
              });

              if (tokenResponse.ok) {
                const tokenData = await tokenResponse.json() as { access_token: string };
                accessToken = tokenData.access_token;
                console.log(`[deleteSource] Refreshed finAPI token for bank connection delete`);
              }
            } catch (refreshErr) {
              console.warn(`[deleteSource] Failed to refresh finAPI token:`, refreshErr);
            }
          }

          if (accessToken) {
            const response = await fetch(
              `${baseUrl}/api/v2/bankConnections/${apiConfig.bankConnectionId}`,
              {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              }
            );
            if (response.ok) {
              console.log(`[deleteSource] Deleted finAPI bank connection: ${apiConfig.bankConnectionId}`);
            } else {
              const errorText = await response.text();
              console.warn(`[deleteSource] finAPI delete returned ${response.status}: ${errorText}`);
            }
          } else {
            console.warn(`[deleteSource] No access token available to delete finAPI connection`);
          }
        }
      } catch (err) {
        console.warn(`[deleteSource] Failed to delete finAPI connection:`, err);
      }
    }
  }

  // 5. Delete investment trades for depot sources
  if (sourceData.accountKind === "depot") {
    const tradesQuery = await dbRef
      .collection("investmentTrades")
      .where("userId", "==", userId)
      .where("sourceId", "==", sourceId)
      .get();

    if (!tradesQuery.empty) {
      for (let i = 0; i < tradesQuery.docs.length; i += BATCH_SIZE) {
        const tradeBatch = dbRef.batch();
        const chunk = tradesQuery.docs.slice(i, i + BATCH_SIZE);
        for (const tradeDoc of chunk) {
          tradeBatch.delete(tradeDoc.ref);
          deletedTrades++;
        }
        await tradeBatch.commit();
      }
    }

    if (deletedTrades > 0) {
      console.log(`[deleteSource] Deleted ${deletedTrades} investment trades for depot ${sourceId}`);
    }
  }

  // 6. Delete the source partner, unless records from elsewhere point at it.
  // This source's own Transactions are gone by now, so anything still naming
  // the Partner came from somewhere else: a bank Transaction reconciliation
  // assigned it, a File, an Invoice, or a Merged Partner from an earlier merge
  // (#410). Those keep their Partner; it only loses the source marker, which
  // named a source that no longer exists.
  if (sourceData.sourcePartnerId) {
    const sourcePartnerId = sourceData.sourcePartnerId as string;
    try {
      const partnerRef = dbRef.collection("partners").doc(sourcePartnerId);
      const partnerSnap = await partnerRef.get();
      if (partnerSnap.exists && partnerSnap.data()?.userId === userId) {
        if (await isPartnerReferenced(dbRef, userId, sourcePartnerId)) {
          await partnerRef.update({
            identitySourceField: FieldValue.delete(),
            updatedAt: now,
          });
          console.log(
            `[deleteSource] Kept source partner ${sourcePartnerId}: records outside the source point at it`
          );
        } else {
          await partnerRef.delete();
          console.log(`[deleteSource] Deleted source partner ${sourcePartnerId}`);
        }
      }
    } catch (err) {
      console.warn(`[deleteSource] Failed to delete source partner:`, err);
    }
  }

  // 7. Delete the source document itself
  await sourceRef.delete();

  console.log(`[deleteSource] Deleted source ${sourceId}`, {
    userId,
    deletedImports,
    deletedTransactions,
  });

  return {
    success: true,
    deletedImports,
    deletedTransactions,
    deletedTrades,
  };
}

export const deleteSourceCallable = createCallable<
  DeleteSourceRequest,
  DeleteSourceResponse
>(
  {
    name: "deleteSource",
    timeoutSeconds: 300,
    memory: "1GiB",
  },
  async (ctx, request) => {
    return deleteSourceInternal(ctx.db, ctx.userId, request.sourceId);
  }
);
