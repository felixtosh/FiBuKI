import { doc, getDoc, setDoc, Timestamp } from "firebase/firestore";
import {
  IdentityEntity,
  IdentityEntityAddress,
  UserData,
  UserDataFormData,
} from "@/types/user-data";
import { OperationsContext } from "./types";

/**
 * Strip empty strings from an address; return undefined if nothing
 * meaningful is left. Firestore doesn't accept undefined fields, so
 * callers omit the whole `address` key when this returns undefined.
 */
function normalizeIdentityAddress(
  raw: IdentityEntityAddress | undefined | null
): IdentityEntityAddress | undefined {
  if (!raw) return undefined;
  const trimmed: IdentityEntityAddress = {};
  if (raw.street?.trim()) trimmed.street = raw.street.trim();
  if (raw.postalCode?.trim()) trimmed.postalCode = raw.postalCode.trim();
  if (raw.city?.trim()) trimmed.city = raw.city.trim();
  if (raw.country?.trim()) trimmed.country = raw.country.trim().toUpperCase();
  return Object.keys(trimmed).length > 0 ? trimmed : undefined;
}

const SETTINGS_COLLECTION = "settings";
const USER_DATA_DOC = "userData";

// ============================================================================
// Helper Functions for Multi-Entity Identity Data
// ============================================================================

/**
 * Get all identity names from all entities (personal + companies)
 * Includes backward compatibility for deprecated fields
 */
export function getAllIdentityNames(userData: UserData | null): string[] {
  if (!userData) return [];

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

  // Deduplicate and filter empty
  return [...new Set(names)].filter(Boolean);
}

/**
 * Get all VAT IDs from all entities
 * Includes backward compatibility for deprecated fields
 */
export function getAllIdentityVatIds(userData: UserData | null): string[] {
  if (!userData) return [];

  const vatIds: string[] = [];

  // New format: personal entity
  if (userData.personalEntity?.vatId) {
    vatIds.push(userData.personalEntity.vatId);
  }

  // New format: company entities
  for (const company of userData.companies || []) {
    if (company.vatId) {
      vatIds.push(company.vatId);
    }
  }

  // Backward compatibility: deprecated fields
  vatIds.push(...(userData.vatIds || []));

  // Deduplicate and filter empty
  return [...new Set(vatIds)].filter(Boolean);
}

/**
 * Get all IBANs from all entities
 * Includes backward compatibility for deprecated fields
 */
export function getAllIdentityIbans(userData: UserData | null): string[] {
  if (!userData) return [];

  const ibans: string[] = [];

  // New format: personal entity
  if (userData.personalEntity?.ibans) {
    ibans.push(...userData.personalEntity.ibans);
  }

  // New format: company entities
  for (const company of userData.companies || []) {
    ibans.push(...(company.ibans || []));
  }

  // Backward compatibility: deprecated fields
  ibans.push(...(userData.ibans || []));

  // Deduplicate and filter empty
  return [...new Set(ibans)].filter(Boolean);
}

/**
 * Check if a partner ID is linked to any identity entity
 */
export function isPartnerLinkedToIdentity(userData: UserData | null, partnerId: string): boolean {
  if (!userData || !partnerId) return false;

  // Check personal entity
  if (userData.personalEntity?.partnerId === partnerId) return true;

  // Check companies
  for (const company of userData.companies || []) {
    if (company.partnerId === partnerId) return true;
  }

  // Backward compatibility
  if (userData.identityPartnerIds?.name === partnerId) return true;
  if (userData.identityPartnerIds?.companyName === partnerId) return true;

  return false;
}

/**
 * Generate a unique ID for entities
 */
