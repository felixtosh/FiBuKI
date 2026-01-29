/**
 * Cloud Function: Match File to Partner
 *
 * Triggered when a file's extraction completes.
 * Searches for matching partners and optionally creates new ones via Gemini lookup.
 *
 * Pipeline:
 *   extractFileData -> (sets extractionComplete: true)
 *                   -> matchFilePartner fires -> (sets partnerMatchComplete: true)
 *                                             -> matchFileTransactions fires
 */

import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { createLocalPartnerFromGlobal } from "./createLocalPartnerFromGlobal";
import { isValidCompanyName } from "../utils/companyNameValidator";
import {
  matchFileToAllPartners,
  shouldAutoApply,
  PartnerData,
} from "../utils/filePartnerMatcher";
import {
  searchByName,
  createVertexAI,
  CompanyInfo,
  parseVatId,
  queryViesApi,
  parseViesAddress,
} from "../ai/lookupCompany";
import { geminiValidateDomainOwnership } from "../ai/validateDomainOwnership";
import { AutomationMeta } from "../automation/types";

// =============================================================================
// AUTOMATION METADATA
// =============================================================================

export const AUTOMATION_META: AutomationMeta = {
  id: "matchFilePartner",
  name: "Match File to Partner",
  description:
    "Finds matching partners for uploaded files using IBAN, VAT, name, and email domain matching",
  trigger: {
    type: "document_update",
    collection: "files",
    conditions: [
      { field: "extractionComplete", from: false, to: true },
      { field: "extractionError", to: null },
    ],
  },
  effects: [
    {
      entity: "file",
      fields: [
        "partnerId",
        "partnerType",
        "partnerMatchedBy",
        "partnerMatchConfidence",
        "partnerSuggestions",
        "partnerMatchComplete",
      ],
      action: "update",
    },
    {
      entity: "partner",
      fields: ["aliases", "emailDomains"],
      action: "update",
    },
  ],
  learns: [
    {
      entity: "partner",
      fields: ["aliases"],
      description: "Adds extracted partner name as alias when matched",
    },
    {
      entity: "partner",
      fields: ["emailDomains"],
      description: "Learns email sender domain from Gmail files (with validation)",
    },
  ],
  config: {
    autoMatchThreshold: 89,
    maxSuggestions: 3,
    lookupCreatedConfidence: 89,
  },
  chains: ["matchFileTransactions"],
  icon: "Building2",
  category: "matching",
  aiPowered: true,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const db = getFirestore();

// === User Data Types ===

interface UserData {
  vatIds?: string[];
  ibans?: string[];
  ownEmails?: string[];
}

/**
 * Check if a VAT ID belongs to the user
 */
function isUserVatId(vatId: string, userData: UserData | null): boolean {
  if (!vatId || !userData?.vatIds?.length) return false;
  const normalizedVatId = vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return userData.vatIds.some(
    (userVat) => userVat.toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedVatId
  );
}

/**
 * Check if an IBAN belongs to the user
 */
function isUserIban(iban: string, userData: UserData | null, sourceIbans: string[]): boolean {
  if (!iban) return false;
  const normalizedIban = iban.toUpperCase().replace(/\s/g, "");

  // Check against user's manual IBANs
  if (userData?.ibans?.length) {
    if (userData.ibans.some((userIban) => userIban.toUpperCase().replace(/\s/g, "") === normalizedIban)) {
      return true;
    }
  }

  // Check against source IBANs (connected bank accounts)
  return sourceIbans.some((sourceIban) => sourceIban.toUpperCase().replace(/\s/g, "") === normalizedIban);
}

/**
 * Check if an email address belongs to the user.
 * Checks against manually added emails (userData.ownEmails)
 * and inferred emails from connected email integrations.
 * Uses full email matching to avoid false positives with common domains like gmail.com.
 */
function isUserEmail(
  email: string,
  userData: UserData | null,
  integrationEmails: string[]
): boolean {
  if (!email) return false;

  const normalizedEmail = email.toLowerCase().trim();

  // Check against manually added emails
  if (userData?.ownEmails?.length) {
    if (userData.ownEmails.some(
      (e) => e.toLowerCase().trim() === normalizedEmail
    )) {
      return true;
    }
  }

  // Check against integration emails (auto-detected from Gmail accounts)
  return integrationEmails.some(
    (e) => e.toLowerCase().trim() === normalizedEmail
  );
}

// === Configuration ===

const CONFIG = {
  /** Minimum confidence for auto-matching partner */
  AUTO_MATCH_THRESHOLD: 89,
  /** Max suggestions to store per file */
  MAX_SUGGESTIONS: 3,
  /** Confidence assigned to partners created from lookup */
  LOOKUP_CREATED_CONFIDENCE: 89,
};

// === Types ===

interface PartnerSuggestion {
  partnerId: string;
  partnerType: "user" | "global";
  confidence: number;
  source: "iban" | "vatId" | "name" | "emailDomain" | "website";
}

// === Helper Functions ===

/**
 * Learn extracted partner name as alias on an existing partner.
 * This improves future matching: invoices with the same extracted name will match.
 */
async function learnPartnerAlias(
  partnerId: string,
  extractedName: string | undefined
): Promise<void> {
  if (!extractedName) return;

  const partnerDoc = await db.collection("partners").doc(partnerId).get();
  if (!partnerDoc.exists) return;

  const partnerData = partnerDoc.data()!;
  const existingAliases: string[] = partnerData.aliases || [];
  const partnerName: string = partnerData.name || "";

  // Normalize for comparison
  const normalizedExtracted = extractedName.toLowerCase().trim();
  const normalizedName = partnerName.toLowerCase().trim();

  // Skip if it matches the partner name
  if (normalizedExtracted === normalizedName) return;

  // Skip if already in aliases
  if (existingAliases.some((a) => a.toLowerCase().trim() === normalizedExtracted)) {
    return;
  }

  // Add as alias
  await partnerDoc.ref.update({
    aliases: FieldValue.arrayUnion(extractedName),
    updatedAt: Timestamp.now(),
  });

  console.log(
    `[PartnerMatch] Learned alias "${extractedName}" for partner ${partnerId} (${partnerName})`
  );
}

/**
 * Normalize website URL to domain format
 * e.g., "https://www.amazon.de/something" -> "amazon.de"
 */
function extractDomainFromWebsite(website: string | undefined | null): string | null {
  if (!website) return null;

  let domain = website.toLowerCase().trim();

  // Remove protocol
  domain = domain.replace(/^https?:\/\//, "");

  // Remove path and query
  domain = domain.split("/")[0].split("?")[0];

  // Remove www prefix
  domain = domain.replace(/^www\./, "");

  return domain || null;
}

/**
 * Check if two domains match (handles subdomains)
 * e.g., "mail.amazon.de" matches "amazon.de"
 */
function domainsMatchForLearning(domain1: string, domain2: string): boolean {
  if (!domain1 || !domain2) return false;

  const d1 = domain1.toLowerCase().trim();
  const d2 = domain2.toLowerCase().trim();

  if (d1 === d2) return true;

  // Check if one is a subdomain of the other
  return d1.endsWith(`.${d2}`) || d2.endsWith(`.${d1}`);
}

interface DomainLearningDecision {
  shouldLearn: boolean;
  domainToLearn: string | null;
  reason: string;
}

/**
 * Validate whether a domain should be learned for a partner.
 * Prefers extractedWebsite (high confidence) over gmailSenderDomain.
 * Uses Gemini validation when only gmailSenderDomain is available.
 */
async function validateDomainForLearning(
  gmailSenderDomain: string | null,
  extractedWebsite: string | null | undefined,
  partnerName: string,
  partnerWebsite: string | null | undefined,
  userId: string
): Promise<DomainLearningDecision> {
  const websiteDomain = extractDomainFromWebsite(extractedWebsite);
  const existingPartnerDomain = extractDomainFromWebsite(partnerWebsite);

  // Case 1: extractedWebsite is available (HIGH CONFIDENCE)
  if (websiteDomain) {
    // If gmailSenderDomain matches extractedWebsite, learn the website domain
    if (gmailSenderDomain && domainsMatchForLearning(gmailSenderDomain, websiteDomain)) {
      return {
        shouldLearn: true,
        domainToLearn: websiteDomain,
        reason: `Email domain matches extracted website: ${websiteDomain}`,
      };
    }

    // If gmailSenderDomain differs from extractedWebsite, prefer the website domain
    // and skip the email domain (likely a payment processor)
    if (gmailSenderDomain && !domainsMatchForLearning(gmailSenderDomain, websiteDomain)) {
      console.log(
        `[DomainLearning] Email domain "${gmailSenderDomain}" differs from extracted website ` +
        `"${websiteDomain}" - learning website domain, skipping email domain`
      );
      return {
        shouldLearn: true,
        domainToLearn: websiteDomain,
        reason: `Preferring extracted website over email domain (${gmailSenderDomain} -> ${websiteDomain})`,
      };
    }

    // Only extractedWebsite, no gmailSenderDomain
    return {
      shouldLearn: true,
      domainToLearn: websiteDomain,
      reason: `Using extracted website domain: ${websiteDomain}`,
    };
  }

  // Case 2: No extractedWebsite, only gmailSenderDomain available
  if (!gmailSenderDomain) {
    return {
      shouldLearn: false,
      domainToLearn: null,
      reason: "No domain available to learn",
    };
  }

  // Case 2a: gmailSenderDomain matches partner's existing website
  if (existingPartnerDomain && domainsMatchForLearning(gmailSenderDomain, existingPartnerDomain)) {
    return {
      shouldLearn: true,
      domainToLearn: gmailSenderDomain,
      reason: `Email domain matches partner website: ${existingPartnerDomain}`,
    };
  }

  // Case 2b: Use Gemini to validate if email domain belongs to the company
  console.log(
    `[DomainLearning] Validating via Gemini: does "${gmailSenderDomain}" belong to "${partnerName}"?`
  );

  try {
    const validation = await geminiValidateDomainOwnership(
      gmailSenderDomain,
      partnerName,
      userId
    );

    if (validation.isOwner && validation.confidence >= 70) {
      return {
        shouldLearn: true,
        domainToLearn: gmailSenderDomain,
        reason: `Gemini validated (${validation.confidence}%): ${validation.reason}`,
      };
    }

    return {
      shouldLearn: false,
      domainToLearn: null,
      reason: `Gemini rejected: ${validation.reason}`,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[DomainLearning] Gemini validation failed:`, errorMsg);
    // Conservative: don't learn on error
    return {
      shouldLearn: false,
      domainToLearn: null,
      reason: `Validation error: ${errorMsg}`,
    };
  }
}

/**
 * Learn email domain from Gmail file when matched to a partner.
 * This enables future matching: files from known domains get a confidence boost.
 *
 * Smart validation ensures we don't learn payment processor domains (stripe.com, paypal.com)
 * as belonging to merchants. Prefers extractedWebsite when available.
 */
async function learnEmailDomainFromPartnerMatch(
  fileData: FirebaseFirestore.DocumentData,
  partnerId: string,
  partnerName: string,
  partnerWebsite: string | null
): Promise<void> {
  const gmailSenderDomain = fileData.gmailSenderDomain?.toLowerCase().trim() || null;
  const extractedWebsite = fileData.extractedWebsite;
  const userId = fileData.userId;

  // Skip if no domain data available at all
  if (!gmailSenderDomain && !extractedWebsite) {
    return;
  }

  // Validate which domain (if any) should be learned
  const decision = await validateDomainForLearning(
    gmailSenderDomain,
    extractedWebsite,
    partnerName,
    partnerWebsite,
    userId
  );

  if (!decision.shouldLearn || !decision.domainToLearn) {
    console.log(
      `[PartnerMatch] Skipping domain learning for partner ${partnerId}: ${decision.reason}`
    );
    return;
  }

  const domainToLearn = decision.domainToLearn;

  // Get partner and check if domain already known
  const partnerDoc = await db.collection("partners").doc(partnerId).get();
  if (!partnerDoc.exists) {
    return;
  }

  const partnerData = partnerDoc.data()!;
  const existingDomains: string[] = partnerData.emailDomains || [];

  if (existingDomains.includes(domainToLearn)) {
    return; // Already known
  }

  // Add domain to partner
  await partnerDoc.ref.update({
    emailDomains: FieldValue.arrayUnion(domainToLearn),
    emailDomainsUpdatedAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  console.log(
    `[PartnerMatch] Learned email domain "${domainToLearn}" for partner ${partnerId} ` +
    `(${partnerName}) from file ${fileData.fileName}. Reason: ${decision.reason}`
  );
}

/**
 * Mark partner matching as complete on a file
 */
async function markPartnerMatchComplete(
  fileId: string,
  partnerId: string | null,
  partnerType: "user" | "global" | null,
  matchedBy: "auto" | "suggestion" | null,
  confidence: number | null,
  suggestions: PartnerSuggestion[]
): Promise<void> {
  // Check if file still exists (could have been deleted in race condition)
  const fileDoc = await db.collection("files").doc(fileId).get();
  if (!fileDoc.exists) {
    console.log(`[PartnerMatch] File ${fileId} no longer exists, skipping update`);
    return;
  }

  const update: Record<string, unknown> = {
    partnerMatchComplete: true,
    partnerMatchedAt: Timestamp.now(),
    partnerSuggestions: suggestions.slice(0, CONFIG.MAX_SUGGESTIONS),
    updatedAt: Timestamp.now(),
  };

  if (partnerId) {
    update.partnerId = partnerId;
    update.partnerType = partnerType;
    update.partnerMatchedBy = matchedBy;
    update.partnerMatchConfidence = confidence;
  }

  await db.collection("files").doc(fileId).update(update);

  if (partnerId) {
    const mergedFileData = {
      ...fileDoc.data(),
      partnerId,
      partnerType,
      partnerMatchedBy: matchedBy,
      partnerMatchConfidence: confidence,
    };
    await syncPartnerToConnectedTransactions(fileId, mergedFileData);
  }
}

type PartnerMatchedBy = "manual" | "suggestion" | "auto" | "ai" | null;

/**
 * Resolve partner conflict between file and transaction.
 *
 * Priority (highest to lowest):
 * 1. Manual assignment on transaction (user explicitly chose) - always respected
 * 2. File's partner (actual document with extracted company name)
 * 3. Transaction's auto-matched partner (bank data guessing)
 *
 * The file is the source of truth because it's the actual invoice/receipt
 * with the real company name extracted from the document.
 */
function resolvePartnerConflictForFileSync(
  filePartnerId: string | null | undefined,
  txPartnerId: string | null | undefined,
  txMatchedBy: PartnerMatchedBy
): {
  winnerId: string | null;
  source: "file" | "transaction" | null;
  shouldSync: boolean;
  shouldStoreBankPartner: boolean;
} {
  const filePid = filePartnerId ?? null;
  const txPid = txPartnerId ?? null;
  const txIsManual = txMatchedBy === "manual";

  // Neither has partner
  if (!filePid && !txPid) {
    return { winnerId: null, source: null, shouldSync: false, shouldStoreBankPartner: false };
  }

  // Only file has partner -> sync to transaction
  if (filePid && !txPid) {
    return { winnerId: filePid, source: "file", shouldSync: true, shouldStoreBankPartner: false };
  }

  // Only transaction has partner -> no sync needed (file doesn't override nothing)
  if (txPid && !filePid) {
    return { winnerId: null, source: null, shouldSync: false, shouldStoreBankPartner: false };
  }

  // Both have partners
  // If transaction was manual -> respect it, don't sync
  if (txIsManual) {
    return { winnerId: null, source: null, shouldSync: false, shouldStoreBankPartner: false };
  }

  // File wins - sync file's partner to transaction (store original as bankPartnerId)
  return { winnerId: filePid!, source: "file", shouldSync: true, shouldStoreBankPartner: txPid !== filePid };
}

async function syncPartnerToConnectedTransactions(
  fileId: string,
  fileData: FirebaseFirestore.DocumentData
): Promise<void> {
  if (!fileData.partnerId) return;

  const transactionIds = new Set<string>();

  const connectionsSnap = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .get();

  for (const connection of connectionsSnap.docs) {
    const connectionData = connection.data();
    if (connectionData.transactionId) {
      transactionIds.add(connectionData.transactionId);
    }
  }

  if (Array.isArray(fileData.transactionIds)) {
    for (const txId of fileData.transactionIds) {
      if (typeof txId === "string") {
        transactionIds.add(txId);
      }
    }
  }

  if (transactionIds.size === 0) return;

  const now = Timestamp.now();

  for (const transactionId of transactionIds) {
    if (!transactionId) continue;

    const txRef = db.collection("transactions").doc(transactionId);
    const txDoc = await txRef.get();
    if (!txDoc.exists) continue;

    const txData = txDoc.data()!;
    if (txData.userId !== fileData.userId) continue;

    const resolution = resolvePartnerConflictForFileSync(
      fileData.partnerId,
      txData.partnerId ?? null,
      (txData.partnerMatchedBy as PartnerMatchedBy) ?? null
    );

    if (!resolution.shouldSync) {
      continue;
    }

    const updateData: Record<string, unknown> = {
      partnerId: fileData.partnerId,
      partnerType: fileData.partnerType ?? null,
      partnerMatchedBy: fileData.partnerMatchedBy === "manual" ? "manual" : "auto",
      partnerMatchConfidence: fileData.partnerMatchConfidence ?? null,
      updatedAt: now,
    };

    // Store original transaction partner as bankPartnerId for audit trail
    if (resolution.shouldStoreBankPartner && txData.partnerId) {
      updateData.bankPartnerId = txData.partnerId;
      updateData.bankPartnerType = txData.partnerType ?? null;
      updateData.bankPartnerMatchedBy = txData.partnerMatchedBy ?? null;
      updateData.bankPartnerMatchConfidence = txData.partnerMatchConfidence ?? null;
      console.log(
        `[PartnerMatch] Storing original partner ${txData.partnerId} as bankPartnerId before overwriting`
      );
    }

    await txRef.update(updateData);

    console.log(
      `[PartnerMatch] Synced partner ${fileData.partnerId} from file ${fileId} to transaction ${transactionId}`
    );
  }
}

/**
 * Normalize website URL to domain format
 * e.g., "https://www.amazon.de/something" -> "amazon.de"
 */
function normalizeWebsiteToDomain(website: string | undefined | null): string | null {
  if (!website) return null;

  let domain = website.toLowerCase().trim();

  // Remove protocol
  domain = domain.replace(/^https?:\/\//, "");

  // Remove path and query
  domain = domain.split("/")[0].split("?")[0];

  // Remove www prefix
  domain = domain.replace(/^www\./, "");

  return domain || null;
}

/**
 * LLM-assisted partner deduplication
 * Before creating a new partner, check if any existing partner is likely the same company.
 * Returns the existing partner ID if a match is found, null otherwise.
 */
async function findExistingPartnerWithLLM(
  userId: string,
  companyInfo: CompanyInfo,
  originalExtractedName: string
): Promise<string | null> {
  try {
    // Query existing partners with similar characteristics
    const candidatePartners: Array<{ id: string; name: string; vatId?: string; website?: string; aliases?: string[] }> = [];

    // 1. Search by similar name
    const partnersSnapshot = await db
      .collection("partners")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .limit(50)
      .get();

    // Find candidates with name similarity or matching VAT/website
    const searchName = (companyInfo.name || originalExtractedName).toLowerCase();
    const searchVatId = companyInfo.vatId?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
    const searchWebsite = companyInfo.website?.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").split("/")[0] || null;

    for (const doc of partnersSnapshot.docs) {
      const data = doc.data();
      const partnerName = (data.name || "").toLowerCase();
      const partnerVatId = data.vatId?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
      const partnerWebsite = data.website?.toLowerCase() || null;
      const partnerAliases = (data.aliases || []).map((a: string) => a.toLowerCase());

      // Check for potential matches
      const nameContains = searchName.includes(partnerName) || partnerName.includes(searchName);
      const aliasMatch = partnerAliases.some((a: string) => a.includes(searchName) || searchName.includes(a));
      const vatMatch = searchVatId && partnerVatId && searchVatId === partnerVatId;
      const websiteMatch = searchWebsite && partnerWebsite && searchWebsite.includes(partnerWebsite);

      if (nameContains || aliasMatch || vatMatch || websiteMatch) {
        candidatePartners.push({
          id: doc.id,
          name: data.name,
          vatId: data.vatId,
          website: data.website,
          aliases: data.aliases,
        });
      }
    }

    if (candidatePartners.length === 0) {
      console.log(`[PartnerDedup] No candidate partners found for "${searchName}"`);
      return null;
    }

    console.log(`[PartnerDedup] Found ${candidatePartners.length} candidate partners for "${searchName}"`);

    // 2. Use LLM to verify if any candidate is the same company
    const vertexAI = createVertexAI();
    const model = vertexAI.getGenerativeModel({
      model: "gemini-2.0-flash-lite-001",
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
    });

    const prompt = `Determine if the NEW company matches any EXISTING company (same legal entity).

NEW COMPANY:
- Name: "${companyInfo.name || originalExtractedName}"
- VAT ID: ${companyInfo.vatId || "unknown"}
- Website: ${companyInfo.website || "unknown"}

EXISTING COMPANIES:
${candidatePartners.map((p, i) => `${i + 1}. "${p.name}" (VAT: ${p.vatId || "unknown"}, Website: ${p.website || "unknown"}, Aliases: ${(p.aliases || []).join(", ") || "none"})`).join("\n")}

Respond ONLY with JSON:
{"match": true/false, "matchIndex": 1-based index if match, "reason": "brief explanation"}

Rules:
- Match = same legal entity (not just similar industry)
- "Amazon EU S.a.r.l." matches "Amazon"
- Different subsidiaries (Google LLC vs Alphabet Inc) = NO match
- Similar names but different companies = NO match`;

    const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const responseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    // Parse response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.match && parsed.matchIndex >= 1 && parsed.matchIndex <= candidatePartners.length) {
        const matchedPartner = candidatePartners[parsed.matchIndex - 1];
        console.log(`[PartnerDedup] LLM matched "${companyInfo.name}" to existing partner "${matchedPartner.name}" (${matchedPartner.id}): ${parsed.reason}`);
        return matchedPartner.id;
      }
    }

    console.log(`[PartnerDedup] LLM found no match for "${companyInfo.name}"`);
    return null;
  } catch (error) {
    console.error(`[PartnerDedup] LLM dedup failed, proceeding with creation:`, error);
    return null;
  }
}

/**
 * Create a user partner from company lookup results
 */
async function createUserPartnerFromLookup(
  userId: string,
  companyInfo: CompanyInfo,
  originalExtractedName: string,
  options?: { viesVerified?: boolean }
): Promise<string> {
  // === LLM-ASSISTED DEDUPLICATION ===
  // Before creating, check if this company already exists as a partner
  const existingPartnerId = await findExistingPartnerWithLLM(userId, companyInfo, originalExtractedName);

  if (existingPartnerId) {
    // Add the extracted name as an alias to the existing partner
    const partnerRef = db.collection("partners").doc(existingPartnerId);
    const partnerSnap = await partnerRef.get();
    if (partnerSnap.exists) {
      const existingAliases: string[] = partnerSnap.data()?.aliases || [];
      const normalizedExtracted = originalExtractedName.toLowerCase().trim();

      if (!existingAliases.some(a => a.toLowerCase().trim() === normalizedExtracted)) {
        await partnerRef.update({
          aliases: FieldValue.arrayUnion(originalExtractedName),
          updatedAt: Timestamp.now(),
        });
        console.log(`[PartnerDedup] Added alias "${originalExtractedName}" to existing partner ${existingPartnerId}`);
      }
    }

    return existingPartnerId;
  }
  // Normalize website to domain format (e.g., "amazon.de" not "https://www.amazon.de")
  const normalizedWebsite = normalizeWebsiteToDomain(companyInfo.website);

  // Build aliases array - include original extracted name if different from official name
  const aliases: string[] = [...(companyInfo.aliases || [])];
  const officialName = companyInfo.name || originalExtractedName;

  // Add original extracted name as alias if it's different from the official name
  // This ensures future invoices with the same extracted name will match
  if (originalExtractedName && originalExtractedName.toLowerCase() !== officialName.toLowerCase()) {
    // Check if not already in aliases
    const normalizedOriginal = originalExtractedName.toLowerCase().trim();
    if (!aliases.some(a => a.toLowerCase().trim() === normalizedOriginal)) {
      aliases.push(originalExtractedName);
    }
  }

  const partnerData: Record<string, unknown> = {
    userId,
    name: officialName,
    aliases,
    website: normalizedWebsite,
    vatId: companyInfo.vatId || null,
    country: companyInfo.country || null,
    ibans: [],
    address: companyInfo.address || null,
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    // Track that this was auto-created
    createdBy: "auto_partner_match",
    createdFromExtracted: originalExtractedName,
    // Track VIES verification
    ...(options?.viesVerified && {
      viesVerified: true,
      viesVerifiedAt: Timestamp.now(),
    }),
  };

  const docRef = await db.collection("partners").add(partnerData);
  console.log(`[PartnerMatch] Created new partner ${docRef.id} from lookup for "${originalExtractedName}"`);
  return docRef.id;
}

// === Agentic Fallback ===

interface FileDataForAgenticSearch {
  fileName?: string;
  extractedPartner?: string;
  extractedAmount?: number;
  extractedDate?: string;
  extractedVatId?: string | null;
  gmailSenderDomain?: string | null;
}

/**
 * Queue agentic partner search for a file when rule-based matching fails.
 * Creates a worker request that the frontend will process.
 */
async function queueAgenticPartnerSearchForFile(
  userId: string,
  fileId: string,
  fileData: FileDataForAgenticSearch,
  topSuggestionConfidence: number
): Promise<void> {
  const promptParts = [
    `Find partner for file "${fileData.fileName || fileId}"`,
  ];

  if (fileData.extractedPartner) {
    promptParts.push(`Extracted partner name: ${fileData.extractedPartner}`);
  }

  if (topSuggestionConfidence > 0) {
    promptParts.push(`Rule-based matching found suggestions but no confident match (top: ${topSuggestionConfidence}%)`);
  } else {
    promptParts.push(`Rule-based matching found no suggestions`);
  }

  if (fileData.extractedAmount) {
    promptParts.push(`Amount: ${(fileData.extractedAmount / 100).toFixed(2)} EUR`);
  }
  if (fileData.extractedDate) {
    promptParts.push(`Date: ${fileData.extractedDate}`);
  }
  if (fileData.extractedVatId) {
    promptParts.push(`VAT ID: ${fileData.extractedVatId}`);
  }
  if (fileData.gmailSenderDomain) {
    promptParts.push(`Email domain: ${fileData.gmailSenderDomain}`);
  }

  const initialPrompt = promptParts.join(". ");

  // Create worker request for frontend/worker processor to pick up
  const requestRef = db.collection(`users/${userId}/workerRequests`).doc();
  await requestRef.set({
    id: requestRef.id,
    workerType: "file_partner_matching",
    initialPrompt,
    triggerContext: { fileId },
    triggeredBy: "auto",
    status: "pending",
    createdAt: Timestamp.now(),
  });

  console.log(
    `[PartnerMatch] Queued agentic partner search for file ${fileId} (worker request: ${requestRef.id})`
  );
}

// === Main Matching Logic ===

export async function runPartnerMatching(
  fileId: string,
  fileData: FirebaseFirestore.DocumentData
): Promise<void> {
  const userId = fileData.userId;
  const extractedPartner = fileData.extractedPartner;
  let extractedIban = fileData.extractedIban;
  let extractedVatId = fileData.extractedVatId;
  const gmailSenderEmail = fileData.gmailSenderEmail; // Full email for user detection
  let gmailSenderDomain = fileData.gmailSenderDomain; // Domain for partner matching

  // Fetch user data, source IBANs, and email integrations in parallel
  const [userDataDoc, sourcesSnapshot, integrationsSnapshot] = await Promise.all([
    db.doc(`users/${userId}/settings/userData`).get(),
    db.collection("sources").where("userId", "==", userId).where("isActive", "==", true).get(),
    db.collection("emailIntegrations").where("userId", "==", userId).where("isActive", "==", true).get(),
  ]);

  const userData: UserData | null = userDataDoc.exists ? (userDataDoc.data() as UserData) : null;
  const sourceIbans: string[] = sourcesSnapshot.docs
    .map((doc) => doc.data().iban as string | undefined)
    .filter((iban): iban is string => !!iban);

  // Extract full emails from connected email integrations (auto-detected user emails)
  const integrationEmails: string[] = integrationsSnapshot.docs
    .map((doc) => doc.data().email as string | undefined)
    .filter((e): e is string => !!e)
    .map((e) => e.toLowerCase());

  // Check if extracted VAT ID belongs to the user (their own company)
  if (extractedVatId && isUserVatId(extractedVatId, userData)) {
    console.log(`[PartnerMatch] Extracted VAT ID "${extractedVatId}" belongs to user, ignoring for partner match`);
    extractedVatId = null; // Don't use user's own VAT for partner matching
  }

  // Check if extracted IBAN belongs to the user (their own bank account)
  if (extractedIban && isUserIban(extractedIban, userData, sourceIbans)) {
    console.log(`[PartnerMatch] Extracted IBAN "${extractedIban}" belongs to user, ignoring for partner match`);
    extractedIban = null; // Don't use user's own IBAN for partner matching
  }

  // Check if Gmail sender email belongs to the user (their own email account)
  // Uses full email matching to avoid false positives with common domains like gmail.com
  if (gmailSenderEmail && isUserEmail(gmailSenderEmail, userData, integrationEmails)) {
    console.log(`[PartnerMatch] Gmail sender email "${gmailSenderEmail}" belongs to user, ignoring for partner match`);
    gmailSenderDomain = null; // Don't use sender domain for partner matching
  }

  // Skip if no data to match on (include gmailSenderDomain as matchable data)
  if (!extractedPartner && !extractedIban && !extractedVatId && !gmailSenderDomain) {
    console.log(`[PartnerMatch] No matching data for file ${fileId}, skipping`);
    await markPartnerMatchComplete(fileId, null, null, null, null, []);
    return;
  }

  // Check if company name is valid (has legal suffix)
  const hasValidCompanyName = extractedPartner && isValidCompanyName(extractedPartner);
  console.log(
    `[PartnerMatch] File ${fileId}: extractedPartner="${extractedPartner}", ` +
    `isValidCompany=${hasValidCompanyName}, hasIban=${!!extractedIban}, hasVatId=${!!extractedVatId}, ` +
    `gmailDomain=${gmailSenderDomain || "none"}`
  );

  // Fetch user and global partners
  const [userPartnersSnapshot, globalPartnersSnapshot] = await Promise.all([
    db.collection("partners")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .get(),
    db.collection("globalPartners")
      .where("isActive", "==", true)
      .get(),
  ]);

  const userPartners: PartnerData[] = userPartnersSnapshot.docs.map((doc) => ({
    id: doc.id,
    name: doc.data().name,
    aliases: doc.data().aliases || [],
    ibans: doc.data().ibans || [],
    vatId: doc.data().vatId,
    website: doc.data().website || null,
    emailDomains: doc.data().emailDomains || [],
    globalPartnerId: doc.data().globalPartnerId || null,
  }));

  const globalPartners: PartnerData[] = globalPartnersSnapshot.docs.map((doc) => ({
    id: doc.id,
    name: doc.data().name,
    aliases: doc.data().aliases || [],
    ibans: doc.data().ibans || [],
    vatId: doc.data().vatId,
    website: doc.data().website || null,
    emailDomains: doc.data().emailDomains || [],
  }));
  const localizedGlobalIds = new Set(
    userPartnersSnapshot.docs
      .map((doc) => doc.data().globalPartnerId)
      .filter(Boolean) as string[]
  );
  const filteredGlobalPartners = globalPartners.filter(
    (partner) => !localizedGlobalIds.has(partner.id)
  );

  console.log(
    `[PartnerMatch] Searching ${userPartners.length} user partners and ${filteredGlobalPartners.length} global partners`
  );

  // === Check for existing partner with matching VAT ID first ===
  // Before calling VIES, check if we already have a partner with this VAT ID
  if (extractedVatId) {
    const normalizedExtractedVat = extractedVatId.toUpperCase().replace(/[^A-Z0-9]/g, "");

    // Check user partners first
    const existingUserPartner = userPartners.find((p) => {
      if (!p.vatId) return false;
      const normalizedPartnerVat = p.vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
      return normalizedPartnerVat === normalizedExtractedVat;
    });

    if (existingUserPartner) {
      console.log(
        `[PartnerMatch] Found existing user partner "${existingUserPartner.name}" with matching VAT ID`
      );
      await markPartnerMatchComplete(
        fileId,
        existingUserPartner.id,
        "user",
        "auto",
        95, // VAT ID match confidence
        []
      );
      // Learn extracted name as alias and email domain (non-blocking)
      learnPartnerAlias(existingUserPartner.id, extractedPartner).catch(console.error);
      learnEmailDomainFromPartnerMatch(
        fileData,
        existingUserPartner.id,
        existingUserPartner.name,
        existingUserPartner.website || null
      ).catch(console.error);
      return;
    }

    // Check global partners
    const existingGlobalPartner = filteredGlobalPartners.find((p) => {
      if (!p.vatId) return false;
      const normalizedPartnerVat = p.vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
      return normalizedPartnerVat === normalizedExtractedVat;
    });

    if (existingGlobalPartner) {
      console.log(
        `[PartnerMatch] Found existing global partner "${existingGlobalPartner.name}" with matching VAT ID, creating local copy`
      );
      const localPartnerId = await createLocalPartnerFromGlobal(userId, existingGlobalPartner.id);
      await markPartnerMatchComplete(fileId, localPartnerId, "user", "auto", 95, []);
      // Learn extracted name as alias and email domain (non-blocking)
      learnPartnerAlias(localPartnerId, extractedPartner).catch(console.error);
      learnEmailDomainFromPartnerMatch(
        fileData,
        localPartnerId,
        existingGlobalPartner.name,
        existingGlobalPartner.website || null
      ).catch(console.error);
      return;
    }
  }

  // === VIES VAT Lookup (for NEW partners only) ===
  // Only call VIES if no existing partner has this VAT ID
  if (extractedVatId) {
    console.log(`[PartnerMatch] No existing partner with VAT ID "${extractedVatId}", trying VIES lookup`);

    try {
      const parsed = parseVatId(extractedVatId);
      if (parsed) {
        const viesResult = await queryViesApi(parsed.countryCode, parsed.vatNumber);

        if (!("code" in viesResult) && viesResult.valid && viesResult.name) {
          // VIES returned valid + company data - create new partner
          console.log(`[PartnerMatch] VIES returned valid company: "${viesResult.name}"`);

          const companyInfo: CompanyInfo = {
            name: viesResult.name,
            vatId: `${parsed.countryCode}${parsed.vatNumber}`,
            country: parsed.countryCode,
            address: viesResult.address
              ? parseViesAddress(viesResult.address, parsed.countryCode)
              : undefined,
          };

          const newPartnerId = await createUserPartnerFromLookup(
            userId,
            companyInfo,
            extractedPartner || viesResult.name,
            { viesVerified: true }
          );

          await markPartnerMatchComplete(
            fileId,
            newPartnerId,
            "user",
            "auto",
            98, // Very high confidence for VIES-verified match
            []
          );

          // Learn email domain from Gmail files (non-blocking)
          learnEmailDomainFromPartnerMatch(
            fileData,
            newPartnerId,
            viesResult.name,
            null // VIES doesn't provide website
          ).catch((err) => {
            console.error(`[PartnerMatch] Failed to learn email domain:`, err);
          });

          return; // Done - VIES match is authoritative
        } else if ("code" in viesResult) {
          console.log(
            `[PartnerMatch] VIES API error: ${viesResult.code} - ${viesResult.message}, falling back to other methods`
          );
        } else if (!viesResult.valid) {
          console.log(`[PartnerMatch] VIES says VAT ID is invalid, falling back to other methods`);
        } else {
          // valid: true but no name - fall through to other methods
          console.log(`[PartnerMatch] VIES valid but no company data, falling back to other methods`);
        }
      }
    } catch (error) {
      console.error("[PartnerMatch] VIES lookup failed:", error);
      // Continue with existing matching methods
    }
  }

  // Match against all partners
    const matches = matchFileToAllPartners(
      {
        extractedIban,
        extractedVatId,
        extractedPartner,
        extractedWebsite: fileData.extractedWebsite,
        gmailSenderDomain,
      },
      userPartners,
      filteredGlobalPartners
    );

  // Build suggestions for storage
  const suggestions: PartnerSuggestion[] = matches.slice(0, CONFIG.MAX_SUGGESTIONS).map((m) => ({
    partnerId: m.partnerId,
    partnerType: m.partnerType,
    confidence: m.confidence,
    source: m.source,
  }));

  // Check for high-confidence match
  const topMatch = matches[0];

  if (topMatch && shouldAutoApply(topMatch.confidence)) {
    console.log(
      `[PartnerMatch] Auto-assigning ${topMatch.partnerType} partner ${topMatch.partnerId} ` +
      `to file ${fileId} (confidence: ${topMatch.confidence}%, source: ${topMatch.source})`
    );

    let assignedPartnerId = topMatch.partnerId;
    let assignedPartnerType: "user" | "global" = topMatch.partnerType;

    // If global partner, create local copy first
    if (topMatch.partnerType === "global") {
      try {
        assignedPartnerId = await createLocalPartnerFromGlobal(userId, topMatch.partnerId);
        assignedPartnerType = "user";
      } catch (error) {
        console.error(`[PartnerMatch] Failed to create local partner from global:`, error);
        // Fall back to using global partner directly
      }
    }

    await markPartnerMatchComplete(
      fileId,
      assignedPartnerId,
      assignedPartnerType,
      "auto",
      topMatch.confidence,
      suggestions
    );

    // Learn extracted name as alias and email domain (non-blocking)
    if (assignedPartnerType === "user") {
      learnPartnerAlias(assignedPartnerId, extractedPartner).catch((err) => {
        console.error(`[PartnerMatch] Failed to learn alias:`, err);
      });
      // Find the partner data to get website for domain validation
      const matchedPartner = topMatch.partnerType === "user"
        ? userPartners.find((p) => p.id === topMatch.partnerId)
        : filteredGlobalPartners.find((p) => p.id === topMatch.partnerId);
      learnEmailDomainFromPartnerMatch(
        fileData,
        assignedPartnerId,
        topMatch.partnerName,
        matchedPartner?.website || null
      ).catch((err) => {
        console.error(`[PartnerMatch] Failed to learn email domain:`, err);
      });
    }

    return;
  }

  // No high-confidence match - try Gemini lookup if valid company name
  if (hasValidCompanyName) {
    console.log(
      `[PartnerMatch] No match >= ${CONFIG.AUTO_MATCH_THRESHOLD}% for "${extractedPartner}", trying Gemini lookup`
    );

    let geminiLookupSucceeded = false;

    try {
      const vertexAI = createVertexAI();
      const companyInfo = await searchByName(vertexAI, extractedPartner, userId);

      if (companyInfo && companyInfo.name) {
        // Create new User Partner from lookup results
        const newPartnerId = await createUserPartnerFromLookup(userId, companyInfo, extractedPartner);

        await markPartnerMatchComplete(
          fileId,
          newPartnerId,
          "user",
          "auto",
          CONFIG.LOOKUP_CREATED_CONFIDENCE,
          [] // No suggestions since we created a new partner
        );

        // Learn email domain from Gmail files (non-blocking)
        learnEmailDomainFromPartnerMatch(
          fileData,
          newPartnerId,
          companyInfo.name,
          companyInfo.website || null
        ).catch((err) => {
          console.error(`[PartnerMatch] Failed to learn email domain:`, err);
        });

        console.log(
          `[PartnerMatch] Created partner from Gemini lookup: ${companyInfo.name} ` +
          `(vatId: ${companyInfo.vatId || "none"}, website: ${companyInfo.website || "none"})`
        );
        geminiLookupSucceeded = true;
        return;
      } else {
        console.log(`[PartnerMatch] Gemini lookup returned no results for "${extractedPartner}"`);
      }
    } catch (error) {
      console.error(`[PartnerMatch] Gemini lookup failed for "${extractedPartner}":`, error);
    }

    // Fallback: If Gemini lookup failed/returned nothing but we have a valid company name,
    // create a basic partner with just the extracted name. This ensures we don't lose
    // valuable partner info when Gemini can't find additional data.
    if (!geminiLookupSucceeded) {
      console.log(
        `[PartnerMatch] Creating basic partner from extracted name: "${extractedPartner}"`
      );

      const basicCompanyInfo: CompanyInfo = {
        name: extractedPartner,
        // Include extracted data if available
        vatId: extractedVatId || undefined,
        website: fileData.extractedWebsite
          ? normalizeWebsiteToDomain(fileData.extractedWebsite) || undefined
          : undefined,
      };

      const newPartnerId = await createUserPartnerFromLookup(
        userId,
        basicCompanyInfo,
        extractedPartner
      );

      await markPartnerMatchComplete(
        fileId,
        newPartnerId,
        "user",
        "auto",
        85, // Lower confidence since we only have extracted name
        []
      );

      // Learn email domain from Gmail files (non-blocking)
      learnEmailDomainFromPartnerMatch(
        fileData,
        newPartnerId,
        extractedPartner,
        basicCompanyInfo.website || null
      ).catch((err) => {
        console.error(`[PartnerMatch] Failed to learn email domain:`, err);
      });

      console.log(
        `[PartnerMatch] Created basic partner ${newPartnerId} from extracted name: "${extractedPartner}"`
      );
      return;
    }
  }

  // No match found and couldn't create - store suggestions and queue agentic search
  console.log(
    `[PartnerMatch] Partner matching complete for file ${fileId}: ${suggestions.length} suggestions, no auto-match`
  );
  await markPartnerMatchComplete(fileId, null, null, null, null, suggestions);

  // Queue agentic partner search as fallback
  // Only if we have an extracted partner name to search for
  if (extractedPartner) {
    const topConfidence = suggestions.length > 0 ? suggestions[0].confidence : 0;
    try {
      await queueAgenticPartnerSearchForFile(
        userId,
        fileId,
        {
          fileName: fileData.fileName,
          extractedPartner,
          extractedAmount: fileData.extractedAmount,
          extractedDate: fileData.extractedDate?.toDate().toISOString().split("T")[0],
          extractedVatId,
          gmailSenderDomain,
        },
        topConfidence
      );
    } catch (err) {
      console.error(`[PartnerMatch] Failed to queue agentic partner search for file ${fileId}:`, err);
    }
  }
}

// === Firestore Trigger ===

/**
 * Triggered when a file document is updated.
 * Runs partner matching after extraction completes.
 */
export const matchFilePartner = onDocumentUpdated(
  {
    document: "files/{fileId}",
    region: "europe-west1",
    timeoutSeconds: 90, // Longer timeout for Gemini lookup
    memory: "256MiB",
    maxInstances: 5, // Limit concurrency to prevent Gemini/VIES API rate limits
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const fileId = event.params.fileId;

    if (!before || !after) return;

    // Only run when extraction just completed successfully
    const extractionJustCompleted =
      !before.extractionComplete &&
      after.extractionComplete &&
      !after.extractionError;

    // Check if partner was just manually assigned (to learn alias even after extraction)
    const partnerJustManuallyAssigned =
      before.partnerId !== after.partnerId &&
      after.partnerMatchedBy === "manual" &&
      after.partnerId;

    // Learn alias when partner is manually assigned to an already-extracted file
    if (partnerJustManuallyAssigned && after.extractedPartner && after.partnerType === "user") {
      console.log(
        `[PartnerMatch] Manual partner assignment detected for file ${fileId}, learning alias`
      );
      learnPartnerAlias(after.partnerId, after.extractedPartner).catch((err) => {
        console.error(`[PartnerMatch] Failed to learn alias for manual assignment:`, err);
      });
      // Don't return - let normal flow continue if extraction also just completed
    }

    // Skip if partner matching already done
    if (!extractionJustCompleted || after.partnerMatchComplete) {
      if (
        before.partnerId !== after.partnerId &&
        after.partnerId &&
        after.partnerMatchComplete === true &&
        !extractionJustCompleted
      ) {
        await syncPartnerToConnectedTransactions(fileId, after);
      }
      return;
    }

    // Skip "Not Invoice" files - no partner matching needed
    if (after.isNotInvoice === true) {
      console.log(`[PartnerMatch] File ${fileId} is not an invoice, skipping partner matching`);
      await db.collection("files").doc(fileId).update({
        partnerMatchComplete: true,
        partnerMatchedAt: Timestamp.now(),
        partnerSuggestions: [],
        updatedAt: Timestamp.now(),
      });
      return;
    }

    // Skip if partner already manually assigned
    if (after.partnerId && after.partnerMatchedBy === "manual") {
      console.log(`[PartnerMatch] File ${fileId} already has manual partner, skipping`);
      // Still learn the extracted name as alias for manual assignments
      if (after.extractedPartner && after.partnerType === "user") {
        learnPartnerAlias(after.partnerId, after.extractedPartner).catch((err) => {
          console.error(`[PartnerMatch] Failed to learn alias for manual assignment:`, err);
        });
      }
      await db.collection("files").doc(fileId).update({
        partnerMatchComplete: true,
        partnerMatchedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      return;
    }

    console.log(`[PartnerMatch] Starting partner matching for file: ${fileId}`);

    try {
      await runPartnerMatching(fileId, after);
    } catch (error) {
      console.error(`[PartnerMatch] Partner matching failed for file ${fileId}:`, error);
      // Mark as complete anyway to not block transaction matching
      // But first check if file still exists (could have been deleted)
      const fileDoc = await db.collection("files").doc(fileId).get();
      if (fileDoc.exists) {
        await db.collection("files").doc(fileId).update({
          partnerMatchComplete: true,
          partnerMatchedAt: Timestamp.now(),
          partnerSuggestions: [],
          updatedAt: Timestamp.now(),
        });
      } else {
        console.log(`[PartnerMatch] File ${fileId} no longer exists, skipping update`);
      }
    }
  }
);
