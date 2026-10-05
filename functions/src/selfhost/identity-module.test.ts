/**
 * The business identity module (#632): one server module writes
 * users/{uid}/settings/userData. The settings screen and the Partner detail
 * panel's "this is me" reach it through the saveIdentity callable, MCP's
 * create_identity_entity and update_identity_entity through the shared tool
 * handler. It applies the normalisation the browser applied and merges, so
 * the fields the server keeps in the same document (FinanzOnline) survive.
 *
 * The real callable, tool handler and identity→Partner trigger run unmodified
 * on the selfhost shims.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/identity-module.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import "../matching/onUserDataUpdate";
import { saveIdentityCallable } from "../identity/saveIdentityCallable";

const db = getFirestore();
const USER = "stefan-test";
const OTHER = "someone-else";

let handleTool: (userId: string, name: string, args: Record<string, unknown>) => Promise<unknown>;

beforeAll(async () => {
  ({ handleTool } = (await import("../tools/handlers")) as never);
});

const identityRef = (uid = USER) => db.doc(`users/${uid}/settings/userData`);
const identity = async (uid = USER) => (await identityRef(uid).get()).data() as Record<string, any>;

/** The settings screen's save, as the browser sends it. */
const save = (data: Record<string, unknown>, uid = USER) =>
  saveIdentityCallable.run({ data, auth: { uid, token: {} } } as never) as Promise<{ success: boolean }>;

const FINANZONLINE = {
  isConfigured: true,
  teilnehmerId: "T-123",
  benutzerId: "B-456",
  connectionStatus: "connected",
  lastError: null,
};

const CREATED = Timestamp.fromDate(new Date("2026-01-02T00:00:00.000Z"));

async function seedIdentity(uid = USER, extra: Record<string, unknown> = {}) {
  await identityRef(uid).set({
    country: "AT",
    taxNumber: "123456789",
    ownEmails: ["me@example.at"],
    personalEntity: {
      id: "entity_person",
      type: "person",
      name: "Max Muster",
      aliases: [],
      ibans: [],
      order: 0,
      createdAt: CREATED,
    },
    companies: [],
    createdAt: CREATED,
    updatedAt: CREATED,
    ...extra,
  });
}

/** What the settings screen sends for the seeded identity, unchanged. */
const seededForm = () => ({
  country: "AT",
  taxNumber: "123456789",
  ownEmails: ["me@example.at"],
  personalEntity: { id: "entity_person", type: "person", name: "Max Muster", aliases: [], ibans: [], order: 0 },
  companies: [] as Array<Record<string, unknown>>,
});

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("a save keeps what the server keeps in the identity document", () => {
  it("a save keeps the FinanzOnline status", async () => {
    await seedIdentity(USER, { finanzonline: FINANZONLINE });

    await save({ ...seededForm(), taxNumber: "987654321" });

    const after = await identity();
    expect(after.taxNumber).toBe("987654321");
    expect(after.finanzonline).toEqual(FINANZONLINE);
  });

  it("an MCP create and update keep the FinanzOnline status too", async () => {
    await seedIdentity(USER, { finanzonline: FINANZONLINE });

    const { entityId } = (await handleTool(USER, "create_identity_entity", { type: "company", name: "Muster GmbH" })) as { entityId: string };
    await handleTool(USER, "update_identity_entity", { entityId, patch: { vatId: "ATU99999999" } });

    const after = await identity();
    expect(after.companies[0]).toMatchObject({ name: "Muster GmbH", vatId: "ATU99999999" });
    expect(after.finanzonline).toEqual(FINANZONLINE);
  });

  it("keeps an entity's createdAt and partner link the browser did not send", async () => {
    await seedIdentity(USER, {
      personalEntity: { ...seededForm().personalEntity, partnerId: "p-me", createdAt: CREATED },
      companies: [{ id: "entity_co", type: "company", name: "Muster GmbH", aliases: [], ibans: [], order: 0, createdAt: CREATED }],
    });

    await save({
      ...seededForm(),
      companies: [{ id: "entity_co", type: "company", name: "Muster GmbH", aliases: [], ibans: [] }],
    });

    const after = await identity();
    expect(after.personalEntity.partnerId).toBe("p-me");
    expect(after.personalEntity.createdAt.toMillis()).toBe(CREATED.toMillis());
    expect(after.companies[0].createdAt.toMillis()).toBe(CREATED.toMillis());
    expect(after.createdAt.toMillis()).toBe(CREATED.toMillis());
  });
});

