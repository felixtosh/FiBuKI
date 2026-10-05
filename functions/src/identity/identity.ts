/**
 * The business identity module (#632): the one writer of
 * users/{uid}/settings/userData's identity fields — the person and companies
 * the User is, their VAT ids, IBANs, tax number and own emails.
 *
 * The settings screen and the Partner detail panel's "this is me" reach it
 * through the saveIdentity callable; MCP's create_identity_entity and
 * update_identity_entity through the shared tool handler. All of them go
 * through `writeIdentity`, so one input stores one identity whichever way it
 * came in.
 *
 * The normalisation is the browser's (`saveUserData` in
 * lib/operations/user-data-ops.ts before #632), ported as it was. The write
 * merges: it sets the identity fields and nothing else, so what the server
 * keeps in the same document (the FinanzOnline status) survives a save. The
 * browser's save replaced the whole document and wiped it.
 *
 * Saving is what fires onUserDataUpdate, which syncs the identity Partners and
 * re-derives invoice direction.
 */

import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

type Db = FirebaseFirestore.Firestore;
type Doc = Record<string, any>;

export interface IdentityAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
}

/** One entity as a form sends it (IdentityEntityFormData in types/user-data.ts). */
export interface IdentityEntityForm {
  id?: string;
  type: "person" | "company";
  name: string;
  aliases: string[];
  vatId?: string;
  ibans: string[];
  address?: IdentityAddress;
  partnerId?: string;
  order?: number;
}

/** The whole identity as a form sends it (UserDataFormData in types/user-data.ts). */
export interface IdentityForm {
  country?: string;
  taxNumber?: string;
  ownEmails?: string[];
  personalEntity?: IdentityEntityForm;
  companies?: IdentityEntityForm[];
  // Deprecated fields, kept for backward compatibility
  name?: string;
  companyName?: string;
  aliases?: string[];
  vatIds?: string[];
  ibans?: string[];
  markedAsMe?: string[];
  identityPartnerIds?: { name?: string; companyName?: string };
}

export const identityDocPath = (userId: string) => `users/${userId}/settings/userData`;

