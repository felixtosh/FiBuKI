"use strict";
/**
 * Shared extraction logic used by both:
 * - extractFileData (onDocumentCreated trigger for new files)
 * - retryExtraction (onCall function for manual retries)
 *
 * This prevents code duplication and ensures consistent behavior.
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
exports.runExtraction = runExtraction;
const firestore_1 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const documentExtractor_1 = require("./documentExtractor");
const ai_usage_logger_1 = require("../utils/ai-usage-logger");
const db = (0, firestore_1.getFirestore)();
/**
 * Fetch user data from Firestore.
 * Normalizes both the new format (personalEntity + companies[]) and
 * deprecated flat fields (name, companyName, vatIds) into the UserData
 * interface used by counterparty matching.
 */
async function getUserData(userId) {
    try {
        const doc = await db
            .collection("users")
            .doc(userId)
            .collection("settings")
            .doc("userData")
            .get();
        if (!doc.exists) {
            return null;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = doc.data();
        // Collect names from all sources
        const names = [];
        const aliases = [];
        const vatIds = [];
        const ibans = [];
        // New format: personalEntity
        if (raw.personalEntity?.name) {
            names.push(raw.personalEntity.name);
            aliases.push(...(raw.personalEntity.aliases || []));
        }
        if (raw.personalEntity?.vatId) {
            vatIds.push(raw.personalEntity.vatId);
        }
        if (raw.personalEntity?.ibans) {
            ibans.push(...raw.personalEntity.ibans);
        }
        // New format: companies[]
        for (const company of raw.companies || []) {
            if (company.name) {
                names.push(company.name);
                aliases.push(...(company.aliases || []));
            }
            if (company.vatId) {
                vatIds.push(company.vatId);
            }
            if (company.ibans) {
                ibans.push(...company.ibans);
            }
        }
        // Deprecated flat fields (backward compat)
        if (raw.name)
            names.push(raw.name);
        if (raw.companyName)
            names.push(raw.companyName);
        aliases.push(...(raw.aliases || []));
        vatIds.push(...(raw.vatIds || []));
        ibans.push(...(raw.ibans || []));
        // Deduplicate
        const uniqueNames = [...new Set(names)].filter(Boolean);
        const uniqueAliases = [...new Set(aliases)].filter(Boolean);
        const uniqueVatIds = [...new Set(vatIds)].filter(Boolean);
        const uniqueIbans = [...new Set(ibans)].filter(Boolean);
        // Build normalized UserData with the first personal name and first company name
        const personalName = raw.personalEntity?.name || raw.name || uniqueNames[0] || "";
        const companyName = raw.companies?.[0]?.name || raw.companyName || (uniqueNames.length > 1 ? uniqueNames[1] : "");
        return {
            name: personalName,
            companyName: companyName,
            aliases: [...uniqueAliases, ...uniqueNames], // include all names as aliases for broad matching
            vatIds: uniqueVatIds,
            ibans: uniqueIbans,
        };
    }
    catch (error) {
        console.warn("[UserData] Failed to fetch user data:", error);
        return null;
    }
}
/**
 * Determine invoice direction based on extracted partner and user data.
 * - If partner matches user data: outgoing invoice (user is the issuer)
 * - If partner doesn't match: incoming invoice (user is the recipient)
 * - If no partner or no user data: unknown
 */
function determineInvoiceDirection(extractedPartner, userData) {
    if (!extractedPartner || !userData) {
        return "unknown";
    }
    const partnerLower = extractedPartner.toLowerCase().trim();
    // Check if extracted partner matches user's company name
    if (userData.companyName) {
        const companyLower = userData.companyName.toLowerCase();
        if (partnerLower.includes(companyLower) || companyLower.includes(partnerLower)) {
            return "outgoing";
        }
    }
    // Check if extracted partner matches user's name
    if (userData.name) {
        const nameLower = userData.name.toLowerCase();
        if (partnerLower.includes(nameLower) || nameLower.includes(partnerLower)) {
            return "outgoing";
        }
    }
    // Check against aliases
    for (const alias of userData.aliases || []) {
        if (alias) {
            const aliasLower = alias.toLowerCase();
            if (partnerLower.includes(aliasLower) || aliasLower.includes(partnerLower)) {
                return "outgoing";
            }
        }
    }
    // Partner doesn't match user data - this is an incoming invoice
    return "incoming";
}
/**
 * Fetch IBANs from user's connected bank accounts (sources)
 */
async function getSourceIbans(userId) {
    try {
        const sourcesSnapshot = await db
            .collection("sources")
            .where("userId", "==", userId)
            .where("isActive", "==", true)
            .get();
        return sourcesSnapshot.docs
            .map((doc) => doc.data().iban)
            .filter((iban) => !!iban)
            .map((iban) => iban.toUpperCase().replace(/\s/g, ""));
    }
    catch (error) {
        console.warn("[SourceIbans] Failed to fetch source IBANs:", error);
        return [];
    }
}
/**
 * Check if an entity matches user data (by VAT ID, IBAN, or name/aliases)
 */
function entityMatchesUserData(entity, userData, sourceIbans) {
    if (!entity)
        return false;
    // Check VAT ID match (strongest signal)
    if (entity.vatId && userData.vatIds?.length) {
        const normalizedEntityVat = entity.vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
        for (const userVat of userData.vatIds) {
            if (userVat.toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedEntityVat) {
                console.log(`  [CounterpartyMatch] VAT ID match: ${entity.vatId}`);
                return true;
            }
        }
    }
    // Check IBAN match against user's manual IBANs
    if (entity.iban && userData.ibans?.length) {
        const normalizedEntityIban = entity.iban.toUpperCase().replace(/\s/g, "");
        for (const userIban of userData.ibans) {
            if (userIban.toUpperCase().replace(/\s/g, "") === normalizedEntityIban) {
                console.log(`  [CounterpartyMatch] Manual IBAN match: ${entity.iban}`);
                return true;
            }
        }
    }
    // Check IBAN match against connected bank account IBANs
    if (entity.iban && sourceIbans.length) {
        const normalizedEntityIban = entity.iban.toUpperCase().replace(/\s/g, "");
        for (const sourceIban of sourceIbans) {
            if (sourceIban === normalizedEntityIban) {
                console.log(`  [CounterpartyMatch] Source IBAN match: ${entity.iban}`);
                return true;
            }
        }
    }
    // Check name match (weakest signal)
    if (entity.name) {
        const entityNameLower = entity.name.toLowerCase().trim();
        if (userData.companyName) {
            const companyLower = userData.companyName.toLowerCase();
            if (entityNameLower.includes(companyLower) || companyLower.includes(entityNameLower)) {
                console.log(`  [CounterpartyMatch] Company name match: ${entity.name}`);
                return true;
            }
        }
        if (userData.name) {
            const nameLower = userData.name.toLowerCase();
            if (entityNameLower.includes(nameLower) || nameLower.includes(entityNameLower)) {
                console.log(`  [CounterpartyMatch] Personal name match: ${entity.name}`);
                return true;
            }
        }
        for (const alias of userData.aliases || []) {
            if (alias) {
                const aliasLower = alias.toLowerCase();
                if (entityNameLower.includes(aliasLower) || aliasLower.includes(entityNameLower)) {
                    console.log(`  [CounterpartyMatch] Alias match: ${entity.name} ~ ${alias}`);
                    return true;
                }
            }
        }
    }
    return false;
}
/**
 * Determine the counterparty from extracted entities.
 * The counterparty is whichever entity does NOT match user data.
 */
function determineCounterparty(issuer, recipient, userData, sourceIbans) {
    // If no user data, can't determine - default to issuer as partner (legacy behavior)
    if (!userData) {
        console.log("  [CounterpartyMatch] No user data configured, defaulting to issuer");
        return {
            counterparty: issuer,
            matchedUserAccount: null,
            invoiceDirection: "unknown",
        };
    }
    // Check if issuer matches user data
    const issuerMatchesUser = entityMatchesUserData(issuer, userData, sourceIbans);
    // Check if recipient matches user data
    const recipientMatchesUser = entityMatchesUserData(recipient, userData, sourceIbans);
    if (issuerMatchesUser && !recipientMatchesUser) {
        // User is the issuer → outgoing invoice → recipient is counterparty
        console.log(`  [CounterpartyMatch] OUTGOING: issuer matches user, recipient is counterparty`);
        return {
            counterparty: recipient,
            matchedUserAccount: "issuer",
            invoiceDirection: "outgoing",
        };
    }
    if (recipientMatchesUser && !issuerMatchesUser) {
        // User is the recipient → incoming invoice → issuer is counterparty
        console.log(`  [CounterpartyMatch] INCOMING: recipient matches user, issuer is counterparty`);
        return {
            counterparty: issuer,
            matchedUserAccount: "recipient",
            invoiceDirection: "incoming",
        };
    }
    if (issuerMatchesUser && recipientMatchesUser) {
        // Both match - internal transfer/self-invoice, use recipient as counterparty
        console.log(`  [CounterpartyMatch] INTERNAL: both match user, treating as outgoing`);
        return {
            counterparty: recipient,
            matchedUserAccount: "issuer",
            invoiceDirection: "outgoing",
        };
    }
    // Neither matches - forwarded invoice or unknown
    // Default to issuer as partner (legacy behavior)
    console.log(`  [CounterpartyMatch] UNKNOWN: neither matches user, defaulting to issuer`);
    return {
        counterparty: issuer,
        matchedUserAccount: null,
        invoiceDirection: "unknown",
    };
}
function normalizeExtractedLineItems(lineItems) {
    if (!Array.isArray(lineItems)) {
        return [];
    }
    return lineItems
        .map((item, index) => {
        if (!item || typeof item.amount !== "number" || !Number.isFinite(item.amount)) {
            return null;
        }
        const normalizedVatPercent = typeof item.vatPercent === "number" &&
            Number.isFinite(item.vatPercent) &&
            item.vatPercent >= 0 &&
            item.vatPercent <= 100
            ? item.vatPercent
            : null;
        const normalizedVatAmount = typeof item.vatAmount === "number" && Number.isFinite(item.vatAmount)
            ? Math.round(item.vatAmount)
            : 0;
        const normalizedQuantity = typeof item.quantity === "number" && Number.isFinite(item.quantity)
            ? item.quantity
            : null;
        const normalizedUnitPrice = typeof item.unitPrice === "number" && Number.isFinite(item.unitPrice)
            ? Math.round(item.unitPrice)
            : null;
        return {
            description: item.description?.trim() || `Item ${index + 1}`,
            quantity: normalizedQuantity,
            unitPrice: normalizedUnitPrice,
            vatPercent: normalizedVatPercent,
            vatAmount: normalizedVatAmount,
            amount: Math.round(item.amount),
        };
    })
        .filter((item) => item !== null);
}
function inferLineItemAmountsAreNet(lineItems) {
    let comparedItems = 0;
    let netInterpretationError = 0;
    let grossInterpretationError = 0;
    for (const item of lineItems) {
        if (item.vatPercent === null ||
            !Number.isFinite(item.vatPercent) ||
            item.vatPercent <= 0 ||
            !Number.isFinite(item.vatAmount)) {
            continue;
        }
        const rate = item.vatPercent;
        const expectedVatIfNet = Math.round((item.amount * rate) / 100);
        const expectedVatIfGross = Math.round((item.amount * rate) / (100 + rate));
        netInterpretationError += Math.abs(expectedVatIfNet - item.vatAmount);
        grossInterpretationError += Math.abs(expectedVatIfGross - item.vatAmount);
        comparedItems += 1;
    }
    if (comparedItems === 0) {
        return false;
    }
    return netInterpretationError < grossInterpretationError;
}
function consolidateLineItems(lineItems, extractedDocumentAmount) {
    const totalAmountFromItems = lineItems.reduce((sum, item) => sum + item.amount, 0);
    const totalVatAmount = lineItems.reduce((sum, item) => sum + item.vatAmount, 0);
    const totalAmountFromNetPlusVat = totalAmountFromItems + totalVatAmount;
    const firstRate = lineItems[0]?.vatPercent ?? null;
    const hasSingleRate = firstRate !== null && lineItems.every((item) => item.vatPercent !== null && Math.abs(item.vatPercent - firstRate) < 0.0001);
    let totalAmount = totalAmountFromItems;
    if (typeof extractedDocumentAmount === "number" && Number.isFinite(extractedDocumentAmount)) {
        const distanceToAsIs = Math.abs(totalAmountFromItems - extractedDocumentAmount);
        const distanceToNetPlusVat = Math.abs(totalAmountFromNetPlusVat - extractedDocumentAmount);
        if (distanceToNetPlusVat < distanceToAsIs) {
            totalAmount = totalAmountFromNetPlusVat;
        }
        else {
            totalAmount = totalAmountFromItems;
        }
    }
    else {
        const amountsLookNet = totalVatAmount > 0 && inferLineItemAmountsAreNet(lineItems);
        totalAmount = amountsLookNet ? totalAmountFromNetPlusVat : totalAmountFromItems;
    }
    return {
        totalAmount,
        totalVatAmount,
        consolidatedVatPercent: hasSingleRate ? firstRate : null,
    };
}
/**
 * Run extraction for a file and save results to Firestore.
 * This is the shared core logic used by both extractFileData and retryExtraction.
 *
 * Two-phase process for real-time loading states:
 * 1. Classification phase: Determine if document is an invoice → save classificationComplete
 * 2. Extraction phase: Extract data from invoice → save extractionComplete
 */
async function runExtraction(fileId, fileData, options) {
    const t0 = Date.now();
    const fileRef = db.collection("files").doc(fileId);
    // Download file from Firebase Storage
    const storagePath = fileData.storagePath;
    if (!storagePath) {
        throw new Error("No storage path found for file");
    }
    const storage = (0, storage_1.getStorage)();
    const bucket = storage.bucket();
    const file = bucket.file(storagePath);
    const t1 = Date.now();
    const [fileBuffer] = await file.download();
    const t2 = Date.now();
    console.log(`[+${t2 - t0}ms] Downloaded file: ${fileBuffer.length} bytes (download took ${t2 - t1}ms)`);
    // Get provider and model config
    const provider = (0, documentExtractor_1.getDefaultProvider)();
    const geminiModel = options.geminiModel || process.env.GEMINI_MODEL || "gemini-2.0-flash-lite-001";
    const userId = fileData.userId;
    console.log(`[+${Date.now() - t0}ms] Starting ${provider} extraction (model: ${geminiModel})`);
    // ============================================================
    // PHASE 1: Classification (unless skipped by user override)
    // ============================================================
    if (!options.skipClassification && provider === "gemini") {
        const { classifyDocument, DEFAULT_GEMINI_MODEL } = await Promise.resolve().then(() => __importStar(require("./geminiParser")));
        const model = (geminiModel || DEFAULT_GEMINI_MODEL);
        console.log(`[+${Date.now() - t0}ms] Phase 1: Classification...`);
        const tClassify = Date.now();
        const classification = await classifyDocument(fileBuffer, fileData.fileType, model);
        console.log(`[+${Date.now() - t0}ms] Classification complete (took ${Date.now() - tClassify}ms): isInvoice=${classification.isInvoice}`);
        // Log classification token usage
        if (classification.usage && userId) {
            await (0, ai_usage_logger_1.logAIUsage)(userId, {
                function: "classification",
                model: classification.usage.model,
                inputTokens: classification.usage.inputTokens,
                outputTokens: classification.usage.outputTokens,
                metadata: { fileId },
            });
        }
        // Save classification result immediately (enables "Analyzing..." → result transition)
        await fileRef.update({
            classificationComplete: true,
            isNotInvoice: !classification.isInvoice,
            notInvoiceReason: classification.isInvoice ? null : (classification.reason || "Not an invoice"),
            updatedAt: firestore_1.Timestamp.now(),
        });
        console.log(`[+${Date.now() - t0}ms] Classification saved to Firestore`);
        // If not an invoice, we're done - no extraction needed
        if (!classification.isInvoice) {
            // Clear any existing extracted data and mark extraction complete
            await fileRef.update({
                extractionComplete: true,
                extractionError: null,
                extractionConfidence: Math.round(classification.confidence * 100),
                extractedDate: null,
                extractedAmount: null,
                extractedCurrency: null,
                extractedVatPercent: null,
                extractedVatAmount: null,
                extractedLineItems: null,
                extractedPartner: null,
                extractedVatId: null,
                extractedIban: null,
                extractedAddress: null,
                extractedWebsite: null,
                extractedRaw: null,
                extractedAdditionalFields: null,
                extractedText: "(classification only - not an invoice)",
                extractedFields: [],
                updatedAt: firestore_1.Timestamp.now(),
            });
            console.log(`[+${Date.now() - t0}ms] DONE - Not an invoice, skipping extraction`);
            return { success: true, duration: Date.now() - t0 };
        }
    }
    else if (options.skipClassification) {
        // User override - mark classification as complete (it's an invoice)
        await fileRef.update({
            classificationComplete: true,
            isNotInvoice: false,
            notInvoiceReason: null,
            updatedAt: firestore_1.Timestamp.now(),
        });
        console.log(`[+${Date.now() - t0}ms] Skip-Classification: User override, treating as invoice`);
    }
    // ============================================================
    // PHASE 2: Extraction (document is confirmed to be an invoice)
    // ============================================================
    console.log(`[+${Date.now() - t0}ms] Phase 2: Extraction...`);
    const t3 = Date.now();
    const result = await (0, documentExtractor_1.extractDocument)(fileBuffer, fileData.fileType, {
        provider,
        anthropicApiKey: options.anthropicApiKey,
        geminiModel,
        skipClassification: true, // Already classified above
    });
    const t4 = Date.now();
    console.log(`[+${t4 - t0}ms] Extraction complete (${result.provider}) - API took ${t4 - t3}ms`, {
        textLength: result.text.length,
        date: result.extracted.date,
        amount: result.extracted.amount,
        partner: result.extracted.partner,
        confidence: result.extracted.confidence,
        isNotInvoice: result.isNotInvoice,
    });
    // Log extraction token usage
    if (result.usage && userId) {
        await (0, ai_usage_logger_1.logAIUsage)(userId, {
            function: "extraction",
            model: result.usage.model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            metadata: { fileId },
        });
    }
    // Determine counterparty and invoice direction based on user data
    let invoiceDirection = "unknown";
    let matchedUserAccount = null;
    let counterparty = null;
    // Get extracted entities (from Gemini) or null (from legacy Claude parser)
    const extractedIssuer = result.extracted.issuer;
    const extractedRecipient = result.extracted.recipient;
    if (userId && !result.isNotInvoice) {
        const userData = await getUserData(userId);
        const sourceIbans = await getSourceIbans(userId);
        console.log(`[+${Date.now() - t0}ms] Determining counterparty...`);
        console.log(`  [CounterpartyMatch] Issuer: ${extractedIssuer?.name || "(none)"}, VAT: ${extractedIssuer?.vatId || "(none)"}`);
        console.log(`  [CounterpartyMatch] Recipient: ${extractedRecipient?.name || "(none)"}, VAT: ${extractedRecipient?.vatId || "(none)"}`);
        // Use new determineCounterparty if we have entity data
        if (extractedIssuer || extractedRecipient) {
            const counterpartyResult = determineCounterparty(extractedIssuer, extractedRecipient, userData, sourceIbans);
            counterparty = counterpartyResult.counterparty;
            matchedUserAccount = counterpartyResult.matchedUserAccount;
            invoiceDirection = counterpartyResult.invoiceDirection;
            console.log(`[+${Date.now() - t0}ms] Counterparty: "${counterparty?.name || "(none)"}", matchedUserAccount: ${matchedUserAccount}, direction: ${invoiceDirection}`);
        }
        else {
            // Fall back to legacy direction detection if no entities available
            invoiceDirection = determineInvoiceDirection(result.extracted.partner, userData);
            console.log(`[+${Date.now() - t0}ms] (Legacy) Invoice direction: ${invoiceDirection} (partner: "${result.extracted.partner}")`);
        }
    }
    // Build update data for Firestore
    const updateData = {
        extractedText: result.text,
        extractionConfidence: Math.round(result.extracted.confidence * 100),
        extractionProvider: result.provider,
        extractionComplete: true,
        extractionError: null,
        extractedFields: [], // Bounding box overlays removed - using text search instead
        invoiceDirection,
        matchedUserAccount,
        // Store extracted entities for future re-calculation
        extractedIssuer: extractedIssuer || null,
        extractedRecipient: extractedRecipient || null,
        // Ensure classificationComplete is set (for vision-claude provider which doesn't have separate classification)
        classificationComplete: true,
        isNotInvoice: false, // If we got here, it's confirmed to be an invoice
        notInvoiceReason: null,
        updatedAt: firestore_1.Timestamp.now(),
    };
    // Handle "not an invoice" classification
    if (result.isNotInvoice) {
        updateData.isNotInvoice = true;
        updateData.notInvoiceReason = result.notInvoiceReason || "Not an invoice";
        // Clear any hallucinated extracted data for non-invoices
        updateData.extractedDate = null;
        updateData.extractedAmount = null;
        updateData.extractedCurrency = null;
        updateData.extractedVatPercent = null;
        updateData.extractedVatAmount = null;
        updateData.extractedLineItems = null;
        updateData.extractedPartner = null;
        updateData.extractedVatId = null;
        updateData.extractedIban = null;
        updateData.extractedAddress = null;
        updateData.extractedWebsite = null;
        updateData.extractedRaw = null;
        updateData.extractedAdditionalFields = null;
        console.log(`[+${Date.now() - t0}ms] Classified as NOT an invoice: ${result.notInvoiceReason}`);
    }
    else {
        // Add extracted fields if found
        const extracted = result.extracted;
        if (extracted.date) {
            // Parse ISO date string to Timestamp
            const dateParts = extracted.date.split("-");
            if (dateParts.length === 3) {
                const date = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
                updateData.extractedDate = firestore_1.Timestamp.fromDate(date);
            }
        }
        if (extracted.currency) {
            updateData.extractedCurrency = extracted.currency;
        }
        const normalizedLineItems = normalizeExtractedLineItems(extracted.lineItems);
        if (normalizedLineItems.length > 0) {
            const consolidated = consolidateLineItems(normalizedLineItems, extracted.amount);
            updateData.extractedLineItems = normalizedLineItems;
            updateData.extractedAmount = consolidated.totalAmount;
            updateData.extractedVatAmount = consolidated.totalVatAmount;
            updateData.extractedVatPercent = consolidated.consolidatedVatPercent;
        }
        else {
            updateData.extractedLineItems = null;
            updateData.extractedVatAmount = null;
            updateData.extractedAmount = extracted.amount;
            updateData.extractedVatPercent = extracted.vatPercent;
        }
        // Use counterparty data if available, otherwise fall back to legacy extracted.partner
        // This ensures extractedPartner is always the counterparty (not the user's own company)
        if (counterparty) {
            // Use counterparty entity data
            if (counterparty.name) {
                updateData.extractedPartner = counterparty.name;
            }
            if (counterparty.vatId) {
                updateData.extractedVatId = counterparty.vatId;
            }
            if (counterparty.iban) {
                updateData.extractedIban = counterparty.iban;
            }
            if (counterparty.address) {
                updateData.extractedAddress = counterparty.address;
            }
            if (counterparty.website) {
                updateData.extractedWebsite = counterparty.website;
            }
        }
        else {
            // Fall back to legacy extracted fields (from Claude parser or when counterparty detection fails)
            if (extracted.partner) {
                updateData.extractedPartner = extracted.partner;
            }
            if (extracted.vatId) {
                updateData.extractedVatId = extracted.vatId;
            }
            if (extracted.iban) {
                updateData.extractedIban = extracted.iban;
            }
            if (extracted.address) {
                updateData.extractedAddress = extracted.address;
            }
            if (extracted.website) {
                updateData.extractedWebsite = extracted.website;
            }
        }
        // Store raw text values for PDF search/highlight
        if (result.extractedRaw) {
            // Update raw text to use counterparty's raw values if available
            const rawData = { ...result.extractedRaw };
            // If we determined counterparty from entities, use the appropriate raw text
            if (counterparty && result.extractedRaw) {
                const isCounterpartyIssuer = counterparty === extractedIssuer;
                const counterpartyRaw = isCounterpartyIssuer
                    ? result.extractedRaw.issuer
                    : result.extractedRaw.recipient;
                if (counterpartyRaw) {
                    // Override partner raw fields with counterparty's raw values
                    rawData.partner = counterpartyRaw.name || rawData.partner;
                    rawData.vatId = counterpartyRaw.vatId || rawData.vatId;
                    rawData.iban = counterpartyRaw.iban || rawData.iban;
                    rawData.address = counterpartyRaw.address || rawData.address;
                    rawData.website = counterpartyRaw.website || rawData.website;
                }
            }
            updateData.extractedRaw = rawData;
        }
        // Store additional fields extracted from the document
        if (result.additionalFields && result.additionalFields.length > 0) {
            updateData.extractedAdditionalFields = result.additionalFields;
            console.log(`[+${Date.now() - t0}ms] Stored ${result.additionalFields.length} additional fields`);
        }
    }
    // Save to Firestore
    const t6 = Date.now();
    await db.collection("files").doc(fileId).update(updateData);
    const tEnd = Date.now();
    console.log(`[+${tEnd - t0}ms] DONE - Firestore write took ${tEnd - t6}ms | Total: ${tEnd - t0}ms`);
    return { success: true, duration: tEnd - t0 };
}
//# sourceMappingURL=extractionCore.js.map