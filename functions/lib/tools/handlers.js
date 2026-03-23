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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
exports.listPartners = listPartners;
exports.getPartner = getPartner;
exports.createPartner = createPartner;
exports.assignPartnerToTx = assignPartnerToTx;
exports.removePartnerFromTx = removePartnerFromTx;
exports.createSource = createSource;
exports.deleteSource = deleteSource;
exports.importTransactions = importTransactions;
exports.uploadFile = uploadFile;
exports.scoreFileTransactionMatch = scoreFileTransactionMatch;
exports.getAutomationStatus = getAutomationStatus;
const firestore_1 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const definitions_1 = require("./definitions");
Object.defineProperty(exports, "TOOL_NAMES", { enumerable: true, get: function () { return definitions_1.TOOL_NAMES; } });
const config_1 = require("../billing/config");
/**
 * Convert a Firestore Timestamp to YYYY-MM-DD in Europe/Vienna timezone.
 * Bank transactions are date-only — returning full ISO timestamps causes
 * timezone confusion (e.g. Dec 1 CET → Nov 30 UTC).
 */
function toLocalDate(ts) {
    if (!ts)
        return null;
    if (typeof ts === "string")
        return ts;
    const date = typeof ts.toDate === "function" ? ts.toDate() : null;
    if (!date)
        return null;
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna" }).format(date);
}
const db = (0, firestore_1.getFirestore)();
/**
 * Check if a tool requires a feature the user's plan doesn't have.
 * Returns an error message if blocked, or null if allowed.
 */
async function checkToolFeatureGate(userId, tool) {
    const toolDef = definitions_1.TOOL_DEFINITIONS.find((t) => t.name === tool);
    if (!toolDef?.requiredFeature)
        return null;
    const subDoc = await db.collection("subscriptions").doc(userId).get();
    const planId = (subDoc.exists ? subDoc.data().plan : "free") || "free";
    const plan = config_1.PLANS[planId] || config_1.PLANS.free;
    if (!plan.planFeatures[toolDef.requiredFeature]) {
        return `Tool "${tool}" requires the "${toolDef.requiredFeature}" feature, which is not available on the ${plan.name} plan. Upgrade at https://fibuki.com/settings/billing`;
    }
    return null;
}
/**
 * Main tool dispatcher - routes tool calls to handlers
 */
