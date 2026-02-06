"use strict";
/**
 * Export match intelligence data for analysis.
 *
 * Produces a structured report from existing data:
 * - All fileConnections (manual + auto + suggestion_accepted)
 * - Per-partner accuracy breakdown
 * - Missed suggestions (manual connections that weren't suggested)
 * - Rejection history (files rejected from transactions)
 * - Dismissal history (suggestions dismissed by user)
 *
 * Used to study match quality and discover improvement opportunities.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportMatchIntelligenceCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
exports.exportMatchIntelligenceCallable = (0, createCallable_1.createCallable)({ name: "exportMatchIntelligence" }, async (ctx, request) => {
    const { partnerId, limit = 500 } = request;
    // 1. Load all fileConnections
    let connQuery = ctx.db
        .collection("fileConnections")
        .where("userId", "==", ctx.userId)
        .orderBy("createdAt", "desc")
        .limit(limit);
    const connSnap = await connQuery.get();
    // 2. Collect all file/transaction IDs for enrichment
    const fileIds = new Set();
    const txIds = new Set();
    for (const doc of connSnap.docs) {
        const d = doc.data();
        fileIds.add(d.fileId);
        txIds.add(d.transactionId);
    }
    // 3. Batch-load files and transactions for enrichment
    const fileMap = new Map();
    const fileIdArr = [...fileIds];
    for (let i = 0; i < fileIdArr.length; i += 30) {
        const batch = fileIdArr.slice(i, i + 30);
        const snap = await ctx.db
            .collection("files")
            .where("__name__", "in", batch)
            .get();
        for (const doc of snap.docs) {
            fileMap.set(doc.id, doc.data());
        }
    }
    const txMap = new Map();
    const txIdArr = [...txIds];
    for (let i = 0; i < txIdArr.length; i += 30) {
        const batch = txIdArr.slice(i, i + 30);
        const snap = await ctx.db
            .collection("transactions")
            .where("__name__", "in", batch)
            .get();
        for (const doc of snap.docs) {
            txMap.set(doc.id, doc.data());
        }
    }
    // 4. Load partners for name enrichment
    const partnerIds = new Set();
    for (const f of fileMap.values()) {
        if (f.partnerId)
            partnerIds.add(f.partnerId);
    }
    for (const t of txMap.values()) {
        if (t.partnerId)
            partnerIds.add(t.partnerId);
    }
    const partnerMap = new Map();
    const partnerIdArr = [...partnerIds];
    for (let i = 0; i < partnerIdArr.length; i += 30) {
        const batch = partnerIdArr.slice(i, i + 30);
        const snap = await ctx.db
            .collection("partners")
            .where("__name__", "in", batch)
            .get();
        for (const doc of snap.docs) {
            partnerMap.set(doc.id, doc.data().name || doc.id);
        }
    }
    // 5. Build rejection set for accuracy calculation
    const rejectedPairs = new Set(); // "fileId:txId"
    const rejections = [];
    for (const [txId, txData] of txMap) {
        // New format
        for (const r of (txData.rejectedFiles || [])) {
            rejectedPairs.add(`${r.fileId}:${txId}`);
            rejections.push({
                transactionId: txId,
                fileId: r.fileId,
                rejectedAt: r.rejectedAt ? r.rejectedAt.toDate().toISOString() : null,
                matchConfidence: r.matchConfidence ?? null,
            });
        }
        // Legacy format
        for (const fId of (txData.rejectedFileIds || [])) {
            const key = `${fId}:${txId}`;
            if (!rejectedPairs.has(key)) {
                rejectedPairs.add(key);
                rejections.push({
                    transactionId: txId,
                    fileId: fId,
                    rejectedAt: null,
                    matchConfidence: null,
                });
            }
        }
    }
    // 6. Build dismissal list
    const dismissals = [];
    for (const [fileId, fileData] of fileMap) {
        // New format
        for (const d of (fileData.dismissedTransactions || [])) {
            dismissals.push({
                fileId,
                transactionId: d.transactionId,
                dismissedAt: d.dismissedAt
                    ? d.dismissedAt.toDate().toISOString()
                    : null,
                confidence: d.confidence ?? null,
            });
        }
        // Legacy format
        for (const txId of (fileData.dismissedTransactionIds || [])) {
            if (!dismissals.some((d) => d.fileId === fileId && d.transactionId === txId)) {
                dismissals.push({
                    fileId,
                    transactionId: txId,
                    dismissedAt: null,
                    confidence: null,
                });
            }
        }
    }
    // 7. Build enriched connection records
    const connections = [];
    const perPartner = new Map();
    let totalManual = 0;
    let totalAuto = 0;
    let totalSuggestionAccepted = 0;
    let totalMissed = 0;
    let autoCorrect = 0;
    for (const doc of connSnap.docs) {
        const conn = doc.data();
        const fileData = fileMap.get(conn.fileId) || {};
        const txData = txMap.get(conn.transactionId) || {};
        const pId = conn.partnerId ||
            fileData.partnerId ||
            txData.partnerId ||
            null;
        // Filter by partner if requested
        if (partnerId && pId !== partnerId)
            continue;
        const connType = conn.connectionType || "manual";
        const pairKey = `${conn.fileId}:${conn.transactionId}`;
        const wasRejected = rejectedPairs.has(pairKey);
        const record = {
            connectionId: doc.id,
            fileId: conn.fileId,
            transactionId: conn.transactionId,
            connectionType: connType,
            matchConfidence: conn.matchConfidence ?? null,
            scoreBreakdown: conn.scoreBreakdown ?? null,
            wasSuggested: conn.wasSuggested ?? false,
            suggestedConfidence: conn.suggestedConfidence ?? null,
            suggestedRank: conn.suggestedRank ?? null,
            sourceType: conn.sourceType ?? null,
            createdAt: conn.createdAt
                ? conn.createdAt.toDate().toISOString()
                : "",
            fileName: fileData.fileName ?? null,
            extractedAmount: fileData.extractedAmount ?? null,
            extractedPartner: fileData.extractedPartner ?? null,
            transactionName: txData.name ?? null,
            transactionAmount: txData.amount ?? null,
            transactionDate: txData.date
                ? txData.date.toDate().toISOString().split("T")[0]
                : null,
            partnerId: pId,
            partnerName: pId ? partnerMap.get(pId) || pId : null,
        };
        connections.push(record);
        // Track stats
        if (connType === "manual") {
            totalManual++;
            if (!conn.wasSuggested)
                totalMissed++;
        }
        else if (connType === "auto_matched") {
            totalAuto++;
            if (!wasRejected)
                autoCorrect++;
        }
        else if (connType === "suggestion_accepted") {
            totalSuggestionAccepted++;
        }
        // Per-partner stats
        if (pId) {
            if (!perPartner.has(pId)) {
                perPartner.set(pId, {
                    total: 0,
                    manual: 0,
                    auto: 0,
                    suggestionAccepted: 0,
                    missed: 0,
                    rejected: 0,
                });
            }
            const ps = perPartner.get(pId);
            ps.total++;
            if (connType === "manual") {
                ps.manual++;
                if (!conn.wasSuggested)
                    ps.missed++;
            }
            else if (connType === "auto_matched") {
                ps.auto++;
                if (wasRejected)
                    ps.rejected++;
            }
            else if (connType === "suggestion_accepted") {
                ps.suggestionAccepted++;
            }
        }
    }
    // 8. Build partner summaries
    const partnerSummaries = [...perPartner.entries()]
        .map(([pId, stats]) => ({
        partnerId: pId,
        partnerName: partnerMap.get(pId) || pId,
        totalConnections: stats.total,
        manualCount: stats.manual,
        autoCount: stats.auto,
        suggestionAcceptedCount: stats.suggestionAccepted,
        missedSuggestions: stats.missed,
        rejections: stats.rejected,
        accuracy: stats.auto > 0
            ? Math.round(((stats.auto - stats.rejected) / stats.auto) * 100)
            : 100,
    }))
        .sort((a, b) => b.totalConnections - a.totalConnections);
    const totalConnections = connections.length;
    const autoMatchAccuracy = totalAuto > 0 ? Math.round((autoCorrect / totalAuto) * 100) : 0;
    const suggestionAcceptRate = totalSuggestionAccepted + dismissals.length > 0
        ? Math.round((totalSuggestionAccepted /
            (totalSuggestionAccepted + dismissals.length)) *
            100)
        : 0;
    const report = {
        connections,
        rejections,
        dismissals,
        partnerSummaries,
        totals: {
            totalConnections,
            manualConnections: totalManual,
            autoConnections: totalAuto,
            suggestionAccepted: totalSuggestionAccepted,
            totalRejections: rejections.length,
            totalDismissals: dismissals.length,
            missedSuggestions: totalMissed,
            autoMatchAccuracy,
            suggestionAcceptRate,
        },
        exportedAt: new Date().toISOString(),
    };
    console.log(`[MatchIntelligence] Exported ${totalConnections} connections, ` +
        `${rejections.length} rejections, ${dismissals.length} dismissals ` +
        `for user ${ctx.userId}`);
    return { success: true, report };
});
//# sourceMappingURL=exportMatchIntelligence.js.map