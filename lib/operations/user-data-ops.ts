import { doc, getDoc } from "firebase/firestore";
import { UserData } from "@/types/user-data";
import { OperationsContext } from "./types";

// Reads only: the identity is written on the server, by the business identity module
// (functions/src/identity/identity.ts, through the saveIdentity callable; #632).

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
