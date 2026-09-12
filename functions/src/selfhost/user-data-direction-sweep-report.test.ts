/**
 * The identity-change sweep accounts for every File it reads (#158).
 *
 * The bug the ticket describes is reproduced here in full: a File whose
 * counterparty entity carries no `vatId` used to put `undefined` in the write
 * payload, the store refuses an undefined value, and the refusal took an
 * arbitrary share of the SAME batch down with it — most Files flipped, a
 * minority kept their pre-run `updatedAt`, and the run said nothing either
 * way. The inputs were byte-identical; only the batch position differed.
 *
 * The real trigger module runs unmodified on the selfhost shims, so these are
 * the counts production emits.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import {
  SweepLedger,
  commitSweepWrites,
  type InvoiceDirectionSweepSummary,
  type PlannedFileWrite,
  type SweepOutcome,
} from "../matching/invoiceDirectionSweepReport";

// REAL trigger module, unmodified:
import "../matching/onUserDataUpdate";

const db = getFirestore();
const USER = "stefan-sweep";
const USER_VAT = "ATU99999999";

const userDataRef = () =>
  db.collection("users").doc(USER).collection("settings").doc("userData");

const PRE_RUN = Timestamp.fromDate(new Date("2020-01-01T00:00:00.000Z"));

/** A whole issuer block, the shape an extraction that read everything leaves. */
const FULL_ISSUER = {
  name: "ACME Handels GmbH",
  vatId: "ATU12345678",
  iban: "AT021420020010147558",
  address: "Wien",
  website: "acme.at",
};

interface FileSeed {
  [key: string]: unknown;
}

