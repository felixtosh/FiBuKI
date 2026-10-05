/**
 * The replay suite (docs/replay.md) end to end on the shim: export a small
 * account to a set, load it into a clean database, build the sheet, and diff
 * it against a sheet where the "branch" decided differently.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { exportReplaySet, loadReplaySet, parseReplaySet } from "../replay/set";
import { buildSheet, type Sheet } from "../replay/sheet";
import { diffSheets, renderDiffMarkdown } from "../replay/diff";

const db = getFirestore();
const ME = "replay-me";
const OTHER = "replay-other";
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

async function seed() {
  await db.collection("partners").doc("p-hetzner").set({
    userId: ME,
    name: "Hetzner Online GmbH",
    aliases: ["HETZNER ONLINE"],
    ibans: ["DE12500105170648489890"],
    isActive: true,
    manualRemovals: [],
  });
  await db.collection("transactions").doc("t-hetzner").set({
    userId: ME,
    amount: -1990,
    currency: "EUR",
    date: day("2026-03-12"),
    name: "HETZNER ONLINE GMBH",
    partnerIban: "DE12500105170648489890",
    fileIds: ["f-hetzner"],
    partnerId: "p-hetzner",
    partnerMatchedBy: "manual",
  });
  await db.collection("transactions").doc("t-decoy").set({
    userId: ME,
    amount: -1990,
    currency: "EUR",
    date: day("2026-04-12"),
    name: "HETZNER ONLINE GMBH",
    partnerIban: "DE12500105170648489890",
    fileIds: [],
  });
  await db.collection("transactions").doc("t-theirs").set({
    userId: OTHER,
    amount: -1990,
    currency: "EUR",
    date: day("2026-03-12"),
    name: "HETZNER ONLINE GMBH",
  });
  await db.collection("files").doc("f-hetzner").set({
    userId: ME,
    fileName: "hetzner-march.pdf",
    extractionComplete: true,
    extractedAmount: 1990,
    extractedCurrency: "EUR",
    extractedDate: day("2026-03-10"),
    extractedPartner: "Hetzner Online GmbH",
    extractedText: "a very long OCR text that the matcher never reads",
    partnerId: "p-hetzner",
    transactionIds: ["t-hetzner"],
    dismissedTransactions: [{ transactionId: "t-decoy" }],
  });
  await db.collection("fileConnections").doc("c-1").set({
    userId: ME,
    fileId: "f-hetzner",
    transactionId: "t-hetzner",
    connectionType: "manual",
  });
}

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("replay", () => {
  it("exports one User's inputs, loads them fresh, and the sheet reproduces the hand decisions", async () => {
    await seed();
    const set = await exportReplaySet(db, ME, { label: "Felix", now: () => new Date("2026-10-05T00:00:00Z") });
    expect(set.collections.transactions.map((l) => l.id).sort()).toEqual(["t-decoy", "t-hetzner"]);
    expect(set.collections.files[0].data.extractedText).toBeUndefined();
    // A Timestamp survives the round trip in the dump wire shape.
    expect(set.collections.files[0].data.extractedDate).toEqual({ __ts: [Date.UTC(2026, 2, 10) / 1000, 0] });

    const json = parseReplaySet(JSON.parse(JSON.stringify(set)));
    await __resetFirestoreShim();
    await loadReplaySet(db, json);

    const sheet = await buildSheet(ME, { label: "main", gitSha: "abc1234", setLabel: json.label, setExportedAt: json.exportedAt });
    const file = sheet.files["f-hetzner"];
    expect(file.ineligible).toBeNull();
    // Scored as a fresh upload: its own connection is a candidate again, the Rejection still holds.
    expect(file.autoConnect).toEqual(["t-hetzner"]);
    expect(file.suggestionIds).not.toContain("t-decoy");
    expect(file.truth).toEqual({ manualConnections: ["t-hetzner"], automatedConnections: [], rejected: ["t-decoy"] });

    const tx = sheet.transactions["t-hetzner"];
    expect(tx.wouldAssign).toBe("p-hetzner");
    expect(tx.top?.source).toBe("iban");
    expect(tx.truth).toEqual({ partnerId: "p-hetzner", partnerMatchedBy: "manual" });
    expect(sheet.transactions["t-theirs"]).toBeUndefined();
  });

  it("the diff names what changed and whether it agrees with the owner", async () => {
    await seed();
    const set = await exportReplaySet(db, ME);
    await __resetFirestoreShim();
    await loadReplaySet(db, set);
    const meta = { setLabel: set.label, setExportedAt: set.exportedAt };
    const base = await buildSheet(ME, { label: "main", ...meta });

    // Same data, same code: no change at all.
    const same = diffSheets(base, await buildSheet(ME, { label: "again", ...meta }));
    expect(same.files.rows).toEqual([]);
    expect(same.transactions.rows).toEqual([]);
    expect(renderDiffMarkdown(same)).toContain("No behaviour change");

    // A "branch" that auto-connects the rejected decoy and drops the Partner.
    const head: Sheet = JSON.parse(JSON.stringify(base));
    head.meta.label = "pr-999";
    head.files["f-hetzner"].autoConnect = ["t-decoy"];
    head.files["f-hetzner"].suggestionIds = ["t-decoy"];
    head.transactions["t-hetzner"].wouldAssign = null;

    const diff = diffSheets(base, head);
    expect(diff.counts).toEqual({ now_agrees: 0, now_disagrees: 1, contradicts: 1, unverified: 0 });
    expect(diff.files.rows[0]).toMatchObject({ id: "f-hetzner", verdict: "contradicts" });
    expect(diff.transactions.rows[0]).toMatchObject({ id: "t-hetzner", verdict: "now_disagrees" });
    const md = renderDiffMarkdown(diff);
    expect(md).toContain("Something got worse");
    expect(md).toContain("❌");

    // And the branch that comes back to the owner's decision reads as an improvement.
    const fixed = diffSheets(head, base);
    expect(fixed.counts.now_agrees).toBe(2);
  });
});
