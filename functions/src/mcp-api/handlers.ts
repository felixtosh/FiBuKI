/**
 * Shared tool handlers for MCP API
 *
 * Used by both REST API (mcpApi) and MCP protocol (mcpSse)
 */

import { getFirestore, FieldValue } from "firebase-admin/firestore";

const db = getFirestore();

export async function handleToolInternal(
  userId: string,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (tool) {
    case "list_sources":
      return handleListSources(userId);
    case "get_source":
      return handleGetSource(userId, args.sourceId as string);
    case "list_transactions":
      return handleListTransactions(userId, args);
    case "get_transaction":
      return handleGetTransaction(userId, args.transactionId as string);
    case "update_transaction":
      return handleUpdateTransaction(userId, args);
    case "list_files":
      return handleListFiles(userId, args);
    case "get_file":
      return handleGetFile(userId, args.fileId as string);
    case "connect_file_to_transaction":
      return handleConnectFile(userId, args);
    case "disconnect_file_from_transaction":
      return handleDisconnectFile(userId, args);
    case "list_transactions_needing_files":
      return handleListTransactionsNeedingFiles(userId, args);
    case "auto_connect_file_suggestions":
      return handleAutoConnectSuggestions(userId, args);
    case "list_no_receipt_categories":
      return handleListCategories(userId);
    case "assign_no_receipt_category":
      return handleAssignCategory(userId, args);
    case "remove_no_receipt_category":
      return handleRemoveCategory(userId, args.transactionId as string);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

async function handleListSources(userId: string) {
  const snapshot = await db
    .collection("sources")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .orderBy("name", "asc")
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function handleGetSource(userId: string, sourceId: string) {
  if (!sourceId) throw new Error("sourceId is required");

  const doc = await db.collection("sources").doc(sourceId).get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("Source not found");
  }
  return { id: doc.id, ...doc.data() };
}

async function handleListTransactions(userId: string, args: Record<string, unknown>) {
  let query = db
    .collection("transactions")
    .where("userId", "==", userId)
    .orderBy("date", "desc");

  if (args.sourceId) {
    query = query.where("sourceId", "==", args.sourceId);
  }
  if (args.isComplete !== undefined) {
    query = query.where("isComplete", "==", args.isComplete);
  }

  const limit = Math.min((args.limit as number) || 50, 100);
  query = query.limit(limit);

  const snapshot = await query.get();
  let transactions = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      date: data.date?.toDate?.()?.toISOString() || data.date,
      amountFormatted: `${((data.amount || 0) / 100).toFixed(2)} ${data.currency || "EUR"}`,
    } as Record<string, unknown>;
  });

  if (args.dateFrom) {
    const from = new Date(args.dateFrom as string);
    transactions = transactions.filter((t) => new Date(t.date as string) >= from);
  }
  if (args.dateTo) {
    const to = new Date(args.dateTo as string);
    transactions = transactions.filter((t) => new Date(t.date as string) <= to);
  }
  if (args.search) {
    const search = (args.search as string).toLowerCase();
    transactions = transactions.filter(
      (t) =>
        (t.name as string | undefined)?.toLowerCase().includes(search) ||
        (t.description as string | undefined)?.toLowerCase().includes(search) ||
        (t.partner as string | undefined)?.toLowerCase().includes(search)
    );
  }

  return transactions;
}

async function handleGetTransaction(userId: string, transactionId: string) {
  if (!transactionId) throw new Error("transactionId is required");

  const doc = await db.collection("transactions").doc(transactionId).get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  const data = doc.data()!;
  return {
    id: doc.id,
    ...data,
    date: data.date?.toDate?.()?.toISOString() || data.date,
    amountFormatted: `${((data.amount || 0) / 100).toFixed(2)} ${data.currency || "EUR"}`,
  };
}

