import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  setDoc,
  addDoc,
  Timestamp,
  writeBatch,
  limit,
  deleteDoc,
} from "firebase/firestore";
import { PRESET_PARTNERS, generatePresetId } from "@/lib/data/preset-partners";
import {
  UserPartner,
  GlobalPartner,
  GlobalPartnerFormData,
  PartnerFilters,
  PromotionCandidate,
  FileSourcePattern,
} from "@/types/partner";
import { normalizeIban } from "@/lib/import/deduplication";
import { normalizeUrl } from "@/lib/matching/url-normalizer";
import { OperationsContext } from "./types";

const PARTNERS_COLLECTION = "partners";
const GLOBAL_PARTNERS_COLLECTION = "globalPartners";
const TRANSACTIONS_COLLECTION = "transactions";
const PROMOTION_CANDIDATES_COLLECTION = "promotionCandidates";

// ============ User Partners ============

/**
 * List all active partners for the current user
 */
export async function listUserPartners(
  ctx: OperationsContext,
  filters?: PartnerFilters
): Promise<UserPartner[]> {
  const q = query(
    collection(ctx.db, PARTNERS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("isActive", "==", true),
    orderBy("name", "asc")
  );

  const snapshot = await getDocs(q);

  let partners = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as UserPartner[];

  // Client-side filtering for search
  if (filters?.search) {
    const searchLower = filters.search.toLowerCase();
    partners = partners.filter(
      (p) =>
        p.name.toLowerCase().includes(searchLower) ||
        p.aliases.some((a) => a.toLowerCase().includes(searchLower)) ||
        p.vatId?.toLowerCase().includes(searchLower) ||
        p.ibans.some((i) => i.toLowerCase().includes(searchLower))
    );
  }

  if (filters?.country) {
    partners = partners.filter((p) => p.country === filters.country);
  }

  if (filters?.hasVatId !== undefined) {
    partners = partners.filter((p) =>
      filters.hasVatId ? !!p.vatId : !p.vatId
    );
  }

  if (filters?.hasIban !== undefined) {
    partners = partners.filter((p) =>
      filters.hasIban ? p.ibans.length > 0 : p.ibans.length === 0
    );
  }

  return partners;
}

/**
 * Get a user partner by ID
 */
export async function getUserPartner(
  ctx: OperationsContext,
  partnerId: string
): Promise<UserPartner | null> {
  const docRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  if (data.userId !== ctx.userId) return null;

  return { id: snapshot.id, ...data } as UserPartner;
}

/**
 * Find user partner by IBAN
 */
export async function findUserPartnerByIban(
  ctx: OperationsContext,
  iban: string
): Promise<UserPartner | null> {
  const normalizedIban = normalizeIban(iban);

  const q = query(
    collection(ctx.db, PARTNERS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("isActive", "==", true),
    where("ibans", "array-contains", normalizedIban)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as UserPartner;
}

/**
 * Find user partner by global partner ID (for checking if user already has a local copy)
 */
export async function findUserPartnerByGlobalId(
  ctx: OperationsContext,
  globalPartnerId: string
): Promise<UserPartner | null> {
  const q = query(
    collection(ctx.db, PARTNERS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("isActive", "==", true),
    where("globalPartnerId", "==", globalPartnerId)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as UserPartner;
}

// ============ Global Partners ============

/**
 * List global partners
 */
export async function listGlobalPartners(
  ctx: OperationsContext,
  filters?: PartnerFilters
): Promise<GlobalPartner[]> {
  const q = query(
    collection(ctx.db, GLOBAL_PARTNERS_COLLECTION),
    where("isActive", "==", true),
    orderBy("name", "asc")
  );

  const snapshot = await getDocs(q);

  let partners = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as GlobalPartner[];

  // Client-side filtering
  if (filters?.search) {
    const searchLower = filters.search.toLowerCase();
    partners = partners.filter(
      (p) =>
        p.name.toLowerCase().includes(searchLower) ||
        p.aliases.some((a) => a.toLowerCase().includes(searchLower)) ||
        p.vatId?.toLowerCase().includes(searchLower) ||
        p.ibans.some((i) => i.toLowerCase().includes(searchLower))
    );
  }

  if (filters?.country) {
    partners = partners.filter((p) => p.country === filters.country);
  }

  return partners;
}

/**
 * Get a global partner by ID
 */
export async function getGlobalPartner(
  ctx: OperationsContext,
  partnerId: string
): Promise<GlobalPartner | null> {
  const docRef = doc(ctx.db, GLOBAL_PARTNERS_COLLECTION, partnerId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) return null;

  return { id: snapshot.id, ...snapshot.data() } as GlobalPartner;
}

/**
 * Create a global partner (admin only)
 */
export async function createGlobalPartner(
  ctx: OperationsContext,
  data: GlobalPartnerFormData
): Promise<string> {
  const now = Timestamp.now();

  const newPartner = {
    name: data.name.trim(),
    aliases: (data.aliases || []).map((a) => a.trim()).filter(Boolean),
    address: data.address || null,
    country: data.country || null,
    vatId: data.vatId?.toUpperCase().replace(/\s/g, "") || null,
    ibans: (data.ibans || []).map(normalizeIban).filter(Boolean),
    website: data.website ? normalizeUrl(data.website) : null,
    externalIds: data.externalIds || null,
    source: data.source || "manual",
    sourceDetails: {
      contributingUserIds: [ctx.userId],
      confidence: 100,
      verifiedAt: now,
      verifiedBy: ctx.userId,
    },
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  const docRef = await addDoc(collection(ctx.db, GLOBAL_PARTNERS_COLLECTION), newPartner);
  return docRef.id;
}

/**
 * Update a global partner (admin only)
 */
export async function updateGlobalPartner(
  ctx: OperationsContext,
  partnerId: string,
  data: Partial<GlobalPartnerFormData>
): Promise<void> {
  const existing = await getGlobalPartner(ctx, partnerId);
  if (!existing) {
    throw new Error(`Global partner ${partnerId} not found`);
  }

  const updates: Record<string, unknown> = {
    updatedAt: Timestamp.now(),
  };

  if (data.name !== undefined) updates.name = data.name.trim();
  if (data.aliases !== undefined) {
    updates.aliases = data.aliases.map((a) => a.trim()).filter(Boolean);
  }
  if (data.address !== undefined) updates.address = data.address;
  if (data.country !== undefined) updates.country = data.country;
  if (data.vatId !== undefined) {
    updates.vatId = data.vatId?.toUpperCase().replace(/\s/g, "") || null;
  }
  if (data.ibans !== undefined) {
    updates.ibans = data.ibans.map(normalizeIban).filter(Boolean);
  }
  if (data.website !== undefined) {
    updates.website = data.website ? normalizeUrl(data.website) : null;
  }
  if (data.externalIds !== undefined) {
    updates.externalIds = data.externalIds;
  }

  const docRef = doc(ctx.db, GLOBAL_PARTNERS_COLLECTION, partnerId);
  await updateDoc(docRef, updates);
}

/**
 * Soft-delete a global partner (admin only)
 */
export async function deleteGlobalPartner(
  ctx: OperationsContext,
  partnerId: string
): Promise<void> {
  const existing = await getGlobalPartner(ctx, partnerId);
  if (!existing) {
    throw new Error(`Global partner ${partnerId} not found`);
  }

  const docRef = doc(ctx.db, GLOBAL_PARTNERS_COLLECTION, partnerId);
  await updateDoc(docRef, {
    isActive: false,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Find global partner by IBAN
 */
export async function findGlobalPartnerByIban(
  ctx: OperationsContext,
  iban: string
): Promise<GlobalPartner | null> {
  const normalizedIban = normalizeIban(iban);

  const q = query(
    collection(ctx.db, GLOBAL_PARTNERS_COLLECTION),
    where("isActive", "==", true),
    where("ibans", "array-contains", normalizedIban)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as GlobalPartner;
}

// ============ Transaction Partner Assignment ============

/**
 * Get unmatched transactions for the current user
 */
export async function getUnmatchedTransactions(
  ctx: OperationsContext,
  limitCount: number = 100
): Promise<Array<{ id: string; partner: string | null; partnerIban: string | null; name: string }>> {
  const q = query(
    collection(ctx.db, TRANSACTIONS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("partnerId", "==", null),
    limit(limitCount)
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      partner: data.partner || null,
      partnerIban: data.partnerIban || null,
      name: data.name || "",
    };
  });
}

// ============ Promotion Candidates (Admin) ============

/**
 * List pending promotion candidates
 */
export async function listPromotionCandidates(
  ctx: OperationsContext
): Promise<PromotionCandidate[]> {
  const q = query(
    collection(ctx.db, PROMOTION_CANDIDATES_COLLECTION),
    where("status", "==", "pending"),
    orderBy("confidence", "desc")
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as PromotionCandidate[];
}

/**
 * Approve a promotion candidate (promotes user partner to global)
 */
export async function approvePromotionCandidate(
  ctx: OperationsContext,
  candidateId: string
): Promise<string> {
  const candidateDoc = doc(ctx.db, PROMOTION_CANDIDATES_COLLECTION, candidateId);
  const candidateSnapshot = await getDoc(candidateDoc);

  if (!candidateSnapshot.exists()) {
    throw new Error(`Promotion candidate ${candidateId} not found`);
  }

  const candidate = candidateSnapshot.data() as PromotionCandidate;
  const userPartner = candidate.userPartner;

  // Create global partner from user partner
  const globalPartnerId = await createGlobalPartner(ctx, {
    name: userPartner.name,
    aliases: userPartner.aliases,
    address: userPartner.address,
    country: userPartner.country,
    vatId: userPartner.vatId,
    ibans: userPartner.ibans,
    website: userPartner.website,
    source: "user_promoted",
  });

  // Update the promotion candidate as approved
  await updateDoc(candidateDoc, {
    status: "approved",
    reviewedAt: Timestamp.now(),
    reviewedBy: ctx.userId,
  });

  return globalPartnerId;
}

/**
 * Reject a promotion candidate
 */
export async function rejectPromotionCandidate(
  ctx: OperationsContext,
  candidateId: string
): Promise<void> {
  const candidateDoc = doc(ctx.db, PROMOTION_CANDIDATES_COLLECTION, candidateId);

  await updateDoc(candidateDoc, {
    status: "rejected",
    reviewedAt: Timestamp.now(),
    reviewedBy: ctx.userId,
  });
}

// ============ Preset Partners (Admin) ============

/**
 * Check if preset partners are currently enabled
 */
export async function getPresetPartnersStatus(
  ctx: OperationsContext
): Promise<{ enabled: boolean; count: number }> {
  const q = query(
    collection(ctx.db, GLOBAL_PARTNERS_COLLECTION),
    where("source", "==", "preset"),
    where("isActive", "==", true),
    limit(1)
  );

  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    return { enabled: false, count: 0 };
  }

  // Get full count
  const countQuery = query(
    collection(ctx.db, GLOBAL_PARTNERS_COLLECTION),
    where("source", "==", "preset"),
    where("isActive", "==", true)
  );
  const countSnapshot = await getDocs(countQuery);

  return { enabled: true, count: countSnapshot.size };
}

/**
 * Enable preset partners by seeding/upserting them into the database.
 *
 * Idempotent: can be called repeatedly. On each run it:
 * - Creates new preset partners that don't exist yet
 * - Updates changed fields (name, aliases, vatId, website, patterns, country) on existing ones
 * - Migrates legacy random-ID docs to deterministic IDs
 * - Preserves user-enriched fields (ibans, address, externalIds)
 */
export async function enablePresetPartners(
  ctx: OperationsContext
): Promise<{ created: number; updated: number; migrated: number; unchanged: number }> {
  const now = Timestamp.now();

  // 1. Fetch all existing preset docs in one shot
  const existingQuery = query(
    collection(ctx.db, GLOBAL_PARTNERS_COLLECTION),
    where("source", "==", "preset")
  );
  const existingSnapshot = await getDocs(existingQuery);

  // Build lookup maps: by doc ID and by normalized name
  const existingById = new Map<string, Record<string, unknown>>();
  const existingByName = new Map<string, { id: string; data: Record<string, unknown> }>();

  for (const docSnap of existingSnapshot.docs) {
    const data = docSnap.data();
    existingById.set(docSnap.id, data);
    // Normalize name for matching legacy random-ID docs
    const normalizedName = (data.name || "").toLowerCase().trim();
    if (normalizedName) {
      existingByName.set(normalizedName, { id: docSnap.id, data });
    }
  }

  // 2. Process each preset partner
  const BATCH_SIZE = 500;
  let created = 0;
  let updated = 0;
  let migrated = 0;
  let unchanged = 0;

  // Collect operations to batch
  type BatchOp = {
    type: "set" | "update";
    ref: ReturnType<typeof doc>;
    data: Record<string, unknown>;
  } | {
    type: "delete";
    ref: ReturnType<typeof doc>;
  };
  const operations: BatchOp[] = [];

  // Fields we manage (will be updated if changed)
  const managedFields = ["name", "aliases", "vatId", "website", "patterns", "country"] as const;

  for (const partner of PRESET_PARTNERS) {
    const deterministicId = generatePresetId(partner.name);
    const normalizedName = partner.name.toLowerCase().trim();

    const presetData = {
      name: partner.name,
      aliases: partner.aliases,
      country: partner.country,
      vatId: partner.vatId || null,
      website: partner.website || null,
      patterns: partner.patterns || [],
    };

    const existingDoc = existingById.get(deterministicId);

    if (existingDoc) {
      // Doc with deterministic ID exists — check if any managed fields changed
      let hasChanges = false;
      for (const field of managedFields) {
        const existingVal = JSON.stringify(existingDoc[field] ?? null);
        const presetVal = JSON.stringify(presetData[field as keyof typeof presetData] ?? null);
        if (existingVal !== presetVal) {
          hasChanges = true;
          break;
        }
      }

      if (hasChanges) {
        operations.push({
          type: "update",
          ref: doc(ctx.db, GLOBAL_PARTNERS_COLLECTION, deterministicId),
          data: { ...presetData, updatedAt: now },
        });
        updated++;
      } else {
        unchanged++;
      }
    } else {
      // No deterministic-ID doc — check for legacy random-ID doc by name
      const legacyMatch = existingByName.get(normalizedName);

      if (legacyMatch && legacyMatch.id !== deterministicId) {
        // Migrate: delete old doc, create new one with deterministic ID
        // Preserve user-enriched fields from legacy doc
        operations.push({
          type: "delete",
          ref: doc(ctx.db, GLOBAL_PARTNERS_COLLECTION, legacyMatch.id),
        });
        operations.push({
          type: "set",
          ref: doc(ctx.db, GLOBAL_PARTNERS_COLLECTION, deterministicId),
          data: {
            ...presetData,
            // Preserve user-enriched fields from the legacy doc
            address: legacyMatch.data.address ?? null,
            ibans: legacyMatch.data.ibans ?? [],
            externalIds: legacyMatch.data.externalIds ?? null,
            source: "preset",
            sourceDetails: legacyMatch.data.sourceDetails ?? {
              contributingUserIds: ["system"],
              confidence: 100,
              verifiedAt: now,
              verifiedBy: "system",
            },
            isActive: true,
            createdAt: legacyMatch.data.createdAt ?? now,
            updatedAt: now,
          },
        });
        migrated++;
        // Remove from byName so we don't match it again
        existingByName.delete(normalizedName);
      } else {
        // Brand new partner — create with deterministic ID
        operations.push({
          type: "set",
          ref: doc(ctx.db, GLOBAL_PARTNERS_COLLECTION, deterministicId),
          data: {
            ...presetData,
            address: null,
            ibans: [],
            externalIds: null,
            source: "preset",
            sourceDetails: {
              contributingUserIds: ["system"],
              confidence: 100,
              verifiedAt: now,
              verifiedBy: "system",
            },
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
        });
        created++;
      }
    }
  }

  // 3. Execute in batches of 500
  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    const batch = writeBatch(ctx.db);
    const chunk = operations.slice(i, i + BATCH_SIZE);

    for (const op of chunk) {
      if (op.type === "set") {
        batch.set(op.ref, op.data);
      } else if (op.type === "update") {
        batch.update(op.ref, op.data);
      } else {
        batch.delete(op.ref);
      }
    }

    await batch.commit();
  }

  return { created, updated, migrated, unchanged };
}

/**
 * Disable preset partners by hard-deleting them
 * (We hard delete because these are system-generated, not user data)
 */
export async function disablePresetPartners(
  ctx: OperationsContext
): Promise<{ deleted: number }> {
  const q = query(
    collection(ctx.db, GLOBAL_PARTNERS_COLLECTION),
    where("source", "==", "preset")
  );

  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    return { deleted: 0 };
  }

  // Batch delete in groups of 500
  const BATCH_SIZE = 500;
  let deleted = 0;
  const docs = snapshot.docs;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = writeBatch(ctx.db);
    const chunk = docs.slice(i, i + BATCH_SIZE);

    for (const docSnap of chunk) {
      batch.delete(docSnap.ref);
      deleted++;
    }

    await batch.commit();
  }

  return { deleted };
}

/**
 * Toggle preset partners on/off
 */
export async function togglePresetPartners(
  ctx: OperationsContext,
  enable: boolean
): Promise<{ enabled: boolean; count: number; created?: number; updated?: number; migrated?: number; unchanged?: number }> {
  if (enable) {
    const result = await enablePresetPartners(ctx);
    return {
      enabled: true,
      count: result.created + result.updated + result.migrated,
      ...result,
    };
  } else {
    const result = await disablePresetPartners(ctx);
    return { enabled: false, count: result.deleted };
  }
}

// ============ File Source Patterns ============

/**
 * Get file source patterns for a partner
 */
export async function getFileSourcePatterns(
  ctx: OperationsContext,
  partnerId: string
): Promise<FileSourcePattern[]> {
  const partner = await getUserPartner(ctx, partnerId);
  if (!partner) {
    return [];
  }

  return partner.fileSourcePatterns || [];
}

// ============ Email Domain Learning ============

/**
 * Add an email domain to a partner's known domains.
 * Called when a file from a Gmail sender is matched to a transaction with this partner.
 *
 * This enables future auto-matching: files from known email domains
 * get a confidence boost when matching to transactions with this partner.
 *
 * @param partnerId - The partner to add the domain to
 * @param domain - The email domain (e.g., "amazon.de")
 */
export async function addEmailDomainToPartner(
  ctx: OperationsContext,
  partnerId: string,
  domain: string
): Promise<void> {
  const partner = await getUserPartner(ctx, partnerId);
  if (!partner) {
    throw new Error(`Partner ${partnerId} not found or access denied`);
  }

  // Normalize domain
  const normalizedDomain = domain.toLowerCase().trim();

  // Check if already exists
  const existingDomains = partner.emailDomains || [];
  if (existingDomains.includes(normalizedDomain)) {
    return; // Already exists, nothing to do
  }

  // Add domain
  const updatedDomains = [...existingDomains, normalizedDomain];

  const partnerRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
  await updateDoc(partnerRef, {
    emailDomains: updatedDomains,
    emailDomainsUpdatedAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  console.log(`[EmailDomain] Added domain "${normalizedDomain}" to partner ${partnerId}`);
}

/**
 * Find partners by email domain.
 * Returns all partners that have this domain in their emailDomains array.
 *
 * Used for:
 * 1. Boosting confidence when matching files from known sender domains
 * 2. Auto-suggesting partners when viewing an email attachment
 */
export async function findPartnersByEmailDomain(
  ctx: OperationsContext,
  domain: string
): Promise<UserPartner[]> {
  const normalizedDomain = domain.toLowerCase().trim();

  const q = query(
    collection(ctx.db, PARTNERS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("isActive", "==", true),
    where("emailDomains", "array-contains", normalizedDomain)
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as UserPartner[];
}

/**
 * Get all email domains for a partner
 */
export async function getEmailDomainsForPartner(
  ctx: OperationsContext,
  partnerId: string
): Promise<string[]> {
  const partner = await getUserPartner(ctx, partnerId);
  if (!partner) {
    return [];
  }

  return partner.emailDomains || [];
}