async function handleTool(userId, tool, args = {}) {
    // Check feature gate before executing
    const gateError = await checkToolFeatureGate(userId, tool);
    if (gateError) {
        throw new Error(gateError);
    }
    switch (tool) {
        // Sources
        case "list_sources":
            return listSources(userId);
        case "get_source":
            return getSource(userId, args.sourceId);
        case "create_source":
            return createSource(userId, args);
        case "delete_source":
            return deleteSource(userId, args);
        // Transactions
        case "list_transactions":
            return listTransactions(userId, args);
        case "get_transaction":
            return getTransaction(userId, args.transactionId);
        case "update_transaction":
            return updateTransaction(userId, args);
        case "list_transactions_needing_files":
            return listTransactionsNeedingFiles(userId, args);
        case "import_transactions":
            return importTransactions(userId, args);
        // Files
        case "list_files":
            return listFiles(userId, args);
        case "get_file":
            return getFile(userId, args.fileId);
        case "connect_file_to_transaction":
            return connectFileToTransaction(userId, args);
        case "disconnect_file_from_transaction":
            return disconnectFileFromTransaction(userId, args);
        case "auto_connect_file_suggestions":
            return autoConnectFileSuggestions(userId, args);
        case "upload_file":
            return uploadFile(userId, args);
        case "score_file_transaction_match":
            return scoreFileTransactionMatch(userId, args);
        // Partners
        case "list_partners":
            return listPartners(userId, args);
        case "get_partner":
            return getPartner(userId, args.partnerId);
        case "create_partner":
            return createPartner(userId, args);
        case "assign_partner_to_transaction":
            return assignPartnerToTx(userId, args);
        case "remove_partner_from_transaction":
            return removePartnerFromTx(userId, args);
        // Categories
        case "list_no_receipt_categories":
            return listNoReceiptCategories(userId);
        case "assign_no_receipt_category":
            return assignNoReceiptCategory(userId, args);
        case "remove_no_receipt_category":
            return removeNoReceiptCategory(userId, args.transactionId);
        // Status
        case "get_automation_status":
            return getAutomationStatus(userId);
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
            date: toLocalDate(data.date) || data.date,
            amountFormatted: `${((data.amount || 0) / 100).toFixed(2)} ${data.currency || "EUR"}`,
        };
    });
    // Client-side filters (for fields not indexed together)
    if (args.dateFrom) {
        transactions = transactions.filter((t) => t.date >= args.dateFrom);
    }
    if (args.dateTo) {
        transactions = transactions.filter((t) => t.date <= args.dateTo);
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
        date: toLocalDate(data.date) || data.date,
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
        .map((doc) => {
        const data = doc.data();
        return { id: doc.id, ...data, date: toLocalDate(data.date) || data.date };
    })
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
// ============================================================================
// Partners
// ============================================================================
async function listPartners(userId, args) {
    const snapshot = await db
        .collection("partners")
        .where("userId", "==", userId)
        .where("isActive", "==", true)
        .orderBy("name", "asc")
        .get();
    let partners = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
            id: doc.id,
            name: data.name,
            aliases: data.aliases || [],
            vatId: data.vatId || null,
            ibans: data.ibans || [],
            website: data.website || null,
            country: data.country || null,
            defaultCategoryId: data.defaultCategoryId || null,
        };
    });
    if (args.search) {
        const search = args.search.toLowerCase();
        partners = partners.filter((p) => p.name?.toLowerCase().includes(search) ||
            p.aliases?.some((a) => a.toLowerCase().includes(search)));
    }
    const limit = Math.min(args.limit || 50, 100);
    return partners.slice(0, limit);
}
async function getPartner(userId, partnerId) {
    if (!partnerId)
        throw new Error("partnerId is required");
    const doc = await db.collection("partners").doc(partnerId).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
        throw new Error("Partner not found");
    }
    return { id: doc.id, ...doc.data() };
}
async function createPartner(userId, args) {
    const { createUserPartnerInternal } = await Promise.resolve().then(() => __importStar(require("../partners/createUserPartner")));
    return createUserPartnerInternal(db, userId, {
        name: args.name,
        aliases: args.aliases,
        vatId: args.vatId,
        ibans: args.ibans,
        website: args.website,
        country: args.country,
    });
}
async function assignPartnerToTx(userId, args) {
    const { transactionId, partnerId } = args;
    if (!transactionId)
        throw new Error("transactionId is required");
    if (!partnerId)
        throw new Error("partnerId is required");
    // Verify transaction ownership
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
        throw new Error("Transaction not found");
    }
    // Verify partner ownership
    const partnerDoc = await db.collection("partners").doc(partnerId).get();
    if (!partnerDoc.exists || partnerDoc.data()?.userId !== userId) {
        throw new Error("Partner not found");
    }
    const now = firestore_1.FieldValue.serverTimestamp();
    await db.collection("transactions").doc(transactionId).update({
        partnerId,
        partnerType: "user",
        partnerMatchedBy: "api",
        partnerMatchConfidence: null,
        updatedAt: now,
        automationHistory: firestore_1.FieldValue.arrayUnion({
            type: "partner_assigned",
            ranAt: firestore_1.Timestamp.now(),
            status: "completed",
            actor: "manual",
            level: "decision",
            partnerName: partnerDoc.data().name || null,
            forPartnerId: partnerId,
            summary: `Partner "${partnerDoc.data().name}" assigned via API`,
        }),
    });
    return { success: true, transactionId, partnerId };
}
async function removePartnerFromTx(userId, args) {
    const { transactionId } = args;
    if (!transactionId)
        throw new Error("transactionId is required");
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    if (!txDoc.exists || txDoc.data()?.userId !== userId) {
        throw new Error("Transaction not found");
    }
    const txData = txDoc.data();
    const previousPartnerId = txData.partnerId;
    // Look up partner name for activity log
    let partnerName = null;
    if (previousPartnerId) {
        try {
            const pSnap = await db.collection("partners").doc(previousPartnerId).get();
            partnerName = pSnap.data()?.name || null;
        }
        catch { /* best effort */ }
    }
    const now = firestore_1.FieldValue.serverTimestamp();
    await db.collection("transactions").doc(transactionId).update({
        partnerId: null,
        partnerType: null,
        partnerMatchedBy: null,
        partnerMatchConfidence: null,
        updatedAt: now,
        automationHistory: firestore_1.FieldValue.arrayUnion({
            type: "partner_removed",
            ranAt: firestore_1.Timestamp.now(),
            status: "completed",
            actor: "manual",
            level: "decision",
            partnerName: partnerName || previousPartnerId || null,
            forPartnerId: previousPartnerId || null,
            summary: `Partner "${partnerName || previousPartnerId}" removed via API`,
        }),
    });
    return { success: true, transactionId };
}
// ============================================================================
// Source Management
// ============================================================================
async function createSource(userId, args) {
    const { createSourceInternal } = await Promise.resolve().then(() => __importStar(require("../sources/createSource")));
    return createSourceInternal(db, userId, {
        name: args.name,
        accountKind: args.accountKind || "bank_account",
        iban: args.iban,
        currency: args.currency || "EUR",
        type: "manual",
    });
}
async function deleteSource(userId, args) {
    const { sourceId, confirm } = args;
    if (!sourceId)
        throw new Error("sourceId is required");
    if (confirm !== true) {
        throw new Error("Must set confirm: true to delete a source. This will delete all associated transactions.");
    }
    const { deleteSourceInternal } = await Promise.resolve().then(() => __importStar(require("../sources/deleteSource")));
    return deleteSourceInternal(db, userId, sourceId);
}
// ============================================================================
// Import
// ============================================================================
async function importTransactions(userId, args) {
    const { sourceId, transactions: rawTxs } = args;
    if (!sourceId)
        throw new Error("sourceId is required");
    if (!rawTxs || !Array.isArray(rawTxs))
        throw new Error("transactions array is required");
    // Verify source ownership
    const sourceDoc = await db.collection("sources").doc(sourceId).get();
    if (!sourceDoc.exists || sourceDoc.data()?.userId !== userId) {
        throw new Error("Source not found");
    }
    // Build transaction data with dedupeHashes
    const crypto = await Promise.resolve().then(() => __importStar(require("crypto")));
    const importJobId = `api_${Date.now()}`;
    const transactions = rawTxs.map((tx, index) => {
        const date = tx.date;
        const amount = tx.amount;
        const name = tx.name;
        const currency = tx.currency || "EUR";
        // Generate dedupeHash from key fields
        const hashInput = `${sourceId}|${date}|${amount}|${name}|${currency}`;
        const dedupeHash = crypto.createHash("sha256").update(hashInput).digest("hex");
        return {
            sourceId: sourceId,
            date,
            amount,
            currency,
            name,
            description: tx.description || null,
            partner: tx.partner || null,
            reference: tx.reference || null,
            partnerIban: tx.partnerIban || null,
            dedupeHash,
            importJobId,
            csvRowIndex: index,
            _original: {
                date: date,
                amount: String(amount),
                rawRow: tx,
            },
        };
    });
    // Use bulk create directly (not via callable to avoid double auth check)
    const { Timestamp: AdminTimestamp } = await Promise.resolve().then(() => __importStar(require("firebase-admin/firestore")));
    const { checkTransactionQuota, incrementTransactionCount } = await Promise.resolve().then(() => __importStar(require("../billing/checkTransactionQuota")));
    const quota = await checkTransactionQuota(userId, transactions.length, false);
    const overLimitStartIndex = quota.allowed ? transactions.length : quota.remainingSlots;
    const now = AdminTimestamp.now();
    const transactionIds = [];
    const overLimitTransactionIds = [];
    const BATCH_SIZE = 500;
    let globalIndex = 0;
    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = transactions.slice(i, i + BATCH_SIZE);
        for (const txData of chunk) {
            const docRef = db.collection("transactions").doc();
            transactionIds.push(docRef.id);
            const isOverLimit = globalIndex >= overLimitStartIndex;
            if (isOverLimit) {
                overLimitTransactionIds.push(docRef.id);
            }
            const dateObj = new Date(txData.date);
            if (isNaN(dateObj.getTime())) {
                throw new Error(`Invalid date: ${txData.date}`);
            }
            const transactionDoc = {
                userId,
                sourceId: txData.sourceId,
                date: AdminTimestamp.fromDate(dateObj),
                amount: txData.amount,
                currency: txData.currency,
                name: txData.name,
                description: txData.description,
                partner: txData.partner,
                reference: txData.reference,
                partnerIban: txData.partnerIban,
                dedupeHash: txData.dedupeHash,
                importJobId: txData.importJobId,
                csvRowIndex: txData.csvRowIndex,
                _original: txData._original,
                fileIds: [],
                isComplete: false,
                partnerId: null,
                partnerType: null,
                partnerMatchConfidence: null,
                partnerMatchedBy: null,
                noReceiptCategoryId: null,
                createdAt: now,
                updatedAt: now,
            };
            if (isOverLimit) {
                transactionDoc.quotaExceeded = true;
            }
            batch.set(docRef, transactionDoc);
            globalIndex++;
        }
        await batch.commit();
    }
    const withinQuotaCount = transactionIds.length - overLimitTransactionIds.length;
    if (withinQuotaCount > 0) {
        incrementTransactionCount(userId, withinQuotaCount).catch((err) => console.error("[importTransactions] Failed to increment transaction count:", err));
    }
    return {
        success: true,
        transactionIds,
        count: transactionIds.length,
        quotaExceeded: overLimitTransactionIds.length > 0,
        overLimitCount: overLimitTransactionIds.length,
    };
}
// ============================================================================
// File Upload & Scoring
// ============================================================================
async function uploadFile(userId, args) {
    const { url, base64, fileName, mimeType } = args;
    if (!fileName)
        throw new Error("fileName is required");
    if (!mimeType)
        throw new Error("mimeType is required");
    if (!url && !base64)
        throw new Error("Either url or base64 is required");
    let fileBuffer;
    if (base64) {
        fileBuffer = Buffer.from(base64, "base64");
    }
    else {
        // Download from URL
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuffer);
    }
    // Upload to Storage
    const bucket = (0, storage_1.getStorage)().bucket();
    const storagePath = `users/${userId}/files/${Date.now()}_${fileName}`;
    const file = bucket.file(storagePath);
    await file.save(fileBuffer, {
        metadata: {
            contentType: mimeType,
            metadata: { userId },
        },
    });
    // Get download URL
    const [downloadUrl] = await file.getSignedUrl({
        action: "read",
        expires: "2099-01-01",
    });
    // Create file record in Firestore
    const now = firestore_1.FieldValue.serverTimestamp();
    const fileDoc = await db.collection("files").add({
        userId,
        fileName: fileName,
        mimeType: mimeType,
        storagePath,
        downloadUrl,
        fileSize: fileBuffer.length,
        transactionIds: [],
        isNotInvoice: false,
        extractionComplete: false,
        partnerMatchComplete: false,
        transactionMatchComplete: false,
        uploadedAt: now,
        createdAt: now,
        updatedAt: now,
    });
    return {
        success: true,
        fileId: fileDoc.id,
        fileName,
        storagePath,
        fileSize: fileBuffer.length,
    };
}
async function scoreFileTransactionMatch(userId, args) {
    const { fileId, transactionId } = args;
    if (!fileId)
        throw new Error("fileId is required");
    if (!transactionId)
        throw new Error("transactionId is required");
    // Verify ownership
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
    // Use the shared scoring logic
    const { scoreTransaction, formatScoreBreakdown } = await Promise.resolve().then(() => __importStar(require("../matching/transactionScoring")));
    const fileData = fileDoc.data();
    const txData = txDoc.data();
    const result = scoreTransaction({
        extractedAmount: fileData.extractedAmount,
        extractedCurrency: fileData.extractedCurrency,
        extractedDate: fileData.extractedDate,
        extractedPartner: fileData.extractedPartner,
        extractedIban: fileData.extractedIban,
        extractedText: fileData.extractedText,
        partnerId: fileData.partnerId,
    }, {
        id: transactionId,
        amount: txData.amount,
        date: txData.date,
        currency: txData.currency,
        name: txData.name,
        partner: txData.partner,
        partnerName: txData.partnerName,
        partnerId: txData.partnerId,
        partnerIban: txData.partnerIban,
        reference: txData.reference,
    }, []);
    return {
        fileId,
        transactionId,
        confidence: result.confidence,
        matchSources: result.matchSources,
        breakdown: formatScoreBreakdown(result.breakdown),
    };
}
// ============================================================================
// Automation Status
// ============================================================================
/** Filter tools to those available for a given plan's features */
function getAvailableTools(features) {
    return definitions_1.TOOL_DEFINITIONS.filter((tool) => {
        if (!tool.requiredFeature)
            return true;
        return features[tool.requiredFeature];
    });
}
async function getAutomationStatus(userId) {
    const subDoc = await db.collection("subscriptions").doc(userId).get();
    const planId = (subDoc.exists ? subDoc.data().plan : "free") || "free";
    const plan = config_1.PLANS[planId] || config_1.PLANS.free;
    const features = plan.planFeatures;
    const availableTools = getAvailableTools(features);
    if (!subDoc.exists) {
        return {
            automationMode: "active",
            plan: "free",
            planFeatures: features,
            availableTools,
            rateLimit: plan.rateLimit,
            aiBudget: {
                fairUseLimitEur: 0.5,
                usageCurrentPeriodEur: 0,
                creditsEur: 0,
                paused: false,
            },
        };
    }
    const sub = subDoc.data();
    return {
        automationMode: sub.automationMode || "active",
        plan: sub.plan || "free",
        planFeatures: features,
        availableTools,
        rateLimit: plan.rateLimit,
        aiBudget: {
            fairUseLimitEur: sub.aiFairUseLimitEur ?? 0.5,
            usageCurrentPeriodEur: sub.aiUsageCurrentPeriodEur ?? 0,
            creditsEur: sub.aiCreditsEur ?? 0,
            overageCapEur: sub.aiOverageCapEur ?? 0,
            overageUsedEur: sub.aiOverageCurrentPeriodEur ?? 0,
            paused: sub.aiPaused ?? false,
        },
        transactionQuota: {
            currentCount: sub.transactionCountCurrentMonth ?? 0,
            month: sub.transactionCountMonth ?? null,
        },
    };
}
//# sourceMappingURL=handlers.js.map