export function generateEntityId(): string {
  return `entity_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// ============================================================================
// Normalisation (ported from the browser's saveUserData)
// ============================================================================

const normalizeVatId = (v: string | undefined) => v?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const normalizeIban = (i: string) => i.trim().toUpperCase().replace(/\s/g, "");

/**
 * Strip empty strings from an address; undefined if nothing meaningful is
 * left. Firestore doesn't accept undefined fields, so callers omit the whole
 * `address` key when this returns undefined.
 */
function normalizeIdentityAddress(raw: IdentityAddress | undefined | null): IdentityAddress | undefined {
  if (!raw) return undefined;
  const trimmed: IdentityAddress = {};
  if (raw.street?.trim()) trimmed.street = raw.street.trim();
  if (raw.postalCode?.trim()) trimmed.postalCode = raw.postalCode.trim();
  if (raw.city?.trim()) trimmed.city = raw.city.trim();
  if (raw.country?.trim()) trimmed.country = raw.country.trim().toUpperCase();
  return Object.keys(trimmed).length > 0 ? trimmed : undefined;
}

/**
 * The identity fields to store for `form`, given the stored document. Fields
 * the form leaves out keep their stored value.
 */
export function buildIdentity(existingData: Doc | undefined, form: IdentityForm, now: Timestamp): Doc {
  const userData: Doc = {
    country: form.country || existingData?.country || "AT",
    taxNumber: form.taxNumber?.replace(/\D/g, "") || existingData?.taxNumber || "",
    ownEmails: (form.ownEmails || existingData?.ownEmails || [])
      .map((e: string) => e.trim().toLowerCase())
      .filter(Boolean),
    updatedAt: now,
    createdAt: existingData ? existingData.createdAt ?? now : now,
  };

  if (form.personalEntity) {
    const p = form.personalEntity;
    const personalVatId = normalizeVatId(p.vatId);
    const personalPartnerId = p.partnerId || existingData?.personalEntity?.partnerId;

    const personalEntity: Doc = {
      id: p.id || existingData?.personalEntity?.id || generateEntityId(),
      type: "person",
      name: p.name.trim(),
      aliases: p.aliases.map((a) => a.trim()).filter(Boolean),
      ibans: p.ibans.map(normalizeIban).filter(Boolean),
      order: p.order ?? 0,
      createdAt: existingData?.personalEntity?.createdAt || now,
    };

    // Only include optional fields if they have values (Firestore doesn't accept undefined)
    if (personalVatId) personalEntity.vatId = personalVatId;
    if (personalPartnerId) personalEntity.partnerId = personalPartnerId;
    const personalAddress = normalizeIdentityAddress(p.address ?? existingData?.personalEntity?.address);
    if (personalAddress) personalEntity.address = personalAddress;

    userData.personalEntity = personalEntity;
  } else if (existingData?.personalEntity) {
    userData.personalEntity = existingData.personalEntity;
  }

  if (form.companies !== undefined) {
    userData.companies = form.companies.map((c, index) => {
      const companyVatId = normalizeVatId(c.vatId);

      const company: Doc = {
        id: c.id || generateEntityId(),
        type: "company",
        name: c.name.trim(),
        aliases: c.aliases.map((a) => a.trim()).filter(Boolean),
        ibans: c.ibans.map(normalizeIban).filter(Boolean),
        order: c.order ?? index,
        createdAt: existingData?.companies?.find((ec: Doc) => ec.id === c.id)?.createdAt || now,
      };

      if (companyVatId) company.vatId = companyVatId;
      if (c.partnerId) company.partnerId = c.partnerId;
      const companyAddress = normalizeIdentityAddress(c.address);
      if (companyAddress) company.address = companyAddress;

      return company;
    });
  } else if (existingData?.companies) {
    userData.companies = existingData.companies;
  }

  // Legacy format (backward compatibility)
  if (form.name !== undefined) userData.name = form.name.trim();
  else if (existingData?.name !== undefined) userData.name = existingData.name;

  if (form.companyName !== undefined) userData.companyName = form.companyName.trim();
  else if (existingData?.companyName !== undefined) userData.companyName = existingData.companyName;

  if (form.aliases !== undefined) userData.aliases = form.aliases.map((a) => a.trim()).filter(Boolean);
  else if (existingData?.aliases !== undefined) userData.aliases = existingData.aliases;

  if (form.vatIds !== undefined) userData.vatIds = form.vatIds.map((v) => normalizeVatId(v)!).filter(Boolean);
  else if (existingData?.vatIds !== undefined) userData.vatIds = existingData.vatIds;

  if (form.ibans !== undefined) userData.ibans = form.ibans.map(normalizeIban).filter(Boolean);
  else if (existingData?.ibans !== undefined) userData.ibans = existingData.ibans;

  if (form.markedAsMe !== undefined) userData.markedAsMe = form.markedAsMe;
  else if (existingData?.markedAsMe !== undefined) userData.markedAsMe = existingData.markedAsMe;

  // Only include identityPartnerIds if it exists (avoid undefined in Firestore)
  const identityPartnerIds = form.identityPartnerIds || existingData?.identityPartnerIds;
  if (identityPartnerIds) userData.identityPartnerIds = identityPartnerIds;

  return userData;
}

// ============================================================================
// The write
// ============================================================================

/**
 * Write the identity `change` returns for the stored document, in one
 * transaction. `change` may throw to refuse; it can run more than once, so it
 * must not have side effects.
 */
export async function writeIdentity(
  db: Db,
  userId: string,
  change: (existing: Doc | undefined) => IdentityForm
): Promise<Doc> {
  const ref = db.doc(identityDocPath(userId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Doc) : undefined;
    const fields = buildIdentity(existing, change(existing), Timestamp.now());
    // The merge: an update replaces each identity field whole (so a cleared
    // vatId or address goes, which a deep set-merge would keep) and leaves every
    // other field of the document as it is.
    if (snap.exists) tx.update(ref, fields);
    else tx.set(ref, fields);
    return fields;
  });
}

// ============================================================================
// The settings screen's save (saveIdentity callable)
// ============================================================================

const ENTITY_KEYS = new Set(["id", "type", "name", "aliases", "vatId", "ibans", "address", "partnerId", "order"]);
const ADDRESS_KEYS = new Set(["street", "postalCode", "city", "country"]);
const FORM_KEYS = new Set([
  "country", "taxNumber", "ownEmails", "personalEntity", "companies",
  "name", "companyName", "aliases", "vatIds", "ibans", "markedAsMe", "identityPartnerIds",
]);

const invalid = (message: string) => new HttpsError("invalid-argument", message);

/** The keys of `raw` that hold a value, refusing any outside `allowed`. */
function knownKeys(raw: Doc, allowed: Set<string>, where: string): string[] {
  const keys = Object.keys(raw).filter((k) => raw[k] !== undefined);
  const unknown = keys.filter((k) => !allowed.has(k));
  if (unknown.length > 0) throw invalid(`${where} does not take ${unknown.join(", ")}`);
  return keys;
}

const isObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid(`${field} must be a string`);
  return v;
}

function stringList(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw invalid(`${field} must be a list of strings`);
  return v as string[];
}

function parseAddress(v: unknown, field: string): IdentityAddress | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) throw invalid(`${field} must be an object`);
  knownKeys(v, ADDRESS_KEYS, field);
  const address: IdentityAddress = {};
  for (const k of ADDRESS_KEYS) {
    const s = optionalString(v[k], `${field}.${k}`);
    if (s !== undefined) address[k as keyof IdentityAddress] = s;
  }
  return address;
}

function parseEntity(v: unknown, type: "person" | "company", field: string): IdentityEntityForm {
  if (!isObject(v)) throw invalid(`${field} must be an object`);
  knownKeys(v, ENTITY_KEYS, field);
  if (v.type !== undefined && v.type !== type) throw invalid(`${field}.type must be ${type}`);
  if (v.order !== undefined && v.order !== null && typeof v.order !== "number") throw invalid(`${field}.order must be a number`);
  const entity: IdentityEntityForm = {
    type,
    name: optionalString(v.name, `${field}.name`) ?? "",
    aliases: stringList(v.aliases, `${field}.aliases`) ?? [],
    ibans: stringList(v.ibans, `${field}.ibans`) ?? [],
  };
  const id = optionalString(v.id, `${field}.id`);
  if (id) entity.id = id;
  const vatId = optionalString(v.vatId, `${field}.vatId`);
  if (vatId !== undefined) entity.vatId = vatId;
  const partnerId = optionalString(v.partnerId, `${field}.partnerId`);
  if (partnerId) entity.partnerId = partnerId;
  const address = parseAddress(v.address, `${field}.address`);
  if (address) entity.address = address;
  if (typeof v.order === "number") entity.order = v.order;
  return entity;
}

/**
 * The identity a request asks for, or invalid-argument. Takes only the fields
 * the identity holds: anything else in the document (FinanzOnline, the
 * clocks) is the server's.
 */
export function parseIdentityForm(raw: unknown): IdentityForm {
  if (!isObject(raw)) throw invalid("the identity must be an object");
  knownKeys(raw, FORM_KEYS, "the identity");

  const form: IdentityForm = {};
  const country = optionalString(raw.country, "country");
  if (country !== undefined) form.country = country;
  const taxNumber = optionalString(raw.taxNumber, "taxNumber");
  if (taxNumber !== undefined) form.taxNumber = taxNumber;
  const ownEmails = stringList(raw.ownEmails, "ownEmails");
  if (ownEmails) form.ownEmails = ownEmails;

  if (raw.personalEntity !== undefined && raw.personalEntity !== null) {
    form.personalEntity = parseEntity(raw.personalEntity, "person", "personalEntity");
  }
  if (raw.companies !== undefined && raw.companies !== null) {
    if (!Array.isArray(raw.companies)) throw invalid("companies must be a list");
    form.companies = raw.companies.map((c, i) => parseEntity(c, "company", `companies[${i}]`));
  }

  const name = optionalString(raw.name, "name");
  if (name !== undefined) form.name = name;
  const companyName = optionalString(raw.companyName, "companyName");
  if (companyName !== undefined) form.companyName = companyName;
  for (const key of ["aliases", "vatIds", "ibans", "markedAsMe"] as const) {
    const list = stringList(raw[key], key);
    if (list) form[key] = list;
  }
  if (raw.identityPartnerIds !== undefined && raw.identityPartnerIds !== null) {
    const ids = raw.identityPartnerIds;
    if (!isObject(ids)) throw invalid("identityPartnerIds must be an object");
    knownKeys(ids, new Set(["name", "companyName"]), "identityPartnerIds");
    form.identityPartnerIds = {};
    const n = optionalString(ids.name, "identityPartnerIds.name");
    if (n) form.identityPartnerIds.name = n;
    const c = optionalString(ids.companyName, "identityPartnerIds.companyName");
    if (c) form.identityPartnerIds.companyName = c;
  }
  return form;
}

/** The settings screen's save: the whole identity form. */
export async function saveIdentity(db: Db, userId: string, raw: unknown): Promise<{ success: true }> {
  const form = parseIdentityForm(raw);
  await writeIdentity(db, userId, () => form);
  return { success: true };
}

// ============================================================================
// MCP: create_identity_entity / update_identity_entity
// ============================================================================

/** A stored entity as the form that would store it again. */
function entityForm(e: Doc, type: "person" | "company"): IdentityEntityForm {
  const form: IdentityEntityForm = {
    type,
    name: typeof e.name === "string" ? e.name : "",
    aliases: Array.isArray(e.aliases) ? e.aliases.map(String) : [],
    ibans: Array.isArray(e.ibans) ? e.ibans.map(String) : [],
  };
  if (e.id) form.id = String(e.id);
  if (typeof e.vatId === "string") form.vatId = e.vatId;
  if (e.partnerId) form.partnerId = String(e.partnerId);
  if (isObject(e.address)) form.address = e.address as IdentityAddress;
  if (typeof e.order === "number") form.order = e.order;
  return form;
}

/**
 * Apply an MCP patch (name, vatId, ibans, aliases, address) to an entity form.
 * `address: null` clears the address.
 */
function patchEntity(entity: IdentityEntityForm, patch: Doc): IdentityEntityForm {
  const next: IdentityEntityForm = { ...entity };
  if (typeof patch.name === "string") next.name = patch.name;
  if (typeof patch.vatId === "string") next.vatId = patch.vatId;
  if (Array.isArray(patch.ibans)) next.ibans = patch.ibans.map(String);
  if (Array.isArray(patch.aliases)) next.aliases = patch.aliases.map(String);
  if (patch.address === null) next.address = {};
  else if (isObject(patch.address)) next.address = patch.address as IdentityAddress;
  return next;
}

/**
 * Create the user's personal entity or a company, for someone who has none
 * yet (create_identity_entity). Refuses a second personal entity and a
 * company whose name is already taken.
 */
export async function createIdentityEntity(db: Db, userId: string, args: Doc) {
  const type = args.type;
  if (type !== "person" && type !== "company") throw new Error("type must be 'person' or 'company'");
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) throw new Error("name is required");

  const entityId = generateEntityId();

  const written = await writeIdentity(db, userId, (existing) => {
    const companies = Array.isArray(existing?.companies) ? (existing!.companies as Doc[]) : [];
    if (type === "person" && existing?.personalEntity?.id) {
      throw new Error("A personal entity already exists. Use update_identity_entity to change it.");
    }
    if (type === "company" && companies.some((c) => String(c.name ?? "").trim().toLowerCase() === name.toLowerCase())) {
      throw new Error(`A company named "${name}" already exists. Use update_identity_entity to change it.`);
    }

    const created = patchEntity(
      { id: entityId, type, name, aliases: [], ibans: [], order: type === "person" ? 0 : companies.length },
      { ...args, name }
    );
    return type === "person"
      ? { personalEntity: created }
      : { companies: [...companies.map((c) => entityForm(c, "company")), created] };
  });

  const entity = type === "person" ? written.personalEntity : (written.companies as Doc[]).find((c) => c.id === entityId);
  return { success: true, entityId, entity };
}

/**
 * Patch an existing identity entity, personal or a company
 * (update_identity_entity).
 */
export async function updateIdentityEntity(db: Db, userId: string, args: Doc) {
  const entityId = String(args.entityId || "");
  if (!entityId) throw new Error("entityId is required");
  const patch = isObject(args.patch) ? args.patch : {};

  await writeIdentity(db, userId, (existing) => {
    if (!existing) throw new Error("User data not found");
    if (existing.personalEntity?.id === entityId) {
      return { personalEntity: patchEntity(entityForm(existing.personalEntity, "person"), patch) };
    }
    const companies = Array.isArray(existing.companies) ? (existing.companies as Doc[]) : [];
    if (!companies.some((c) => c.id === entityId)) throw new Error(`Identity entity ${entityId} not found`);
    return {
      companies: companies.map((c) => {
        const form = entityForm(c, "company");
        return c.id === entityId ? patchEntity(form, patch) : form;
      }),
    };
  });

  return { success: true, entityId };
}
