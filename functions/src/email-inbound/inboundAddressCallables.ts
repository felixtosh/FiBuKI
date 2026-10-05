/**
 * Callables behind the inbound email screen (#626, ADR-0016): the only writers
 * of a User's inbound email addresses.
 *
 * The User chooses the display name, the allowed sender domains and whether the
 * address is active. The daily limit and the counters (emails received, Files
 * created, today's count) belong to the server: the limit is set here on
 * create, the counters only by `receiveEmail` and `resetDailyLimits`. A request
 * naming any other field is refused, so a User cannot raise their own limit or
 * reset their counters.
 *
 * Every callable that takes an address loads it by id and refuses one the
 * caller does not own, with the same answer as for one that does not exist.
 */
import { randomBytes } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

type Db = FirebaseFirestore.Firestore;

const INBOUND_ADDRESSES_COLLECTION = "inboundEmailAddresses";

/** Email domain for inbound addresses (receiveEmail.ts accepts the same one). */
const INBOUND_EMAIL_DOMAIN = "fibuki.com";

/** Emails an address accepts per day. The server's to set, never the User's. */
export const DEFAULT_DAILY_LIMIT = 100;

/** What a User may write on an address. Everything else is refused. */
const WRITABLE_FIELDS = new Set(["displayName", "allowedDomains", "isActive"]);
/** What create takes: the same, less isActive (a new address is active). */
const CREATE_FIELDS = new Set(["displayName", "allowedDomains"]);

const MAX_DISPLAY_NAME = 200;
const MAX_DOMAINS = 100;
/** Labels of letters, digits and inner hyphens, at least two of them, joined by dots. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface InboundAddressSettings {
  displayName?: string;
  allowedDomains?: string[];
}

export interface UpdateInboundAddressData extends InboundAddressSettings {
  isActive?: boolean;
}

/** Refuses any key outside `allowed`; an undefined value counts as absent. */
function refuseUnknown(data: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(data).filter((k) => data[k] !== undefined && !allowed.has(k));
  if (unknown.length) {
    throw new HttpsError("invalid-argument", `Fields not allowed: ${unknown.join(", ")}`);
  }
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** The User's settings from a request, checked; absent ones are left out. */
function settings(data: Record<string, unknown>): UpdateInboundAddressData {
  const out: UpdateInboundAddressData = {};
  if (data.displayName !== undefined) {
    if (typeof data.displayName !== "string" || data.displayName.length > MAX_DISPLAY_NAME) {
      throw new HttpsError("invalid-argument", "displayName must be a short string");
    }
    out.displayName = data.displayName;
  }
  if (data.allowedDomains !== undefined) {
    const domains = data.allowedDomains;
    if (
      !Array.isArray(domains) ||
      domains.length > MAX_DOMAINS ||
      !domains.every((d) => typeof d === "string" && DOMAIN.test(d.toLowerCase()))
    ) {
      throw new HttpsError("invalid-argument", "allowedDomains must be a list of domains");
    }
    // receiveEmail compares lowercased, so they are stored that way.
    out.allowedDomains = (domains as string[]).map((d) => d.toLowerCase());
  }
  if (data.isActive !== undefined) {
    if (typeof data.isActive !== "boolean") {
      throw new HttpsError("invalid-argument", "isActive must be a boolean");
    }
    out.isActive = data.isActive;
  }
  return out;
}

async function ownedAddress(db: Db, userId: string, addressId: unknown) {
  if (typeof addressId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(addressId)) {
    throw new HttpsError("invalid-argument", "addressId is required");
  }
  const ref = db.collection(INBOUND_ADDRESSES_COLLECTION).doc(addressId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    throw new HttpsError("not-found", "Inbound email address not found");
  }
  return { ref, data: snap.data() as FirebaseFirestore.DocumentData };
}

/** 21 url-safe characters, ~126 bits: the address cannot be guessed. */
function generateEmailPrefix(): string {
  return randomBytes(16).toString("base64url").slice(0, 21);
}

/** A new address row: the User's settings, the server's limit, zeroed counters. */
function newAddress(userId: string, chosen: InboundAddressSettings) {
  const emailPrefix = generateEmailPrefix();
  const email = `invoices-${emailPrefix}@${INBOUND_EMAIL_DOMAIN}`;
  const now = Timestamp.now();
  // Firestore rejects undefined, so optional fields are only added when set.
  const row: Record<string, unknown> = {
    userId,
    email,
    emailPrefix,
    isActive: true,
    emailsReceived: 0,
    filesCreated: 0,
    dailyLimit: DEFAULT_DAILY_LIMIT,
    todayCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (chosen.displayName) row.displayName = chosen.displayName;
  if (chosen.allowedDomains && chosen.allowedDomains.length > 0) row.allowedDomains = chosen.allowedDomains;
  return { row, email };
}

export const createInboundEmailAddressCallable = createCallable<
  InboundAddressSettings,
  { id: string; email: string }
>({ name: "createInboundEmailAddress" }, async (ctx, request) => {
  const data = asObject(request, "request");
  refuseUnknown(data, CREATE_FIELDS);
  const { row, email } = newAddress(ctx.userId, settings(data));
  const ref = ctx.db.collection(INBOUND_ADDRESSES_COLLECTION).doc();
  await ref.set(row);
  return { id: ref.id, email };
});

export const updateInboundEmailAddressCallable = createCallable<
  { addressId: string; data: UpdateInboundAddressData },
  { success: boolean }
>({ name: "updateInboundEmailAddress" }, async (ctx, request) => {
  const data = asObject(request?.data, "data");
  refuseUnknown(data, WRITABLE_FIELDS);
  const updates = settings(data);
  const { ref } = await ownedAddress(ctx.db, ctx.userId, request?.addressId);
  await ref.update({ ...updates, updatedAt: Timestamp.now() });
  return { success: true };
});

/**
 * A new address with the same settings; the old one stops accepting mail. The
 * new one gets the server's limit, not the stored one: a stored limit above it
 * can only have come from the browser write this table no longer takes.
 */
export const regenerateInboundEmailAddressCallable = createCallable<
  { addressId: string },
  { id: string; email: string }
>({ name: "regenerateInboundEmailAddress" }, async (ctx, request) => {
  const { ref: oldRef, data: existing } = await ownedAddress(ctx.db, ctx.userId, request?.addressId);
  const { row, email } = newAddress(ctx.userId, {
    displayName: existing.displayName,
    allowedDomains: existing.allowedDomains,
  });
  const newRef = ctx.db.collection(INBOUND_ADDRESSES_COLLECTION).doc();
  const batch = ctx.db.batch();
  batch.update(oldRef, { isActive: false, updatedAt: Timestamp.now() });
  batch.set(newRef, row);
  await batch.commit();
  return { id: newRef.id, email };
});

/** A soft delete: the address is deactivated, its row and logs stay. */
export const deleteInboundEmailAddressCallable = createCallable<
  { addressId: string },
  { success: boolean }
>({ name: "deleteInboundEmailAddress" }, async (ctx, request) => {
  const { ref } = await ownedAddress(ctx.db, ctx.userId, request?.addressId);
  await ref.update({ isActive: false, updatedAt: Timestamp.now() });
  return { success: true };
});