describe("the module normalises what the browser normalised", () => {
  it("VAT id, IBAN, tax number, emails, aliases, address and entity ids", async () => {
    await save({
      taxNumber: "12-345/6789",
      ownEmails: [" Me@Example.AT ", "", "info@muster.at"],
      personalEntity: {
        type: "person",
        name: "  Max Muster ",
        aliases: [" M. Muster ", ""],
        vatId: " atu 12.345-678 ",
        ibans: ["at61 1904 3002 3457 3201", " "],
        address: { street: " Hauptstraße 1 ", city: "", country: "at" },
      },
      companies: [{ type: "company", name: " Muster GmbH ", aliases: [], ibans: [], vatId: "" }],
    });

    const after = await identity();
    expect(after).toMatchObject({
      country: "AT",
      taxNumber: "123456789",
      ownEmails: ["me@example.at", "info@muster.at"],
    });
    expect(after.personalEntity).toMatchObject({
      type: "person",
      name: "Max Muster",
      aliases: ["M. Muster"],
      vatId: "ATU12345678",
      ibans: ["AT611904300234573201"],
      address: { street: "Hauptstraße 1", country: "AT" },
      order: 0,
    });
    expect(after.personalEntity.id).toMatch(/^entity_/);
    expect(after.companies).toHaveLength(1);
    expect(after.companies[0]).toMatchObject({ type: "company", name: "Muster GmbH", order: 0 });
    expect(after.companies[0].id).toMatch(/^entity_/);
    expect(after.companies[0]).not.toHaveProperty("vatId");
  });

  it("a cleared VAT id or address is gone after the save, not merged back", async () => {
    await seedIdentity(USER, {
      personalEntity: { ...seededForm().personalEntity, vatId: "ATU12345678", createdAt: CREATED },
      companies: [{ id: "entity_co", type: "company", name: "Muster GmbH", aliases: [], ibans: [], vatId: "ATU99999999", address: { city: "Wien" }, order: 0, createdAt: CREATED }],
    });

    await save({
      ...seededForm(),
      personalEntity: { ...seededForm().personalEntity, vatId: "" },
      companies: [{ id: "entity_co", type: "company", name: "Muster GmbH", aliases: [], ibans: [], vatId: "" }],
    });

    const after = await identity();
    expect(after.personalEntity).not.toHaveProperty("vatId");
    expect(after.companies[0]).not.toHaveProperty("vatId");
    expect(after.companies[0]).not.toHaveProperty("address");
  });
});

describe("the callable takes only identity fields, for its caller", () => {
  it("refuses a field the identity does not hold, and writes nothing", async () => {
    await seedIdentity(USER, { finanzonline: FINANZONLINE });
    const before = await identity();

    await expect(save({ ...seededForm(), finanzonline: { isConfigured: false } })).rejects.toThrow(/finanzonline/);
    await expect(
      save({ ...seededForm(), personalEntity: { ...seededForm().personalEntity, isAdmin: true } })
    ).rejects.toThrow(/isAdmin/);

    expect(await identity()).toEqual(before);
  });

  it("writes the caller's own identity, never one named in the request", async () => {
    await seedIdentity(OTHER);
    const before = await identity(OTHER);

    await expect(save({ ...seededForm(), userId: OTHER })).rejects.toThrow(/userId/);
    await save({ ...seededForm(), personalEntity: { ...seededForm().personalEntity, name: "Attacker" } });

    expect(await identity(OTHER)).toEqual(before);
    expect((await identity(USER)).personalEntity.name).toBe("Attacker");
  });
});

/** The stored identity without what differs by construction: ids and clocks. */
function comparable(doc: Record<string, any>) {
  const entity = (e: Record<string, unknown>) => {
    const { id: _id, createdAt: _c, partnerId: _p, ...rest } = e;
    return rest;
  };
  const { updatedAt: _u, createdAt: _c, ...rest } = doc;
  return {
    ...rest,
    personalEntity: doc.personalEntity ? entity(doc.personalEntity) : undefined,
    companies: (doc.companies ?? []).map(entity),
  };
}