async function handleUpdateTransaction(userId: string, args: Record<string, unknown>) {
  const { transactionId, description, isComplete } = args;
  if (!transactionId) throw new Error("transactionId is required");

  const docRef = db.collection("transactions").doc(transactionId as string);
  const doc = await docRef.get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (description !== undefined) updates.description = description;
  if (isComplete !== undefined) updates.isComplete = isComplete;

  await docRef.update(updates);
  return { success: true, transactionId };
}

async function handleListFiles(userId: string, args: Record<string, unknown>) {
  let query = db.collection("files").where("userId", "==", userId).orderBy("uploadedAt", "desc");

  const limit = Math.min((args.limit as number) || 50, 100);
  query = query.limit(limit);

  const snapshot = await query.get();
  let files = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((f: Record<string, unknown>) => !f.deletedAt && !f.isNotInvoice);

  if (args.hasConnections !== undefined) {
    files = files.filter((f: Record<string, unknown>) =>
      args.hasConnections
        ? ((f.transactionIds as string[])?.length || 0) > 0
        : ((f.transactionIds as string[])?.length || 0) === 0
    );
  }

  if (args.hasSuggestions !== undefined) {
    files = files.filter((f: Record<string, unknown>) =>
      args.hasSuggestions
        ? ((f.transactionSuggestions as unknown[])?.length || 0) > 0
        : ((f.transactionSuggestions as unknown[])?.length || 0) === 0
    );
  }

  return files;
}

async function handleGetFile(userId: string, fileId: string) {
  if (!fileId) throw new Error("fileId is required");

  const doc = await db.collection("files").doc(fileId).get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("File not found");
  }
  return { id: doc.id, ...doc.data() };
}

async function handleConnectFile(userId: string, args: Record<string, unknown>) {
  const { fileId, transactionId } = args;
  if (!fileId || !transactionId) {
    throw new Error("fileId and transactionId are required");
  }

  const [fileDoc, txDoc] = await Promise.all([
    db.collection("files").doc(fileId as string).get(),
    db.collection("transactions").doc(transactionId as string).get(),
  ]);

  if (!fileDoc.exists || fileDoc.data()?.userId !== userId) {
    throw new Error("File not found");
  }
  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  const connRef = db.collection("fileConnections").doc();
  batch.set(connRef, {
    fileId,
    transactionId,
    userId,
    connectionType: "api",
    createdAt: now,
  });

  batch.update(fileDoc.ref, {
    transactionIds: FieldValue.arrayUnion(transactionId),
    updatedAt: now,
  });

  batch.update(txDoc.ref, {
    fileIds: FieldValue.arrayUnion(fileId),
    isComplete: true,
    updatedAt: now,
  });

  await batch.commit();
  return { success: true, fileId, transactionId };
}

async function handleDisconnectFile(userId: string, args: Record<string, unknown>) {
  const { fileId, transactionId } = args;
  if (!fileId || !transactionId) {
    throw new Error("fileId and transactionId are required");
  }

  const connSnapshot = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("transactionId", "==", transactionId)
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (connSnapshot.empty) {
    throw new Error("Connection not found");
  }

  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  batch.delete(connSnapshot.docs[0].ref);

  batch.update(db.collection("files").doc(fileId as string), {
    transactionIds: FieldValue.arrayRemove(transactionId),
    updatedAt: now,
  });

  batch.update(db.collection("transactions").doc(transactionId as string), {
    fileIds: FieldValue.arrayRemove(fileId),
    updatedAt: now,
  });

  await batch.commit();
  return { success: true, fileId, transactionId };
}

async function handleListTransactionsNeedingFiles(userId: string, args: Record<string, unknown>) {
  let query = db.collection("transactions").where("userId", "==", userId).orderBy("date", "desc");

  const limit = Math.min((args.limit as number) || 50, 100);
  query = query.limit(500);

  const snapshot = await query.get();
  let transactions = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() } as Record<string, unknown>))
    .filter(
      (t) =>
        (!(t.fileIds as string[]) || (t.fileIds as string[]).length === 0) && !t.noReceiptCategoryId
    );

  if (args.minAmount !== undefined) {
    const minAmount = args.minAmount as number;
    transactions = transactions.filter((t) => Math.abs((t.amount as number) || 0) >= minAmount);
  }

  return transactions.slice(0, limit);
}

