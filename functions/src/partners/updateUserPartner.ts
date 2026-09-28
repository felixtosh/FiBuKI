/**
 * Update a user partner
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

export interface PartnerUpdateData {
  name?: string;
  aliases?: string[];
  address?: string | null;
  country?: string | null;
  vatId?: string | null;
  ibans?: string[];
  website?: string | null;
  notes?: string | null;
  defaultCategoryId?: string | null;
  isMyCompany?: boolean;
}

export interface UpdateUserPartnerRequest {
  partnerId: string;
  data: PartnerUpdateData;
}

interface UpdateUserPartnerResponse {
  success: boolean;
}

const LEGAL_SUFFIX_ONLY_ALIASES = new Set([
  "llc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "gmbh",
  "ag",
  "kg",
  "ohg",
  "og",
  "mbh",
  "co",
  "sarl",
  "sas",
  "srl",
  "spa",
  "sl",
  "bv",
  "nv",
]);

function normalizeAliasInput(alias: string): string {
  return alias.replace(/\*/g, " ").replace(/\s+/g, " ").trim();
}

function isMeaningfulAlias(alias: string): boolean {
  const normalized = alias
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length < 3) return false;
  if (LEGAL_SUFFIX_ONLY_ALIASES.has(normalized)) return false;
  return /[a-z0-9]/i.test(normalized);
}

function sanitizeAliases(rawAliases: string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawAlias of rawAliases) {
    const cleaned = normalizeAliasInput(rawAlias);
    if (!cleaned || !isMeaningfulAlias(cleaned)) continue;

    const dedupeKey = cleaned.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    result.push(cleaned);
  }

  return result;
}

function normalizeIban(iban: string): string {
  return iban.replace(/\s/g, "").toUpperCase();
}

function normalizeUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = "https://" + normalized;
  }
  return normalized.replace(/\/+$/, "");
}

/**
 * Internal implementation, so the Partners page callable and the tool surface
 * (`update_partner`, #213) run the same edit rather than two that drift.
 * `aliases` and `ibans` are replaced wholesale, never merged.
 */
export async function updateUserPartnerInternal(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: UpdateUserPartnerRequest
): Promise<UpdateUserPartnerResponse> {
  const { partnerId } = request ?? {};
  const data: PartnerUpdateData = request?.data ?? {};

  if (!partnerId) {
    throw new HttpsError("invalid-argument", "partnerId is required");
  }

  // Verify ownership
  const partnerRef = db.collection("partners").doc(partnerId);
  const partnerSnap = await partnerRef.get();

  if (!partnerSnap.exists) {
    throw new HttpsError("not-found", "Partner not found");
  }

  if (partnerSnap.data()!.userId !== userId) {
    throw new HttpsError("permission-denied", "Access denied");
  }

  // Build update object
  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (data.name !== undefined) {
    updates.name = data.name.trim();
  }
  if (data.aliases !== undefined) {
    updates.aliases = sanitizeAliases(data.aliases);
  }
  if (data.address !== undefined) {
    updates.address = data.address;
  }
  if (data.country !== undefined) {
    updates.country = data.country;
  }
  if (data.vatId !== undefined) {
    updates.vatId = data.vatId?.toUpperCase().replace(/\s/g, "") || null;
  }
  if (data.ibans !== undefined) {
    updates.ibans = data.ibans.map(normalizeIban).filter(Boolean);
  }
  if (data.website !== undefined) {
    updates.website = data.website ? normalizeUrl(data.website) : null;
  }
  if (data.notes !== undefined) {
    updates.notes = data.notes;
  }
  if (data.defaultCategoryId !== undefined) {
    updates.defaultCategoryId = data.defaultCategoryId;
  }
  if (data.isMyCompany !== undefined) {
    updates.isMyCompany = data.isMyCompany;
  }

  await partnerRef.update(updates);

  console.log(`[updateUserPartner] Updated partner ${partnerId}`, {
    userId,
    fields: Object.keys(updates),
  });

  return { success: true };
}

export const updateUserPartnerCallable = createCallable<
  UpdateUserPartnerRequest,
  UpdateUserPartnerResponse
>(
  { name: "updateUserPartner" },
  async (ctx, request) => updateUserPartnerInternal(ctx.db, ctx.userId, request)
);