describe("the UI and MCP store the same identity for the same input", () => {
  const company = {
    name: " Muster Consulting GmbH ",
    vatId: "atu 99999999",
    ibans: ["at61 1904 3002 3457 3201"],
    aliases: [" MC GmbH ", ""],
    address: { street: " Ring 1 ", city: "Wien", country: "at" },
  };

  it("creating a company", async () => {
    await seedIdentity(USER);
    await seedIdentity(OTHER);

    // The settings screen (and "add as company" on a Partner) sends the whole identity.
    await save({ ...seededForm(), companies: [{ type: "company", ...company }] }, USER);
    await handleTool(OTHER, "create_identity_entity", { type: "company", ...company });

    expect(comparable(await identity(USER))).toEqual(comparable(await identity(OTHER)));
  });

  it("creating the personal entity for a user with none", async () => {
    const person = { name: " Max Muster ", vatId: "atu 12345678", ibans: ["AT61 1904 3002 3457 3201"], aliases: [] };

    await save({ personalEntity: { type: "person", ...person } }, USER);
    await handleTool(OTHER, "create_identity_entity", { type: "person", ...person });

    expect(comparable(await identity(USER))).toEqual(comparable(await identity(OTHER)));
  });

  it("updating an entity", async () => {
    await seedIdentity(USER);
    await seedIdentity(OTHER);

    const patch = { vatId: " atu 1234 5678", ibans: ["de89 3704 0044 0532 0130 00"], address: { city: " Graz ", country: "at" } };
    await save({ ...seededForm(), personalEntity: { ...seededForm().personalEntity, ...patch } }, USER);
    await handleTool(OTHER, "update_identity_entity", { entityId: "entity_person", patch });

    expect(comparable(await identity(USER))).toEqual(comparable(await identity(OTHER)));
    expect((await identity(OTHER)).personalEntity).toMatchObject({
      vatId: "ATU12345678",
      ibans: ["DE89370400440532013000"],
      address: { city: "Graz", country: "AT" },
    });
  });
});

describe("the identity sync to Partners still runs after a save", () => {
  async function identityPartners(uid = USER) {
    const snap = await db.collection("partners").where("userId", "==", uid).get();
    return snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Record<string, any>) }))
      .filter((p) => p.identitySourceField);
  }

  it("a settings save creates and links the identity Partners", async () => {
    await save({
      personalEntity: { type: "person", name: "Max Muster", aliases: [], ibans: [] },
      companies: [{ type: "company", name: "Muster GmbH", aliases: [], ibans: [] }],
    });
    await drainTriggers();

    const after = await identity();
    const partners = await identityPartners();
    expect(partners.map((p) => p.name).sort()).toEqual(["Max Muster", "Muster GmbH"]);
    expect(partners.find((p) => p.name === "Max Muster")!.id).toBe(after.personalEntity.partnerId);
    expect(partners.find((p) => p.name === "Muster GmbH")!.id).toBe(after.companies[0].partnerId);
  });

  it("a rename through the settings screen renames the identity Partner", async () => {
    await save({ personalEntity: { type: "person", name: "Max Muster", aliases: [], ibans: [] } });
    await drainTriggers();
    const first = await identity();

    await save({ personalEntity: { ...first.personalEntity, createdAt: undefined, name: "Max Muster-Huber" } });
    await drainTriggers();

    const partners = await identityPartners();
    expect(partners).toHaveLength(1);
    expect(partners[0]).toMatchObject({ id: first.personalEntity.partnerId, name: "Max Muster-Huber" });
  });

  it("an MCP create creates the identity Partner", async () => {
    await handleTool(USER, "create_identity_entity", { type: "company", name: "Muster GmbH" });
    await drainTriggers();

    const partners = await identityPartners();
    expect(partners.map((p) => p.name)).toEqual(["Muster GmbH"]);
    expect((await identity()).companies[0].partnerId).toBe(partners[0].id);
  });
});
