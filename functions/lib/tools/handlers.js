"use strict";
/**
 * Server-Side Tool Registry
 *
 * Single source of truth for all MCP/API tool handlers.
 * Used by:
 * - HTTP API (mcpApi) - external AI tools
 * - MCP SSE (mcpSse) - Anthropic Claude
 *
 * Note: Chat assistant (lib/agent/tools/) has its own implementation
 * for performance (direct Admin SDK reads). Writes are already unified
 * via Cloud Function callables.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_NAMES = void 0;
exports.handleTool = handleTool;
exports.listSources = listSources;
exports.getSource = getSource;
exports.listTransactions = listTransactions;
exports.getTransaction = getTransaction;
exports.updateTransaction = updateTransaction;
exports.listTransactionsNeedingFiles = listTransactionsNeedingFiles;
exports.listFiles = listFiles;
exports.getFile = getFile;
exports.connectFileToTransaction = connectFileToTransaction;
exports.disconnectFileFromTransaction = disconnectFileFromTransaction;
exports.autoConnectFileSuggestions = autoConnectFileSuggestions;
exports.listNoReceiptCategories = listNoReceiptCategories;
exports.assignNoReceiptCategory = assignNoReceiptCategory;
exports.removeNoReceiptCategory = removeNoReceiptCategory;
const firestore_1 = require("firebase-admin/firestore");
const db = (0, firestore_1.getFirestore)();
exports.TOOL_NAMES = [
    "list_sources",
    "get_source",
    "list_transactions",
    "get_transaction",
    "update_transaction",
    "list_files",
    "get_file",
    "connect_file_to_transaction",
    "disconnect_file_from_transaction",
    "list_transactions_needing_files",
    "auto_connect_file_suggestions",
    "list_no_receipt_categories",
    "assign_no_receipt_category",
    "remove_no_receipt_category",
];
/**
 * Main tool dispatcher - routes tool calls to handlers
 */
