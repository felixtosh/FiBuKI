/**
 * Inbound email addresses are written only through their four callables (#626,
 * ADR-0016). The User chooses the display name, the allowed domains and
 * active/paused; the daily limit and the counters are the server's.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/inbound-email-callables.test.ts --pool=forks --maxWorkers=1
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { __resetFirestoreShim, getFirestore, Timestamp } from "./firestore-shim";
import {
  createInboundEmailAddressCallable,
  updateInboundEmailAddressCallable,
  regenerateInboundEmailAddressCallable,
  deleteInboundEmailAddressCallable,
  DEFAULT_DAILY_LIMIT,
} from "../email-inbound/inboundAddressCallables";

const USER = "inbound-user";
const OTHER = "inbound-other";
const AUTH = (uid: string) => ({ uid, token: { email: `${uid}@x.test`, email_verified: true } });

type Callable = { run: (req: { data: unknown; auth?: unknown }) => Promise<Record<string, unknown>> };
const run = (fn: unknown, data: unknown, uid: string | null = USER) =>
  (fn as Callable).run({ data, auth: uid ? AUTH(uid) : undefined });

const create = (data: unknown = {}, uid?: string | null) => run(createInboundEmailAddressCallable, data, uid);
const update = (data: unknown, uid?: string | null) => run(updateInboundEmailAddressCallable, data, uid);
const regenerate = (data: unknown, uid?: string | null) => run(regenerateInboundEmailAddressCallable, data, uid);
const remove = (data: unknown, uid?: string | null) => run(deleteInboundEmailAddressCallable, data, uid);

const row = async (id: string) => (await getFirestore().doc(`inboundEmailAddresses/${id}`).get()).data();
const rows = async () => (await getFirestore().collection("inboundEmailAddresses").get()).docs;

/** An address that has received mail: counters the User must not be able to reset. */
async function seedAddress(id = "addr-1", userId = USER) {
  const now = Timestamp.now();
  await getFirestore().doc(`inboundEmailAddresses/${id}`).set({
    userId,
    email: "invoices-abc@fibuki.com",
    emailPrefix: "abc",
    displayName: "Rechnungen",
    allowedDomains: ["example.at"],
    isActive: true,
    emailsReceived: 42,
    filesCreated: 40,
    dailyLimit: DEFAULT_DAILY_LIMIT,
    todayCount: 7,
    todayDate: "2026-10-05",
    lastEmailAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const COUNTERS = {
  emailsReceived: 0,
  filesCreated: 0,
  todayCount: 0,
  todayDate: "1999-01-01",
  lastEmailAt: null,
};

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("createInboundEmailAddress", () => {
  it("creates an active address with the server's daily limit and zeroed counters", async () => {
    const res = await create({ displayName: "Belege", allowedDomains: ["a1.at"] });
    expect(res.email).toMatch(/^invoices-[A-Za-z0-9_-]{21}@fibuki\.com$/);
    const data = await row(String(res.id));
    expect(data).toMatchObject({
      userId: USER,
      email: res.email,
      displayName: "Belege",
      allowedDomains: ["a1.at"],
      isActive: true,
      dailyLimit: DEFAULT_DAILY_LIMIT,
      emailsReceived: 0,
      filesCreated: 0,
      todayCount: 0,
    });
    expect(String(res.email)).toContain(String(data?.emailPrefix));
  });

  it("creates with no settings at all, as the screen does", async () => {
    const res = await create();
    expect((await row(String(res.id)))?.isActive).toBe(true);
  });

  it("refuses a daily limit", async () => {
    await expect(create({ dailyLimit: 100000 })).rejects.toMatchObject({ code: "invalid-argument" });
    expect(await rows()).toHaveLength(0);
  });

  it.each(Object.entries(COUNTERS))("refuses the counter %s", async (field, value) => {
    await expect(create({ [field]: value })).rejects.toMatchObject({ code: "invalid-argument" });
    expect(await rows()).toHaveLength(0);
  });

  it.each([["userId", OTHER], ["email", "me@evil.test"], ["emailPrefix", "chosen"], ["isActive", false]])(
    "refuses %s",
    async (field, value) => {
      await expect(create({ [field]: value })).rejects.toMatchObject({ code: "invalid-argument" });
      expect(await rows()).toHaveLength(0);
    }
  );

  it("refuses a caller who is not signed in", async () => {
    await expect(create({}, null)).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("updateInboundEmailAddress", () => {
  it("changes the display name, the allowed domains and active/paused", async () => {
    const id = await seedAddress();
    await update({ addressId: id, data: { displayName: "Neu", allowedDomains: ["b.at", "c.de"] } });
    expect(await row(id)).toMatchObject({ displayName: "Neu", allowedDomains: ["b.at", "c.de"], isActive: true });
    await update({ addressId: id, data: { isActive: false } });
    expect((await row(id))?.isActive).toBe(false);
    await update({ addressId: id, data: { isActive: true } });
    expect((await row(id))?.isActive).toBe(true);
  });

  it("refuses a daily limit and leaves the address as it was", async () => {
    const id = await seedAddress();
    const before = await row(id);
    await expect(update({ addressId: id, data: { dailyLimit: 100000 } })).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await expect(
      update({ addressId: id, data: { displayName: "Neu", dailyLimit: 100000 } })
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect(await row(id)).toEqual(before);
  });

  it.each(Object.entries(COUNTERS))("refuses the counter %s and leaves it as it was", async (field, value) => {
    const id = await seedAddress();
    const before = await row(id);
    await expect(update({ addressId: id, data: { [field]: value } })).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await expect(update({ addressId: id, data: { isActive: true, [field]: value } })).rejects.toMatchObject({
      code: "invalid-argument",
    });
    expect(await row(id)).toEqual(before);
  });

  it.each([["userId", OTHER], ["email", "me@evil.test"], ["emailPrefix", "chosen"], ["createdAt", null]])(
    "refuses %s",
    async (field, value) => {
      const id = await seedAddress();
      const before = await row(id);
      await expect(update({ addressId: id, data: { [field]: value } })).rejects.toMatchObject({
        code: "invalid-argument",
      });
      expect(await row(id)).toEqual(before);
    }
  );

  it.each([
    [{ displayName: 5 }],
    [{ displayName: "x".repeat(201) }],
    [{ allowedDomains: "a.at" }],
    [{ allowedDomains: ["not a domain"] }],
    [{ isActive: "yes" }],
  ])("refuses a malformed value %j", async (data) => {
    const id = await seedAddress();
    await expect(update({ addressId: id, data })).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("refuses another User's address as if it did not exist", async () => {
    const id = await seedAddress("addr-other", OTHER);
    const before = await row(id);
    await expect(update({ addressId: id, data: { isActive: false } })).rejects.toMatchObject({ code: "not-found" });
    await expect(update({ addressId: "missing", data: { isActive: false } })).rejects.toMatchObject({
      code: "not-found",
    });
    expect(await row(id)).toEqual(before);
  });
});

describe("regenerateInboundEmailAddress", () => {
  it("creates a new address with the same settings and deactivates the old one", async () => {
    const id = await seedAddress();
    const res = await regenerate({ addressId: id });
    expect(res.id).not.toBe(id);
    expect((await row(id))?.isActive).toBe(false);
    const fresh = await row(String(res.id));
    expect(fresh).toMatchObject({
      userId: USER,
      email: res.email,
      displayName: "Rechnungen",
      allowedDomains: ["example.at"],
      isActive: true,
      dailyLimit: DEFAULT_DAILY_LIMIT,
      emailsReceived: 0,
      filesCreated: 0,
      todayCount: 0,
    });
    expect(fresh?.emailPrefix).not.toBe("abc");
  });

  it("refuses another User's address and creates nothing", async () => {
    const id = await seedAddress("addr-other", OTHER);
    await expect(regenerate({ addressId: id })).rejects.toMatchObject({ code: "not-found" });
    expect(await rows()).toHaveLength(1);
    expect((await row(id))?.isActive).toBe(true);
  });
});

describe("deleteInboundEmailAddress", () => {
  it("deactivates the address and keeps its row", async () => {
    const id = await seedAddress();
    await remove({ addressId: id });
    expect(await row(id)).toMatchObject({ isActive: false, emailsReceived: 42 });
  });

  it("refuses another User's address", async () => {
    const id = await seedAddress("addr-other", OTHER);
    await expect(remove({ addressId: id })).rejects.toMatchObject({ code: "not-found" });
    expect((await row(id))?.isActive).toBe(true);
  });

  it("refuses a missing or malformed id", async () => {
    await expect(remove({})).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(remove({ addressId: "../x" })).rejects.toMatchObject({ code: "invalid-argument" });
  });
});