async function seedFile(fileId: string, overrides: FileSeed = {}): Promise<void> {
  await db.collection("files").doc(fileId).set({
    userId: USER,
    fileName: `${fileId}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    extractedIssuer: { ...FULL_ISSUER },
    extractedRecipient: { name: "Stefan Bandit", vatId: USER_VAT },
    extractedPartner: "ACME Handels GmbH",
    invoiceDirection: "unknown",
    matchedUserAccount: null,
    transactionIds: [],
    createdAt: Timestamp.now(),
    updatedAt: PRE_RUN,
    ...overrides,
  });
}

/** Every run the sweep has recorded, oldest first. */
async function sweepRuns(): Promise<InvoiceDirectionSweepSummary[]> {
  const snapshot = await db.collection(`users/${USER}/directionSweeps`).get();
  return snapshot.docs
    .map((doc) => doc.data() as unknown as InvoiceDirectionSweepSummary)
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
}

/** The run that did the work, i.e. the one that wrote or refused to. */
function workingRun(runs: InvoiceDirectionSweepSummary[]): InvoiceDirectionSweepSummary {
  const run = runs.find((r) => r.outcomes.written > 0 || r.outcomes["write-rejected"] > 0);
  expect(run, "no run wrote anything").toBeDefined();
  return run!;
}

function totalOutcomes(run: InvoiceDirectionSweepSummary): number {
  return (Object.values(run.outcomes) as number[]).reduce((sum, n) => sum + n, 0);
}

async function directionOf(fileId: string): Promise<string> {
  return (await db.collection("files").doc(fileId).get()).data()!.invoiceDirection as string;
}

async function updatedAtOf(fileId: string): Promise<string> {
  const value = (await db.collection("files").doc(fileId).get()).data()!.updatedAt;
  return (value as FirebaseFirestore.Timestamp).toDate().toISOString();
}

/** A matching-relevant identity edit: adds an IBAN, so the sweep runs. */
async function editIdentity(ibans: string[]): Promise<void> {
  await userDataRef().update({
    personalEntity: {
      id: "p1",
      type: "person",
      name: "Stefan Bandit",
      aliases: [],
      vatId: USER_VAT,
      ibans,
      partnerId: "p-me",
      order: 0,
    },
  });
  await drainTriggers();
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();

  // The identity partner exists already, so the sync is a no-op and the edit
  // below fires exactly one sweep rather than a sweep plus a write-back.
  await db.collection("partners").doc("p-me").set({
    userId: USER,
    name: "Stefan Bandit",
    identitySourceField: "personalEntity",
    isActive: true,
  });
  await userDataRef().set({
    personalEntity: {
      id: "p1",
      type: "person",
      name: "Stefan Bandit",
      aliases: [],
      vatId: USER_VAT,
      ibans: [],
      partnerId: "p-me",
      order: 0,
    },
  });
  await drainTriggers();
});

describe("selfhost: onUserDataUpdate invoice-direction sweep accounting (#158)", () => {
  it("writes every File with identical inputs, whatever its counterparty block holds", async () => {
    // Same issuer, same recipient name, same run. Only f-04's issuer block is
    // sparser — the one difference that used to silently cost f-05 onwards
    // their write, because they sat behind it in the same batch.
    for (let i = 0; i < 10; i++) {
      const id = `f-${String(i).padStart(2, "0")}`;
      await seedFile(id, i === 4 ? { extractedIssuer: { name: "ACME Handels GmbH" } } : {});
    }
    await drainTriggers();

    await editIdentity(["AT611904300234573201"]);

    for (let i = 0; i < 10; i++) {
      const id = `f-${String(i).padStart(2, "0")}`;
      expect(await directionOf(id), `${id} was not flipped`).toBe("incoming");
      expect(await updatedAtOf(id), `${id} was never written`).not.toBe(
        PRE_RUN.toDate().toISOString()
      );
    }

    const run = workingRun(await sweepRuns());
    expect(run.outcomes.written).toBe(10);
    expect(run.outcomes["write-rejected"]).toBe(0);
    expect(run.complete).toBe(true);
    expect(run.candidates).toBe(totalOutcomes(run));
  });

  it("gives every File a named outcome, and the outcomes add up to the candidates", async () => {
    // One File per reason a File can end a run without a write. The seventh,
    // `write-rejected`, cannot be provoked through a fixture — the store
    // refuses the payload that would cause it at seed time too — so it has
    // its own test below, against the same ledger.
    await seedFile("f-written");
    await seedFile("f-already-correct", {
      invoiceDirection: "incoming",
      matchedUserAccount: "recipient",
      recipientIdentityMatch: "user",
      extractedPartner: "ACME Handels GmbH",
    });
    await seedFile("f-extraction-incomplete", { extractionComplete: false });
    await seedFile("f-not-an-invoice", { isNotInvoice: true });
    await seedFile("f-no-entities", {
      extractedIssuer: null,
      extractedRecipient: null,
    });
    // A stored name that is not a string: the identity comparison throws on it.
    await seedFile("f-evaluation-failed", {
      extractedIssuer: { ...FULL_ISSUER, name: 42 },
      extractedRecipient: null,
    });
    await drainTriggers();

    await editIdentity(["AT611904300234573201"]);

    const run = workingRun(await sweepRuns());
    const expected: Record<SweepOutcome, number> = {
      written: 1,
      "already-correct": 1,
      "extraction-incomplete": 1,
      "not-an-invoice": 1,
      "no-entities": 1,
      "evaluation-failed": 1,
      "write-rejected": 0,
    };
    expect(run.outcomes).toEqual(expected);

    // Every candidate is in exactly one bucket — a File can never be absent.
    expect(totalOutcomes(run)).toBe(run.candidates);
    expect(run.candidates).toBe(6);
    expect(run.evaluated).toBe(3);
    expect(run.neverEvaluated).toBe(3);

    // A run holding a File it could neither write nor legitimately skip is a
    // failed run, not a success with a short report.
    expect(run.complete).toBe(false);
    expect(run.failures).toEqual([
      expect.objectContaining({
        fileId: "f-evaluation-failed",
        outcome: "evaluation-failed",
      }),
    ]);

    expect(await directionOf("f-written")).toBe("incoming");
    // The File whose derivation threw keeps what it had, and is named for it.
    expect(await updatedAtOf("f-evaluation-failed")).toBe(PRE_RUN.toDate().toISOString());
  });

  it("attributes a refused write to the File that caused it and writes the rest", async () => {
    await seedFile("w-1");
    await seedFile("w-2");
    await seedFile("w-3");
    // w-2's write will be refused. What it is refused for does not matter —
    // in #158 it was an `undefined` in the payload; here the document is gone.
    await db.collection("files").doc("w-2").delete();
    await drainTriggers();

    const ledger = new SweepLedger();
    const planned: PlannedFileWrite[] = ["w-1", "w-2", "w-3"].map((fileId) => {
      ledger.candidate();
      return {
        ref: db
          .collection("files")
          .doc(fileId) as unknown as FirebaseFirestore.DocumentReference,
        fileId,
        updates: { invoiceDirection: "incoming", updatedAt: Timestamp.now() },
        direction: "incoming" as const,
        affectedTransactionIds: [],
      };
    });

    // The chunk committer behaves exactly as the self-host batch does: ops
    // apply in order and the first refusal drops the rest of the batch. That
    // is the shape that made #158 read as an arbitrary minority of Files
    // being skipped, with the run reporting a clean count.
    const affected = await commitSweepWrites(
      planned,
      ledger,
      async (chunk) => {
        for (const write of chunk) await write.ref.update(write.updates);
      },
      500
    );

    const summary = ledger.summarise("run-under-test", USER);
    expect(summary.outcomes.written).toBe(2);
    expect(summary.outcomes["write-rejected"]).toBe(1);
    expect(totalOutcomes(summary)).toBe(summary.candidates);
    expect(summary.complete).toBe(false);
    expect(summary.failures).toEqual([
      expect.objectContaining({ fileId: "w-2", outcome: "write-rejected" }),
    ]);
    expect(summary.failures[0].message).toMatch(/w-2/);

    // The Files behind the refusal are written, not dropped.
    expect(await directionOf("w-1")).toBe("incoming");
    expect(await directionOf("w-3")).toBe("incoming");
    // And nothing downstream is told a documentation state moved.
    expect(affected.size).toBe(0);
  });

  it("separates a File evaluated and left unknown from one never evaluated", async () => {
    // Nobody on this document is the user and a third party is named as the
    // recipient: evaluated, and honestly undecidable.
    await seedFile("f-forwarded", {
      extractedRecipient: { name: "Some Other KG" },
    });
    await seedFile("f-never-read", { extractionComplete: false });
    await drainTriggers();

    await editIdentity(["AT611904300234573201"]);

    const run = workingRun(await sweepRuns());
    expect(await directionOf("f-forwarded")).toBe("unknown");
    // Evaluated and left unknown: counted as a direction, not as a gap.
    expect(run.byDirection.unknown).toBe(1);
    expect(run.evaluated).toBe(1);
    // Never evaluated: no direction, and a reason.
    expect(run.outcomes["extraction-incomplete"]).toBe(1);
    expect(run.neverEvaluated).toBe(1);
    expect(run.complete).toBe(true);
  });

  it("writes nothing and reports every File as already correct on a second run", async () => {
    await seedFile("f-a");
    await seedFile("f-b");
    await drainTriggers();

    await editIdentity(["AT611904300234573201"]);
    const afterFirst = await Promise.all([updatedAtOf("f-a"), updatedAtOf("f-b")]);
    const seen = new Set((await sweepRuns()).map((r) => r.runId));

    // A second matching-relevant edit over a corpus that is already correct.
    await editIdentity(["AT611904300234573201", "AT483200000012345864"]);

    const rerun = (await sweepRuns()).filter((r) => !seen.has(r.runId));
    expect(rerun).toHaveLength(1);
    expect(rerun[0].outcomes).toEqual({
      written: 0,
      "already-correct": 2,
      "extraction-incomplete": 0,
      "not-an-invoice": 0,
      "no-entities": 0,
      "evaluation-failed": 0,
      "write-rejected": 0,
    });
    expect(rerun[0].complete).toBe(true);
    expect(await Promise.all([updatedAtOf("f-a"), updatedAtOf("f-b")])).toEqual(afterFirst);
  });

  it("clears the partner fields the new counterparty does not carry", async () => {
    // The four partner fields mirror the counterparty, and this sweep is what
    // re-points them when the identity moves. A counterparty block that prints
    // no VAT ID must therefore leave none behind, or the File keeps the
    // previous counterparty's identifiers and partner matching — which this
    // sweep re-arms — matches on them.
    await seedFile("f-stale", {
      extractedIssuer: {
        name: "ACME Handels GmbH",
        vatId: null,
        iban: null,
        address: null,
        website: null,
      },
      extractedVatId: "ATU00000000",
      extractedIban: "AT611904300234573201",
    });
    await drainTriggers();

    await editIdentity(["AT483200000012345864"]);

    const file = (await db.collection("files").doc("f-stale").get()).data()!;
    expect(file.invoiceDirection).toBe("incoming");
    expect(file.extractedVatId).toBeNull();
    expect(file.extractedIban).toBeNull();
  });

  it("sweeps only the Files the user owns", async () => {
    await seedFile("mine");
    await seedFile("theirs", { userId: "somebody-else" });
    await drainTriggers();

    await editIdentity(["AT611904300234573201"]);

    const run = workingRun(await sweepRuns());
    // The candidate set is every File THIS user owns. It is now read without
    // the extraction filter, so the owner filter is the only thing keeping
    // another tenant's corpus out of the run.
    expect(run.candidates).toBe(1);
    expect(await directionOf("theirs")).toBe("unknown");
    expect(await updatedAtOf("theirs")).toBe(PRE_RUN.toDate().toISOString());
  });

  it("reports a complete run over an empty corpus", async () => {
    const seen = new Set((await sweepRuns()).map((r) => r.runId));

    await editIdentity(["AT611904300234573201"]);

    const runs = (await sweepRuns()).filter((r) => !seen.has(r.runId));
    expect(runs).toHaveLength(1);
    expect(runs[0].candidates).toBe(0);
    expect(totalOutcomes(runs[0])).toBe(0);
    // Nothing to do is a whole run, not an unfinished one.
    expect(runs[0].complete).toBe(true);
  });

  it("keeps the run inspectable after it finished", async () => {
    await seedFile("f-a");
    await drainTriggers();

    await editIdentity(["AT611904300234573201"]);

    const run = workingRun(await sweepRuns());
    // Read straight back out of Firestore, by the id the run recorded.
    const stored = await db
      .collection(`users/${USER}/directionSweeps`)
      .doc(run.runId)
      .get();
    expect(stored.exists).toBe(true);
    expect(stored.data()!.userId).toBe(USER);
    expect(stored.data()!.candidates).toBe(1);
    expect(stored.data()!.complete).toBe(true);
  });
});
