/**
 * #626: the repair sets every inbound email address's daily limit back to the
 * server's, reports how many it changed, and touches nothing else.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/repair-inbound-daily-limits.test.ts --pool=forks --maxWorkers=1
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { repairInboundDailyLimits } from "./repair-inbound-daily-limits";
import { DEFAULT_DAILY_LIMIT } from "../email-inbound/inboundAddressCallables";

const db = getFirestore();
const silent = () => {};

const address = async (id: string) => (await db.collection("inboundEmailAddresses").doc(id).get()).data()!;

async function apply(extra: { userId?: string } = {}) {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbound-daily-limits-"));
  return repairInboundDailyLimits({ apply: true, backupDir, log: silent, ...extra });
}

const raised = {
  userId: "u1",
  email: "invoices-a@fibuki.com",
  emailPrefix: "a",
  isActive: true,
  emailsReceived: 0,
  filesCreated: 0,
  todayCount: 0,
  todayDate: "2026-10-05",
  dailyLimit: 100000,
};

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
});

describe("repairInboundDailyLimits", () => {
  it("sets a raised limit back to the default and changes nothing else", async () => {
    await db.collection("inboundEmailAddresses").doc("a1").set(raised);

    const report = await apply();

    expect(report.changed).toEqual([{ id: "a1", userId: "u1", from: 100000 }]);
    expect(await address("a1")).toEqual({ ...raised, dailyLimit: DEFAULT_DAILY_LIMIT });
    const backup = JSON.parse(await fs.readFile(report.backupPath!, "utf8"));
    expect(backup).toEqual([{ id: "a1", dailyLimit: 100000 }]);
  });

  it("repairs a missing or lowered limit too", async () => {
    const { dailyLimit: _omit, ...noLimit } = raised;
    await db.collection("inboundEmailAddresses").doc("a1").set(noLimit);
    await db.collection("inboundEmailAddresses").doc("a2").set({ ...raised, dailyLimit: 1 });

    const report = await apply();

    expect(report.changed.map((c) => c.id).sort()).toEqual(["a1", "a2"]);
    expect((await address("a1")).dailyLimit).toBe(DEFAULT_DAILY_LIMIT);
    expect((await address("a2")).dailyLimit).toBe(DEFAULT_DAILY_LIMIT);
  });

  it("is a dry run by default", async () => {
    await db.collection("inboundEmailAddresses").doc("a1").set(raised);

    const report = await repairInboundDailyLimits({ log: silent });

    expect(report.changed).toHaveLength(1);
    expect(report.applied).toBe(false);
    expect(report.backupPath).toBeNull();
    expect((await address("a1")).dailyLimit).toBe(100000);
  });

  it("is idempotent: a second run changes nothing", async () => {
    await db.collection("inboundEmailAddresses").doc("a1").set(raised);
    await db.collection("inboundEmailAddresses").doc("a2").set({ ...raised, dailyLimit: DEFAULT_DAILY_LIMIT });

    expect((await apply()).changed).toHaveLength(1);
    const second = await apply();
    expect(second.changed).toEqual([]);
    expect(second.backupPath).toBeNull();
    expect(second.addressesScanned).toBe(2);
  });

  it("limits the pass to one User", async () => {
    await db.collection("inboundEmailAddresses").doc("a1").set(raised);
    await db.collection("inboundEmailAddresses").doc("b1").set({ ...raised, userId: "u2" });

    const report = await apply({ userId: "u2" });

    expect(report.changed.map((c) => c.id)).toEqual(["b1"]);
    expect((await address("a1")).dailyLimit).toBe(100000);
  });

  it("refuses to apply without a backup directory", async () => {
    await expect(repairInboundDailyLimits({ apply: true, log: silent })).rejects.toThrow(/backupDir/);
  });
});