async function handleTool(userId, tool, args = {}) {
    switch (tool) {
        case "list_sources":
            return listSources(userId);
        case "get_source":
            return getSource(userId, args.sourceId);
        case "list_transactions":
            return listTransactions(userId, args);
        case "get_transaction":
            return getTransaction(userId, args.transactionId);
        case "update_transaction":
            return updateTransaction(userId, args);
        case "list_files":
            return listFiles(userId, args);
        case "get_file":
            return getFile(userId, args.fileId);
        case "connect_file_to_transaction":
            return connectFileToTransaction(userId, args);
        case "disconnect_file_from_transaction":
            return disconnectFileFromTransaction(userId, args);
        case "list_transactions_needing_files":
            return listTransactionsNeedingFiles(userId, args);
        case "auto_connect_file_suggestions":
            return autoConnectFileSuggestions(userId, args);
        case "list_no_receipt_categories":
            return listNoReceiptCategories(userId);
        case "assign_no_receipt_category":
            return assignNoReceiptCategory(userId, args);
        case "remove_no_receipt_category":
            return removeNoReceiptCategory(userId, args.transactionId);
        default:
            throw new Error(`Unknown tool: ${tool}`);
    }
}
// ============================================================================
// Sources
// ============================================================================
async function listSources(userId) {
    const snapshot = await db
        .collection("sources")
        .where("userId", "==", userId)
        .where("isActive", "==", true)
        .orderBy("name", "asc")
        .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
async function getSource(userId, sourceId) {
    if (!sourceId)
        throw new Error("sourceId is required");
    const doc = await db.collection("sources").doc(sourceId).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
        throw new Error("Source not found");
    }
    return { id: doc.id, ...doc.data() };
}
// ============================================================================
// Transactions
// ============================================================================
async function listTransactions(userId, args) {
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
    const limit = Math.min(args.limit || 50, 100);
    query = query.limit(limit);
    const snapshot = await query.get();
    let transactions = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
            date: data.date?.toDate?.()?.toISOString() || data.date,
            amountFormatted: `${((data.amount || 0) / 100).toFixed(2)} ${data.currency || "EUR"}`,
        };
    });
    // Client-side filters (for fields not indexed together)
    if (args.dateFrom) {
        const from = new Date(args.dateFrom);
        transactions = transactions.filter((t) => new Date(t.date) >= from);
    }
    if (args.dateTo) {
        const to = new Date(args.dateTo);
        transactions = transactions.filter((t) => new Date(t.date) <= to);
    }
    if (args.search) {
        const search = args.search.toLowerCase();
        transactions = transactions.filter((t) => t.name?.toLowerCase().includes(search) ||
            t.description?.toLowerCase().includes(search) ||
            t.partner?.toLowerCase().includes(search));
    }
    return transactions;
}
async function getTransaction(userId, transactionId) {
    if (!transactionId)
        throw new Error("transactionId is required");
    const doc = await db.collection("transactions").doc(transactionId).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
        throw new Error("Transaction not found");
    }
    const data = doc.data();
    return {
        id: doc.id,
        ...data,
        date: data.date?.toDate?.()?.toISOString() || data.date,
        amountFormatted: `${((data.amount || 0) / 100).toFixed(2)} ${data.currency || "EUR"}`,
    };
}
async function updateTransaction(userId, args) {
    const { transactionId, description, isComplete } = args;
    if (!transactionId)
        throw new Error("transactionId is required");
    const docRef = db.collection("transactions").doc(transactionId);
    const doc = await docRef.get();
    if (!doc.exists || doc.data()?.userId !== userId) {
        throw new Error("Transaction not found");
    }
    const updates = { updatedAt: firestore_1.FieldValue.serverTimestamp() };
    if (description !== undefined)
        updates.description = description;
    if (isComplete !== undefined)
        updates.isComplete = isComplete;
    await docRef.update(updates);
    return { success: true, transactionId };
}
async function listTransactionsNeedingFiles(userId, args) {
    let query = db.collection("transactions").where("userId", "==", userId).orderBy("date", "desc");
    const limit = Math.min(args.limit || 50, 100);
    query = query.limit(500); // Fetch more to filter
    const snapshot = await query.get();
    let transactions = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((t) => (!t.fileIds || t.fileIds.length === 0) && !t.noReceiptCategoryId && !t.quotaExceeded);
    if (args.minAmount !== undefined) {
        const minAmount = args.minAmount;
        transactions = transactions.filter((t) => Math.abs(t.amount || 0) >= minAmount);
    }
    return transactions.slice(0, limit);
}
// ============================================================================
// Files
// ============================================================================
async function listFiles(userId, args) {
    let query = db.collection("files").where("userId", "==", userId).orderBy("uploadedAt", "desc");
    const limit = Math.min(args.limit || 50, 100);
    query = query.limit(limit);
    const snapshot = await query.get();
    let files = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((f) => !f.deletedAt && !f.isNotInvoice);
    if (args.hasConnections !== undefined) {
        files = files.filter((f) => args.hasConnections
            ? (f.transactionIds?.length || 0) > 0
            : (f.transactionIds?.length || 0) === 0);
    }
    if (args.hasSuggestions !== undefined) {
        files = files.filter((f) => args.hasSuggestions
            ? (f.transactionSuggestions?.length || 0) > 0
            : (f.transactionSuggestions?.length || 0) === 0);
    }
    return files;
}
async function getFile(userId, fileId) {
    if (!fileId)
        throw new Error("fileId is required");
    const doc = await db.collection("files").doc(fileId).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
        throw new Error("File not found");
    }
    return { id: doc.id, ...doc.data() };
}
async function connectFileToTransaction(userId, args) {
    const { fileId, transactionId } = args;
    if (!fileId || !transactionId) {
        throw new Error("fileId and transactionId are required");
    }
    const [fileDoc, txDoc] = await Promise.all([
        db.collection("files").doc(fileId).get(),
        db.collection("transactions").doc(transactionId).get(),
    ]);
    if (!fileDoc.exists || fileDoc.data()?.userId !== userId) {
        throw new Error("File not found");
    }
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
        throw new Error("Transaction not found");
    }
    if (txDoc.data()?.quotaExceeded) {
        throw new Error("Cannot connect files to over-quota transactions via API");
    }
    const batch = db.batch();
    const now = firestore_1.FieldValue.serverTimestamp();
    const connRef = db.collection("fileConnections").doc();
    batch.set(connRef, {
        fileId,
        transactionId,
        userId,
        connectionType: "api",
        createdAt: now,
    });
    batch.update(fileDoc.ref, {
        transactionIds: firestore_1.FieldValue.arrayUnion(transactionId),
        updatedAt: now,
    });
    batch.update(txDoc.ref, {
        fileIds: firestore_1.FieldValue.arrayUnion(fileId),
        isComplete: true,
        updatedAt: now,
    });
    await batch.commit();
    return { success: true, fileId, transactionId };
}
async function disconnectFileFromTransaction(userId, args) {
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
    const now = firestore_1.FieldValue.serverTimestamp();
    batch.delete(connSnapshot.docs[0].ref);
    batch.update(db.collection("files").doc(fileId), {
        transactionIds: firestore_1.FieldValue.arrayRemove(transactionId),
        updatedAt: now,
    });
    batch.update(db.collection("transactions").doc(transactionId), {
        fileIds: firestore_1.FieldValue.arrayRemove(fileId),
        updatedAt: now,
    });
    await batch.commit();
    return { success: true, fileId, transactionId };
}
async function autoConnectFileSuggestions(userId, args) {
    const minConfidence = args.minConfidence || 89;
    const fileId = args.fileId;
    let files;
    if (fileId) {
        const doc = await db.collection("files").doc(fileId).get();
        if (!doc.exists || doc.data()?.userId !== userId) {
            throw new Error("File not found");
        }
        files = [{ id: doc.id, ...doc.data() }];
    }
    else {
        const snapshot = await db
            .collection("files")
            .where("userId", "==", userId)
            .where("transactionMatchComplete", "==", true)
            .get();
        files = snapshot.docs
            .map((doc) => ({ id: doc.id, ...doc.data() }))
            .filter((f) => !f.deletedAt &&
            !f.isNotInvoice &&
            (!f.transactionIds || f.transactionIds.length === 0) &&
            f.transactionSuggestions?.some((s) => s.confidence >= minConfidence));
    }
    const result = { connected: 0, skipped: 0, connections: [] };
    for (const file of files) {
        if (file.transactionIds?.length > 0) {
            result.skipped++;
            continue;
        }
        const suggestions = file.transactionSuggestions;
        const bestSuggestion = suggestions
            ?.filter((s) => s.confidence >= minConfidence)
            .sort((a, b) => b.confidence - a.confidence)[0];
        if (!bestSuggestion) {
            result.skipped++;
            continue;
        }
        try {
            await connectFileToTransaction(userId, {
                fileId: file.id,
                transactionId: bestSuggestion.transactionId,
            });
            result.connected++;
            result.connections.push({
                fileId: file.id,
                transactionId: bestSuggestion.transactionId,
                confidence: bestSuggestion.confidence,
            });
        }
        catch {
            result.skipped++;
        }
    }
    return result;
}
// ============================================================================
// Categories
// ============================================================================
async function listNoReceiptCategories(userId) {
    const snapshot = await db
        .collection("noReceiptCategories")
        .where("userId", "==", userId)
        .where("isActive", "==", true)
        .orderBy("name", "asc")
        .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
async function assignNoReceiptCategory(userId, args) {
    const { transactionId, categoryId } = args;
    if (!transactionId || !categoryId) {
        throw new Error("transactionId and categoryId are required");
    }
    const [txDoc, catDoc] = await Promise.all([
        db.collection("transactions").doc(transactionId).get(),
        db.collection("noReceiptCategories").doc(categoryId).get(),
    ]);
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
        throw new Error("Transaction not found");
    }
    if (!catDoc.exists || catDoc.data()?.userId !== userId) {
        throw new Error("Category not found");
    }
    const catData = catDoc.data();
    const batch = db.batch();
    const now = firestore_1.FieldValue.serverTimestamp();
    batch.update(txDoc.ref, {
        noReceiptCategoryId: categoryId,
        noReceiptCategoryTemplateId: catData.templateId,
        noReceiptCategoryMatchedBy: "api",
        isComplete: true,
        updatedAt: now,
    });
    batch.update(catDoc.ref, {
        transactionCount: firestore_1.FieldValue.increment(1),
        updatedAt: now,
    });
    await batch.commit();
    return { success: true, transactionId, categoryId, categoryName: catData.name };
}
async function removeNoReceiptCategory(userId, transactionId) {
    if (!transactionId)
        throw new Error("transactionId is required");
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
        throw new Error("Transaction not found");
    }
    const txData = txDoc.data();
    const categoryId = txData.noReceiptCategoryId;
    if (!categoryId) {
        throw new Error("Transaction has no category assigned");
    }
    const hasFiles = txData.fileIds && txData.fileIds.length > 0;
    const batch = db.batch();
    const now = firestore_1.FieldValue.serverTimestamp();
    batch.update(txDoc.ref, {
        noReceiptCategoryId: null,
        noReceiptCategoryTemplateId: null,
        noReceiptCategoryMatchedBy: null,
        isComplete: hasFiles,
        updatedAt: now,
    });
    batch.update(db.collection("noReceiptCategories").doc(categoryId), {
        transactionCount: firestore_1.FieldValue.increment(-1),
        updatedAt: now,
    });
    await batch.commit();
    return { success: true, transactionId, isComplete: hasFiles };
}
//# sourceMappingURL=handlers.js.map