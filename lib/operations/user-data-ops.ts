import { doc, getDoc, setDoc, Timestamp } from "firebase/firestore";
import { UserData, UserDataFormData } from "@/types/user-data";
import { OperationsContext } from "./types";

const SETTINGS_COLLECTION = "settings";
const USER_DATA_DOC = "userData";

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
 * Create or update user data for the current user
 */
export async function saveUserData(
  ctx: OperationsContext,
  data: UserDataFormData
): Promise<void> {
  const now = Timestamp.now();
  const docRef = doc(ctx.db, "users", ctx.userId, SETTINGS_COLLECTION, USER_DATA_DOC);

  const existingDoc = await getDoc(docRef);

  const userData: UserData = {
    name: data.name.trim(),
    companyName: data.companyName.trim(),
    country: data.country || existingDoc.data()?.country || "AT",
    aliases: data.aliases.map((a) => a.trim()).filter(Boolean),
    vatIds: (data.vatIds || []).map((v) => v.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean),
    ibans: (data.ibans || []).map((i) => i.trim().toUpperCase().replace(/\s/g, "")).filter(Boolean),
    ownEmails: (data.ownEmails || existingDoc.data()?.ownEmails || [])
      .map((e: string) => e.trim().toLowerCase())
      .filter(Boolean),
    taxNumber: data.taxNumber?.replace(/\D/g, "") || existingDoc.data()?.taxNumber,
    markedAsMe: data.markedAsMe || existingDoc.data()?.markedAsMe || [],
    updatedAt: now,
    createdAt: existingDoc.exists() ? existingDoc.data().createdAt : now,
  };

  await setDoc(docRef, userData);
}

/**
 * Create default user data with preset values
 * Used when enabling preset partners
 */
export async function createDefaultUserData(ctx: OperationsContext): Promise<void> {
  const existing = await getUserData(ctx);

  // Don't overwrite existing user data
  if (existing) {
    return;
  }

  await saveUserData(ctx, {
    name: "Felix Häusler",
    companyName: "Infinity Vertigo GmbH",
    aliases: ["Haeusler"],
    vatIds: [],
    ibans: [],
  });

  console.log("[UserData] Created default user data for preset partners");
}

/**
 * Check if text matches user data (name, company, or aliases)
 * Used during extraction to determine invoice direction
 */
export function matchesUserData(text: string, userData: UserData): boolean {
  if (!text || !userData) return false;

  const normalizedText = text.toLowerCase().trim();

  // Check company name
  if (userData.companyName && normalizedText.includes(userData.companyName.toLowerCase())) {
    return true;
  }

  // Check user name
  if (userData.name && normalizedText.includes(userData.name.toLowerCase())) {
    return true;
  }

  // Check aliases
  for (const alias of userData.aliases || []) {
    if (alias && normalizedText.includes(alias.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a VAT ID belongs to the user
 * Used during file extraction to identify outgoing invoices
 */
export function isUserVatId(vatId: string, userData: UserData | null): boolean {
  if (!vatId || !userData || !userData.vatIds?.length) return false;

  const normalizedVatId = vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");

  return userData.vatIds.some(
    (userVat) => userVat.toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedVatId
  );
}

/**
 * Check if an IBAN belongs to the user
 * Used during file extraction to identify user's own bank accounts
 */
export function isUserIban(iban: string, userData: UserData | null): boolean {
  if (!iban || !userData || !userData.ibans?.length) return false;

  const normalizedIban = iban.toUpperCase().replace(/\s/g, "");

  return userData.ibans.some(
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