export function generateEntityId(): string {
  return `entity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get user data for the current user
 */
export async function getUserData(
  ctx: OperationsContext
): Promise<UserData | null> {
  const docRef = doc(ctx.db, "users", ctx.userId, SETTINGS_COLLECTION, USER_DATA_DOC);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.data() as UserData;
}

/**
 * Create or update user data for the current user.
 * Supports both new format (personalEntity + companies) and legacy format.
 */
export async function saveUserData(
  ctx: OperationsContext,
  data: UserDataFormData
): Promise<void> {
  const now = Timestamp.now();
  const docRef = doc(ctx.db, "users", ctx.userId, SETTINGS_COLLECTION, USER_DATA_DOC);

  const existingDoc = await getDoc(docRef);
  const existingData = existingDoc.data();

  // Build user data object
  const userData: Partial<UserData> = {
    country: data.country || existingData?.country || "AT",
    taxNumber: data.taxNumber?.replace(/\D/g, "") || existingData?.taxNumber || "",
    ownEmails: (data.ownEmails || existingData?.ownEmails || [])
      .map((e: string) => e.trim().toLowerCase())
      .filter(Boolean),
    updatedAt: now,
    createdAt: existingDoc.exists() ? existingData?.createdAt : now,
  };

  // Handle new format (personalEntity + companies)
  if (data.personalEntity) {
    const personalVatId = data.personalEntity.vatId?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const personalPartnerId = data.personalEntity.partnerId || existingData?.personalEntity?.partnerId;

    const personalEntity: IdentityEntity = {
      id: data.personalEntity.id || existingData?.personalEntity?.id || generateEntityId(),
      type: "person",
      name: data.personalEntity.name.trim(),
      aliases: data.personalEntity.aliases.map((a) => a.trim()).filter(Boolean),
      ibans: data.personalEntity.ibans.map((i) => i.trim().toUpperCase().replace(/\s/g, "")).filter(Boolean),
      order: data.personalEntity.order ?? 0,
      createdAt: existingData?.personalEntity?.createdAt || now,
    };

    // Only include optional fields if they have values (Firestore doesn't accept undefined)
    if (personalVatId) personalEntity.vatId = personalVatId;
    if (personalPartnerId) personalEntity.partnerId = personalPartnerId;
    const personalAddress = normalizeIdentityAddress(
      data.personalEntity.address ?? existingData?.personalEntity?.address
    );
    if (personalAddress) personalEntity.address = personalAddress;

    userData.personalEntity = personalEntity;
  } else if (existingData?.personalEntity) {
    userData.personalEntity = existingData.personalEntity;
  }

  if (data.companies !== undefined) {
    userData.companies = data.companies.map((c, index) => {
      const companyVatId = c.vatId?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

      const company: IdentityEntity = {
        id: c.id || generateEntityId(),
        type: "company" as const,
        name: c.name.trim(),
        aliases: c.aliases.map((a) => a.trim()).filter(Boolean),
        ibans: c.ibans.map((i) => i.trim().toUpperCase().replace(/\s/g, "")).filter(Boolean),
        order: c.order ?? index,
        createdAt: existingData?.companies?.find((ec: IdentityEntity) => ec.id === c.id)?.createdAt || now,
      };

      // Only include optional fields if they have values
      if (companyVatId) company.vatId = companyVatId;
      if (c.partnerId) company.partnerId = c.partnerId;
      const companyAddress = normalizeIdentityAddress(c.address);
      if (companyAddress) company.address = companyAddress;

      return company;
    });
  } else if (existingData?.companies) {
    userData.companies = existingData.companies;
  }

  // Handle legacy format (for backward compatibility)
  if (data.name !== undefined) {
    userData.name = data.name.trim();
  } else if (existingData?.name !== undefined) {
    userData.name = existingData.name;
  }

  if (data.companyName !== undefined) {
    userData.companyName = data.companyName.trim();
  } else if (existingData?.companyName !== undefined) {
    userData.companyName = existingData.companyName;
  }

  if (data.aliases !== undefined) {
    userData.aliases = data.aliases.map((a) => a.trim()).filter(Boolean);
  } else if (existingData?.aliases !== undefined) {
    userData.aliases = existingData.aliases;
  }

  if (data.vatIds !== undefined) {
    userData.vatIds = data.vatIds.map((v) => v.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean);
  } else if (existingData?.vatIds !== undefined) {
    userData.vatIds = existingData.vatIds;
  }

  if (data.ibans !== undefined) {
    userData.ibans = data.ibans.map((i) => i.trim().toUpperCase().replace(/\s/g, "")).filter(Boolean);
  } else if (existingData?.ibans !== undefined) {
    userData.ibans = existingData.ibans;
  }

  if (data.markedAsMe !== undefined) {
    userData.markedAsMe = data.markedAsMe;
  } else if (existingData?.markedAsMe !== undefined) {
    userData.markedAsMe = existingData.markedAsMe;
  }

  // Only include identityPartnerIds if it exists (avoid undefined in Firestore)
  const identityPartnerIds = data.identityPartnerIds || existingData?.identityPartnerIds;
  if (identityPartnerIds) {
    userData.identityPartnerIds = identityPartnerIds;
  }

  await setDoc(docRef, userData as UserData);
}

/**
 * Check if text matches user data (name, company, or aliases)
 * Used during extraction to determine invoice direction.
 * Now checks ALL entities (personal + companies) for matches.
 */
export function matchesUserData(text: string, userData: UserData): boolean {
  if (!text || !userData) return false;

  const normalizedText = text.toLowerCase().trim();

  // Get all identity names (includes personal, companies, and legacy fields)
  const allNames = getAllIdentityNames(userData);

  for (const name of allNames) {
    if (name && normalizedText.includes(name.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a VAT ID belongs to the user
 * Used during file extraction to identify outgoing invoices.
 * Now checks ALL entities (personal + companies) for VAT ID matches.
 */
export function isUserVatId(vatId: string, userData: UserData | null): boolean {
  if (!vatId || !userData) return false;

  const normalizedVatId = vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const allVatIds = getAllIdentityVatIds(userData);

  if (allVatIds.length === 0) return false;

  return allVatIds.some(
    (userVat) => userVat.toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedVatId
  );
}

/**
 * Check if an IBAN belongs to the user
 * Used during file extraction to identify user's own bank accounts.
 * Now checks ALL entities (personal + companies) for IBAN matches.
 */
export function isUserIban(iban: string, userData: UserData | null): boolean {
  if (!iban || !userData) return false;

  const normalizedIban = iban.toUpperCase().replace(/\s/g, "");
  const allIbans = getAllIdentityIbans(userData);

  if (allIbans.length === 0) return false;

  return allIbans.some(
    (userIban) => userIban.toUpperCase().replace(/\s/g, "") === normalizedIban
  );
}

/**
 * Check if an email address belongs to the user.
 * Checks against both manually added emails (userData.ownEmails)
 * and inferred emails from connected email integrations.
 * Uses full email matching to avoid false positives with common domains like gmail.com.
 */
export function isUserEmail(
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

/**
 * Add an email address to user's ownEmails if not already present.
 * Called automatically when connecting a Gmail account.
 */
export async function addOwnEmail(
  ctx: OperationsContext,
  email: string
): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();
  if (!normalizedEmail) return false;

  const userData = await getUserData(ctx);

  // Create default if doesn't exist
  if (!userData) {
    await saveUserData(ctx, {
      name: "",
      companyName: "",
      aliases: [],
      vatIds: [],
      ibans: [],
      ownEmails: [normalizedEmail],
    });
    return true;
  }

  // Check if already exists
  const existing = userData.ownEmails || [];
  if (existing.some((e) => e.toLowerCase() === normalizedEmail)) {
    return false; // Already exists
  }

  // Add the email
  await saveUserData(ctx, {
    name: userData.name,
    companyName: userData.companyName,
    aliases: userData.aliases,
    vatIds: userData.vatIds || [],
    ibans: userData.ibans || [],
    ownEmails: [...existing, normalizedEmail],
  });

  return true;
}

/**
 * Data from a partner to merge into user data
 */
export interface PartnerMergeData {
  partnerId: string;
  name: string;
  vatId?: string | null;
  ibans?: string[];
}

/**
 * Merge partner data into user data (mark partner as "this is me").
 * Adds the partner's name to aliases, VAT ID to vatIds, IBANs to ibans,
 * and tracks the partner ID in markedAsMe for UI display and easy undo.
 * Only adds values that aren't already present.
 *
 * This triggers the onUserDataUpdate Cloud Function which will re-calculate
 * invoice direction and counterparty for all affected files.
 */
export async function mergePartnerIntoUserData(
  ctx: OperationsContext,
  partnerData: PartnerMergeData
): Promise<{ aliasAdded: boolean; vatIdAdded: boolean; ibansAdded: number; partnerMarked: boolean }> {
  const existing = await getUserData(ctx);

  // Create default if doesn't exist
  if (!existing) {
    await saveUserData(ctx, {
      name: "",
      companyName: "",
      aliases: [partnerData.name],
      vatIds: partnerData.vatId ? [partnerData.vatId] : [],
      ibans: partnerData.ibans || [],
      markedAsMe: [partnerData.partnerId],
    });
    return {
      aliasAdded: true,
      vatIdAdded: !!partnerData.vatId,
      ibansAdded: partnerData.ibans?.length || 0,
      partnerMarked: true,
    };
  }

  // Track what we're adding
  let aliasAdded = false;
  let vatIdAdded = false;
  let ibansAdded = 0;
  let partnerMarked = false;

  // Check if partner ID needs to be added to markedAsMe
  const newMarkedAsMe = [...(existing.markedAsMe || [])];
  if (!newMarkedAsMe.includes(partnerData.partnerId)) {
    newMarkedAsMe.push(partnerData.partnerId);
    partnerMarked = true;
  }

  // Check if alias needs to be added
  const newAliases = [...(existing.aliases || [])];
  const normalizedPartnerName = partnerData.name.toLowerCase().trim();
  const aliasExists = newAliases.some(
    (a) => a.toLowerCase().trim() === normalizedPartnerName
  );
  const isCompanyName =
    existing.companyName?.toLowerCase().trim() === normalizedPartnerName;
  const isUserName =
    existing.name?.toLowerCase().trim() === normalizedPartnerName;

  if (!aliasExists && !isCompanyName && !isUserName && partnerData.name) {
    newAliases.push(partnerData.name);
    aliasAdded = true;
  }

  // Check if VAT ID needs to be added
  const newVatIds = [...(existing.vatIds || [])];
  if (partnerData.vatId) {
    const normalizedVatId = partnerData.vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const vatIdExists = newVatIds.some(
      (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedVatId
    );
    if (!vatIdExists) {
      newVatIds.push(normalizedVatId);
      vatIdAdded = true;
    }
  }

  // Check if IBANs need to be added
  const newIbans = [...(existing.ibans || [])];
  for (const iban of partnerData.ibans || []) {
    const normalizedIban = iban.toUpperCase().replace(/\s/g, "");
    const ibanExists = newIbans.some(
      (i) => i.toUpperCase().replace(/\s/g, "") === normalizedIban
    );
    if (!ibanExists) {
      newIbans.push(normalizedIban);
      ibansAdded++;
    }
  }

  // Only update if something changed
  if (aliasAdded || vatIdAdded || ibansAdded > 0 || partnerMarked) {
    await saveUserData(ctx, {
      name: existing.name,
      companyName: existing.companyName,
      aliases: newAliases,
      vatIds: newVatIds,
      ibans: newIbans,
      markedAsMe: newMarkedAsMe,
    });
  }

  return { aliasAdded, vatIdAdded, ibansAdded, partnerMarked };
}

/**
 * Remove a partner from the markedAsMe list (undo "this is my company").
 * Note: This does NOT remove the partner's data from aliases/vatIds/ibans.
 */
export async function unmarkPartnerAsMe(
  ctx: OperationsContext,
  partnerId: string
): Promise<boolean> {
  const existing = await getUserData(ctx);
  if (!existing || !existing.markedAsMe?.includes(partnerId)) {
    return false;
  }

  const newMarkedAsMe = existing.markedAsMe.filter((id) => id !== partnerId);

  await saveUserData(ctx, {
    name: existing.name,
    companyName: existing.companyName,
    aliases: existing.aliases,
    vatIds: existing.vatIds || [],
    ibans: existing.ibans || [],
    markedAsMe: newMarkedAsMe,
  });

  return true;
}
