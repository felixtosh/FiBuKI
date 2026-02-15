/**
 * Cloud Function: On User Data Update
 *
 * Triggered when user data (settings/userData) is updated.
 *
 * 1. Identity Partner Sync:
 *    For each identity entity (personalEntity + companies[]), automatically
 *    creates/updates "identity partners" that represent the user's own entities.
 *    These partners have identitySourceField set and auto-sync.
 *
 * 2. Invoice Direction Recalculation:
 *    Re-calculates invoice direction and counterparty for files that have
 *    extractedIssuer or extractedRecipient entities.
 *
 * This ensures that when a user adds/changes their:
 * - personalEntity (name, vatId, ibans, aliases)
 * - companies[] (name, vatId, ibans, aliases)
 * - ownEmails
 *
 * All their files are re-evaluated to correctly determine:
 * - Invoice direction (incoming vs outgoing)
 * - Which party is the counterparty (extractedPartner)
 * - Which user account was matched (matchedUserAccount)
 */

import { onDocumentUpdated, onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const db = getFirestore();

// === Configuration ===

const CONFIG = {
  /** Maximum files to process per update */
  MAX_FILES_PER_UPDATE: 500,
  /** Region for the function */
  REGION: "europe-west1",
};

// === Types ===

/** Identity entity (personal or company) */
interface IdentityEntity {
  id: string;
  type: "person" | "company";
  name: string;
  aliases: string[];
  vatId?: string;
  ibans: string[];
  partnerId?: string;
  order: number;
  createdAt: FirebaseFirestore.Timestamp;
}

/** Legacy identity partner ID mapping */
interface IdentityPartnerIds {
  name?: string;
  companyName?: string;
}

/** User data structure (supports both new and legacy formats) */
interface UserData {
  // New format
  personalEntity?: IdentityEntity;
  companies?: IdentityEntity[];

  // Legacy format (deprecated)
  name?: string;
  companyName?: string;
  aliases?: string[];
  vatIds?: string[];
  ibans?: string[];
  identityPartnerIds?: IdentityPartnerIds;
  markedAsMe?: string[];
}

interface ExtractedEntity {
  name: string | null;
  vatId: string | null;
  address: string | null;
  iban: string | null;
  website: string | null;
}

type InvoiceDirection = "incoming" | "outgoing" | "unknown";

interface CounterpartyResult {
  counterparty: ExtractedEntity | null;
  matchedUserAccount: "issuer" | "recipient" | null;
  invoiceDirection: InvoiceDirection;
}

// === Identity Partner Sync ===

type IdentitySourceField = "personalEntity" | `company:${string}`;

/**
 * Sync identity partners for all entities (personalEntity + companies[]).
 * Creates new partners, updates existing ones, and deletes partners for removed companies.
 */
async function syncIdentityPartners(
  userId: string,
  beforeData: FirebaseFirestore.DocumentData,
  afterData: FirebaseFirestore.DocumentData
): Promise<void> {
  const now = Timestamp.now();
  const updates: Record<string, unknown> = {};

  // === Sync Personal Entity ===
  const beforePersonal = beforeData.personalEntity as IdentityEntity | undefined;
  const afterPersonal = afterData.personalEntity as IdentityEntity | undefined;

  if (afterPersonal?.name?.trim()) {
    const personalResult = await syncEntityPartner(
      userId,
      "personalEntity",
      afterPersonal,
      beforePersonal,
      now
    );

    if (personalResult.partnerId && personalResult.partnerId !== afterPersonal.partnerId) {
      updates["personalEntity.partnerId"] = personalResult.partnerId;
    }
  }

  // === Sync Company Entities ===
  const beforeCompanies = (beforeData.companies || []) as IdentityEntity[];
  const afterCompanies = (afterData.companies || []) as IdentityEntity[];

  // Build map of before companies by ID
  const beforeCompanyMap = new Map<string, IdentityEntity>();
  for (const c of beforeCompanies) {
    if (c.id) beforeCompanyMap.set(c.id, c);
  }

  // Sync each after company
  const updatedCompanies: IdentityEntity[] = [];
  for (let i = 0; i < afterCompanies.length; i++) {
    const company = afterCompanies[i];
    if (!company.id) continue;

    const beforeCompany = beforeCompanyMap.get(company.id);
    const sourceField: IdentitySourceField = `company:${company.id}`;

    if (company.name?.trim()) {
      const result = await syncEntityPartner(
        userId,
        sourceField,
        company,
        beforeCompany,
        now
      );

      if (result.partnerId && result.partnerId !== company.partnerId) {
        // Track update to company's partnerId
        updatedCompanies.push({ ...company, partnerId: result.partnerId });
      } else {
        updatedCompanies.push(company);
      }
    } else {
      updatedCompanies.push(company);
    }

    // Remove from before map (processed)
    beforeCompanyMap.delete(company.id);
  }

  // Check for any companies that were updated with new partnerIds
  const companiesNeedUpdate = afterCompanies.some((c, i) =>
    updatedCompanies[i]?.partnerId !== c.partnerId
  );
  if (companiesNeedUpdate) {
    updates["companies"] = updatedCompanies;
  }

  // === Delete Partners for Removed Companies ===
  for (const [companyId, removedCompany] of beforeCompanyMap) {
    if (removedCompany.partnerId) {
      console.log(`[syncIdentityPartners] Company ${companyId} removed, deleting partner ${removedCompany.partnerId}`);
      await deleteIdentityPartner(userId, removedCompany.partnerId);
    }
  }

  // === Apply Updates ===
  if (Object.keys(updates).length > 0) {
    const userDataRef = db.doc(`users/${userId}/settings/userData`);
    await userDataRef.update({
      ...updates,
      updatedAt: now,
    });
    console.log(`[syncIdentityPartners] Updated userData:`, Object.keys(updates));
  }
}

/**
 * Sync a single entity's partner (create, update, or skip).
 */
async function syncEntityPartner(
  userId: string,
  sourceField: IdentitySourceField,
  entity: IdentityEntity,
  beforeEntity: IdentityEntity | undefined,
  now: FirebaseFirestore.Timestamp
): Promise<{ partnerId?: string }> {
  const trimmedName = entity.name?.trim() || "";
  const beforeName = beforeEntity?.name?.trim() || "";
  const existingPartnerId = entity.partnerId;

  // Skip if no name
  if (!trimmedName) {
    return {};
  }

  // Skip if nothing changed (name, vatId, ibans, aliases)
  if (beforeEntity && existingPartnerId) {
    const nameUnchanged = trimmedName === beforeName;
    const vatIdUnchanged = (entity.vatId || "") === (beforeEntity.vatId || "");
    const ibansUnchanged = JSON.stringify(entity.ibans || []) === JSON.stringify(beforeEntity.ibans || []);
    const aliasesUnchanged = JSON.stringify(entity.aliases || []) === JSON.stringify(beforeEntity.aliases || []);

    if (nameUnchanged && vatIdUnchanged && ibansUnchanged && aliasesUnchanged) {
      return { partnerId: existingPartnerId };
    }
  }

  console.log(`[syncIdentityPartners] Entity ${sourceField} changed: "${beforeName}" -> "${trimmedName}"`);

  if (existingPartnerId) {
    // Update existing partner
    const partnerRef = db.collection("partners").doc(existingPartnerId);
    const partnerSnap = await partnerRef.get();

    if (partnerSnap.exists && partnerSnap.data()?.userId === userId) {
      await partnerRef.update({
        name: trimmedName,
        vatId: entity.vatId || null,
        ibans: entity.ibans || [],
        aliases: entity.aliases || [],
        updatedAt: now,
      });
      console.log(`[syncIdentityPartners] Updated partner ${existingPartnerId} for ${sourceField}`);
      return { partnerId: existingPartnerId };
    } else {
      // Partner doesn't exist or wrong user, create new one
      const newPartnerId = await createIdentityPartner(userId, sourceField, entity, now);
      return { partnerId: newPartnerId };
    }
  } else {
    // Create new partner
    const newPartnerId = await createIdentityPartner(userId, sourceField, entity, now);
    return { partnerId: newPartnerId };
  }
}

/**
 * Create a new identity partner from an entity
 */
async function createIdentityPartner(
  userId: string,
  sourceField: IdentitySourceField,
  entity: IdentityEntity,
  now: FirebaseFirestore.Timestamp
): Promise<string> {
  const newPartner: Record<string, unknown> = {
    userId,
    name: entity.name.trim(),
    aliases: entity.aliases || [],
    address: null,
    country: null,
    vatId: entity.vatId || null,
    ibans: entity.ibans || [],
    website: null,
    notes: null,
    defaultCategoryId: null,
    identitySourceField: sourceField,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdBy: "identity_sync",
  };

  const docRef = await db.collection("partners").add(newPartner);
  console.log(`[syncIdentityPartners] Created identity partner ${docRef.id} for ${sourceField}: "${entity.name}"`);
  return docRef.id;
}

/**
 * Delete an identity partner
 */
async function deleteIdentityPartner(
  userId: string,
  partnerId: string
): Promise<void> {
  const partnerRef = db.collection("partners").doc(partnerId);
  const partnerSnap = await partnerRef.get();

  if (partnerSnap.exists && partnerSnap.data()?.userId === userId) {
    await partnerRef.delete();
    console.log(`[syncIdentityPartners] Deleted partner ${partnerId}`);
  }
}

// === Helper Functions ===

/**
 * Get all identity names from user data (personal + companies + legacy fields)
 */
function getAllIdentityNames(userData: UserData): string[] {
  const names: string[] = [];

  // New format: personal entity
  if (userData.personalEntity?.name) {
    names.push(userData.personalEntity.name);
    names.push(...(userData.personalEntity.aliases || []));
  }

  // New format: company entities
  for (const company of userData.companies || []) {
    if (company.name) {
      names.push(company.name);
      names.push(...(company.aliases || []));
    }
  }

  // Backward compatibility: deprecated fields
  if (userData.name) names.push(userData.name);
  if (userData.companyName) names.push(userData.companyName);
  names.push(...(userData.aliases || []));

  return [...new Set(names)].filter(Boolean);
}

/**
 * Get all VAT IDs from user data (personal + companies + legacy fields)
 */
function getAllIdentityVatIds(userData: UserData): string[] {
  const vatIds: string[] = [];

  // New format
  if (userData.personalEntity?.vatId) {
    vatIds.push(userData.personalEntity.vatId);
  }
  for (const company of userData.companies || []) {
    if (company.vatId) {
      vatIds.push(company.vatId);
    }
  }

  // Backward compatibility
  vatIds.push(...(userData.vatIds || []));

  return [...new Set(vatIds)].filter(Boolean);
}

/**
 * Get all IBANs from user data (personal + companies + legacy fields)
 */
function getAllIdentityIbans(userData: UserData): string[] {
  const ibans: string[] = [];

  // New format
  if (userData.personalEntity?.ibans) {
    ibans.push(...userData.personalEntity.ibans);
  }
  for (const company of userData.companies || []) {
    ibans.push(...(company.ibans || []));
  }

  // Backward compatibility
  ibans.push(...(userData.ibans || []));

  return [...new Set(ibans)].filter(Boolean);
}

/**
 * Check if identity entities changed
 */
function hasIdentityEntitiesChanged(
  before: FirebaseFirestore.DocumentData,
  after: FirebaseFirestore.DocumentData
): boolean {
  // Check personal entity
  const beforePersonal = before.personalEntity as IdentityEntity | undefined;
  const afterPersonal = after.personalEntity as IdentityEntity | undefined;

  if (JSON.stringify(beforePersonal || {}) !== JSON.stringify(afterPersonal || {})) {
    return true;
  }

  // Check companies
  const beforeCompanies = (before.companies || []) as IdentityEntity[];
  const afterCompanies = (after.companies || []) as IdentityEntity[];

  if (JSON.stringify(beforeCompanies) !== JSON.stringify(afterCompanies)) {
    return true;
  }

  return false;
}

/**
 * Check if user data matching-relevant fields changed (supports both new and legacy formats)
 */
function hasMatchingFieldsChanged(
  before: FirebaseFirestore.DocumentData,
  after: FirebaseFirestore.DocumentData
): boolean {
  // New format: check identity entities
  if (hasIdentityEntitiesChanged(before, after)) return true;

  // Legacy format: Name changed
  if (before.name !== after.name) return true;

  // Legacy format: Company name changed
  if (before.companyName !== after.companyName) return true;

  // Legacy format: Aliases changed
  if (JSON.stringify(before.aliases || []) !== JSON.stringify(after.aliases || [])) return true;

  // Legacy format: VAT IDs changed
  if (JSON.stringify(before.vatIds || []) !== JSON.stringify(after.vatIds || [])) return true;

  // Legacy format: IBANs changed
  if (JSON.stringify(before.ibans || []) !== JSON.stringify(after.ibans || [])) return true;

  // Own emails changed
  if (JSON.stringify(before.ownEmails || []) !== JSON.stringify(after.ownEmails || [])) return true;

  return false;
}

/**
 * Fetch IBANs from user's connected bank accounts (sources)
 */
async function getSourceIbans(userId: string): Promise<string[]> {
  try {
    const sourcesSnapshot = await db
      .collection("sources")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .get();

    return sourcesSnapshot.docs
      .map((doc) => doc.data().iban as string | undefined)
      .filter((iban): iban is string => !!iban)
      .map((iban) => iban.toUpperCase().replace(/\s/g, ""));
  } catch (error) {
    console.warn("[SourceIbans] Failed to fetch source IBANs:", error);
    return [];
  }
}

/**
 * Check if an entity matches user data (by VAT ID, IBAN, or name/aliases).
 * Checks ALL identity entities (personal + companies + legacy fields).
 */
function entityMatchesUserData(
  entity: ExtractedEntity | null,
  userData: UserData,
  sourceIbans: string[]
): boolean {
  if (!entity) return false;

  // Get all user identity data
  const allVatIds = getAllIdentityVatIds(userData);
  const allIbans = getAllIdentityIbans(userData);
  const allNames = getAllIdentityNames(userData);

  // Check VAT ID match (strongest signal)
  if (entity.vatId && allVatIds.length > 0) {
    const normalizedEntityVat = entity.vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
    for (const userVat of allVatIds) {
      if (userVat.toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedEntityVat) {
        return true;
      }
    }
  }

  // Check IBAN match against user's identity IBANs
  if (entity.iban && allIbans.length > 0) {
    const normalizedEntityIban = entity.iban.toUpperCase().replace(/\s/g, "");
    for (const userIban of allIbans) {
      if (userIban.toUpperCase().replace(/\s/g, "") === normalizedEntityIban) {
        return true;
      }
    }
  }

  // Check IBAN match against connected bank account IBANs
  if (entity.iban && sourceIbans.length > 0) {
    const normalizedEntityIban = entity.iban.toUpperCase().replace(/\s/g, "");
    for (const sourceIban of sourceIbans) {
      if (sourceIban === normalizedEntityIban) {
        return true;
      }
    }
  }

  // Check name match (weakest signal)
  if (entity.name && allNames.length > 0) {
    const entityNameLower = entity.name.toLowerCase().trim();

    for (const name of allNames) {
      if (name) {
        const nameLower = name.toLowerCase();
        if (entityNameLower.includes(nameLower) || nameLower.includes(entityNameLower)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Determine the counterparty from extracted entities.
 */
function determineCounterparty(
  issuer: ExtractedEntity | null,
  recipient: ExtractedEntity | null,
  userData: UserData,
  sourceIbans: string[]
): CounterpartyResult {
  // Check if issuer matches user data
  const issuerMatchesUser = entityMatchesUserData(issuer, userData, sourceIbans);

  // Check if recipient matches user data
  const recipientMatchesUser = entityMatchesUserData(recipient, userData, sourceIbans);

  if (issuerMatchesUser && !recipientMatchesUser) {
    // User is the issuer → outgoing invoice → recipient is counterparty
    return {
      counterparty: recipient,
      matchedUserAccount: "issuer",
      invoiceDirection: "outgoing",
    };
  }

  if (recipientMatchesUser && !issuerMatchesUser) {
    // User is the recipient → incoming invoice → issuer is counterparty
    return {
      counterparty: issuer,
      matchedUserAccount: "recipient",
      invoiceDirection: "incoming",
    };
  }

  if (issuerMatchesUser && recipientMatchesUser) {
    // Both match - internal transfer/self-invoice
    return {
      counterparty: recipient,
      matchedUserAccount: "issuer",
      invoiceDirection: "outgoing",
    };
  }

  // Neither matches - default to issuer
  return {
    counterparty: issuer,
    matchedUserAccount: null,
    invoiceDirection: "unknown",
  };
}

// === Main Function ===

export const onUserDataUpdate = onDocumentUpdated(
  {
    document: "users/{userId}/settings/userData",
    region: CONFIG.REGION,
    memory: "512MiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    const userId = event.params.userId;
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();

    if (!beforeData || !afterData) {
      console.log(`[onUserDataUpdate] No data for user ${userId}`);
      return;
    }

    // Sync identity partners if any identity entity changed
    const identityChanged = hasIdentityEntitiesChanged(beforeData, afterData);
    // Also check legacy fields for backward compatibility
    const nameChanged = beforeData.name !== afterData.name;
    const companyNameChanged = beforeData.companyName !== afterData.companyName;

    if (identityChanged || nameChanged || companyNameChanged) {
      console.log(`[onUserDataUpdate] Identity fields changed for ${userId}, syncing partners...`);
      await syncIdentityPartners(userId, beforeData, afterData);
    }

    // Check if matching-relevant fields changed
    if (!hasMatchingFieldsChanged(beforeData, afterData)) {
      console.log(`[onUserDataUpdate] No matching-relevant fields changed for user ${userId}`);
      return;
    }

    console.log(`[onUserDataUpdate] User data changed for ${userId}, re-calculating files...`);

    const userData = afterData as UserData;

    // Fetch source IBANs
    const sourceIbans = await getSourceIbans(userId);
    console.log(`[onUserDataUpdate] Found ${sourceIbans.length} source IBANs`);

    // Find files that have extracted entities
    // Note: We query all extracted files and filter isNotInvoice client-side
    // because isNotInvoice can be false, null, or undefined (undefined = not an invoice marker)
    const filesSnapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("extractionComplete", "==", true)
      .limit(CONFIG.MAX_FILES_PER_UPDATE)
      .get();

    // Filter out files marked as not invoice (client-side filter)
    const invoiceFiles = filesSnapshot.docs.filter((doc) => {
      const data = doc.data();
      return data.isNotInvoice !== true; // Include false, null, undefined
    });

    console.log(`[onUserDataUpdate] Found ${invoiceFiles.length} invoice files to check (${filesSnapshot.size - invoiceFiles.length} non-invoices skipped)`);

    let updatedCount = 0;
    let skippedCount = 0;

    // Process files in batches
    const batch = db.batch();
    const MAX_BATCH_SIZE = 500;
    let batchCount = 0;

    for (const fileDoc of invoiceFiles) {
      const fileData = fileDoc.data();

      // Skip files without extracted entities (can't re-calculate)
      const issuer = fileData.extractedIssuer as ExtractedEntity | null;
      const recipient = fileData.extractedRecipient as ExtractedEntity | null;

      if (!issuer && !recipient) {
        skippedCount++;
        continue;
      }

      // Determine new counterparty
      const result = determineCounterparty(issuer, recipient, userData, sourceIbans);

      // Check if anything changed
      const currentDirection = fileData.invoiceDirection as InvoiceDirection;
      const currentMatchedAccount = fileData.matchedUserAccount as "issuer" | "recipient" | null;
      const currentPartner = fileData.extractedPartner as string | null;

      if (
        result.invoiceDirection === currentDirection &&
        result.matchedUserAccount === currentMatchedAccount &&
        result.counterparty?.name === currentPartner
      ) {
        skippedCount++;
        continue;
      }

      // Update file
      const updateData: Record<string, unknown> = {
        invoiceDirection: result.invoiceDirection,
        matchedUserAccount: result.matchedUserAccount,
        updatedAt: Timestamp.now(),
      };

      // Update partner fields from counterparty
      if (result.counterparty) {
        updateData.extractedPartner = result.counterparty.name;
        updateData.extractedVatId = result.counterparty.vatId;
        updateData.extractedIban = result.counterparty.iban;
        updateData.extractedAddress = result.counterparty.address;
        updateData.extractedWebsite = result.counterparty.website;
      }

      // If extractedPartner changed, reset partner matching so it re-runs
      if (result.counterparty?.name !== currentPartner) {
        updateData.partnerMatchComplete = false;
        updateData.partnerId = null;
        updateData.partnerMatchedBy = null;
        updateData.partnerMatchConfidence = null;
        updateData.partnerSuggestions = [];
      }

      batch.update(fileDoc.ref, updateData);
      updatedCount++;
      batchCount++;

      // Commit batch if full
      if (batchCount >= MAX_BATCH_SIZE) {
        await batch.commit();
        batchCount = 0;
      }
    }

    // Commit remaining updates
    if (batchCount > 0) {
      await batch.commit();
    }

    console.log(
      `[onUserDataUpdate] Complete: updated ${updatedCount} files, skipped ${skippedCount} files`
    );
  }
);

// === On User Data Created ===

/**
 * Triggered when user data document is first created.
 * Creates identity partners for all entities (personalEntity + companies).
 */
export const onUserDataCreated = onDocumentCreated(
  {
    document: "users/{userId}/settings/userData",
    region: CONFIG.REGION,
  },
  async (event) => {
    const userId = event.params.userId;
    const data = event.data?.data();

    if (!data) {
      console.log(`[onUserDataCreated] No data for user ${userId}`);
      return;
    }

    const now = Timestamp.now();
    const updates: Record<string, unknown> = {};

    // Create partner for personal entity
    const personalEntity = data.personalEntity as IdentityEntity | undefined;
    if (personalEntity?.name?.trim()) {
      const partnerId = await createIdentityPartner(userId, "personalEntity", personalEntity, now);
      updates["personalEntity.partnerId"] = partnerId;
      console.log(`[onUserDataCreated] Created personal entity partner: ${partnerId}`);
    }

    // Create partners for companies
    const companies = (data.companies || []) as IdentityEntity[];
    const updatedCompanies: IdentityEntity[] = [];
    let companiesUpdated = false;

    for (const company of companies) {
      if (company.name?.trim() && !company.partnerId) {
        const partnerId = await createIdentityPartner(
          userId,
          `company:${company.id}`,
          company,
          now
        );
        updatedCompanies.push({ ...company, partnerId });
        companiesUpdated = true;
        console.log(`[onUserDataCreated] Created company partner for ${company.id}: ${partnerId}`);
      } else {
        updatedCompanies.push(company);
      }
    }

    if (companiesUpdated) {
      updates["companies"] = updatedCompanies;
    }

    // === Legacy format support ===
    const name = data.name?.trim() || "";
    const companyName = data.companyName?.trim() || "";
    const identityPartnerIds: IdentityPartnerIds = data.identityPartnerIds || {};
    let legacyUpdated = false;

    // Create name partner if set (legacy)
    if (name && !identityPartnerIds.name) {
      const legacyEntity: IdentityEntity = {
        id: "legacy_name",
        type: "person",
        name,
        aliases: data.aliases || [],
        ibans: data.ibans || [],
        vatId: data.vatIds?.[0],
        order: 0,
        createdAt: now,
      };
      const partnerId = await createIdentityPartner(userId, "personalEntity", legacyEntity, now);
      identityPartnerIds.name = partnerId;
      legacyUpdated = true;
    }

    // Create companyName partner if set (legacy)
    if (companyName && !identityPartnerIds.companyName) {
      const legacyEntity: IdentityEntity = {
        id: "legacy_company",
        type: "company",
        name: companyName,
        aliases: [],
        ibans: [],
        vatId: data.vatIds?.[1],
        order: 0,
        createdAt: now,
      };
      const partnerId = await createIdentityPartner(userId, `company:legacy`, legacyEntity, now);
      identityPartnerIds.companyName = partnerId;
      legacyUpdated = true;
    }

    if (legacyUpdated) {
      updates["identityPartnerIds"] = identityPartnerIds;
    }

    // Apply updates
    if (Object.keys(updates).length > 0) {
      const userDataRef = db.doc(`users/${userId}/settings/userData`);
      await userDataRef.update({
        ...updates,
        updatedAt: now,
      });
      console.log(`[onUserDataCreated] Updated userData with partner IDs:`, Object.keys(updates));
    } else {
      console.log(`[onUserDataCreated] No partners to create for user ${userId}`);
    }
  }
);