async function handleAutoConnectSuggestions(userId: string, args: Record<string, unknown>) {
  const minConfidence = (args.minConfidence as number) || 89;
  const fileId = args.fileId as string | undefined;

  let files: Record<string, unknown>[];

  if (fileId) {
    const doc = await db.collection("files").doc(fileId).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
      throw new Error("File not found");
    }
    files = [{ id: doc.id, ...doc.data() }];
  } else {
    const snapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("transactionMatchComplete", "==", true)
      .get();

    files = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter(
        (f: Record<string, unknown>) =>
          !f.deletedAt &&
          !f.isNotInvoice &&
          (!(f.transactionIds as string[]) || (f.transactionIds as string[]).length === 0) &&
          (f.transactionSuggestions as Array<{ confidence: number }>)?.some(
            (s) => s.confidence >= minConfidence
          )
      );
  }

  const result = { connected: 0, skipped: 0, connections: [] as Record<string, unknown>[] };

  for (const file of files) {
    if ((file.transactionIds as string[])?.length > 0) {
      result.skipped++;
      continue;
    }

    const suggestions = file.transactionSuggestions as Array<{
      transactionId: string;
      confidence: number;
    }>;
    const bestSuggestion = suggestions
      ?.filter((s) => s.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)[0];

    if (!bestSuggestion) {
      result.skipped++;
      continue;
    }

    try {
      await handleConnectFile(userId, {
        fileId: file.id,
        transactionId: bestSuggestion.transactionId,
      });
      result.connected++;
      result.connections.push({
        fileId: file.id,
        transactionId: bestSuggestion.transactionId,
        confidence: bestSuggestion.confidence,
      });
    } catch {
      result.skipped++;
    }
  }

  return result;
}

async function handleListCategories(userId: string) {
  const snapshot = await db
    .collection("noReceiptCategories")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .orderBy("name", "asc")
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function handleAssignCategory(userId: string, args: Record<string, unknown>) {
  const { transactionId, categoryId } = args;
  if (!transactionId || !categoryId) {
    throw new Error("transactionId and categoryId are required");
  }

  const [txDoc, catDoc] = await Promise.all([
    db.collection("transactions").doc(transactionId as string).get(),
    db.collection("noReceiptCategories").doc(categoryId as string).get(),
  ]);

  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }
  if (!catDoc.exists || catDoc.data()?.userId !== userId) {
    throw new Error("Category not found");
  }

  const catData = catDoc.data()!;
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  batch.update(txDoc.ref, {
    noReceiptCategoryId: categoryId,
    noReceiptCategoryTemplateId: catData.templateId,
    noReceiptCategoryMatchedBy: "api",
    isComplete: true,
    updatedAt: now,
  });

  batch.update(catDoc.ref, {
    transactionCount: FieldValue.increment(1),
    updatedAt: now,
  });

  await batch.commit();
  return { success: true, transactionId, categoryId, categoryName: catData.name };
}

async function handleRemoveCategory(userId: string, transactionId: string) {
  if (!transactionId) throw new Error("transactionId is required");

  const txDoc = await db.collection("transactions").doc(transactionId).get();
  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  const txData = txDoc.data()!;
  const categoryId = txData.noReceiptCategoryId;
  if (!categoryId) {
    throw new Error("Transaction has no category assigned");
  }

  const hasFiles = txData.fileIds && txData.fileIds.length > 0;
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  batch.update(txDoc.ref, {
    noReceiptCategoryId: null,
    noReceiptCategoryTemplateId: null,
    noReceiptCategoryMatchedBy: null,
    isComplete: hasFiles,
    updatedAt: now,
  });

  batch.update(db.collection("noReceiptCategories").doc(categoryId), {
    transactionCount: FieldValue.increment(-1),
    updatedAt: now,
  });

  await batch.commit();
  return { success: true, transactionId, isComplete: hasFiles };
}
