"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { DataTable } from "@/components/transactions/data-table";
import { getTransactionColumns, type FileAmountData } from "@/components/transactions/transaction-columns";
import type { UserPartner } from "@/types/partner";
import type { TransactionSource } from "@/types/source";
import type { Transaction } from "@/types/transaction";
import { createListMotion } from "@/lib/motion/list-motion";
import { bezierCss, type LabSettings } from "./settings";

/*
 * The real Transactions table (DataTable + getTransactionColumns), fed sample
 * rows, moved by the same engine as production (lib/motion/list-motion.ts)
 * but with the lab's settings. The real table runs LIST_MOTION; the lab
 * starts from it.
 */

export interface LabRow {
  id: string;
  /** yyyy-mm-dd */
  date: string;
  counterparty: string;
  reference: string;
  amount: number;
  partner?: string;
  /** A connected File's amount; set once a File is connected. */
  fileAmount?: number;
  /** Position in the batch that is arriving; undefined = no enter animation. */
  enterIndex?: number;
  /** Bumped whenever the row's data changes. */
  version: number;
  leaving?: boolean;
}

const SOURCES = [{ id: "lab-source", name: "Revolut Business" }] as unknown as TransactionSource[];
// Old enough that the table's own "just completed" glow never plays: the lab's
// completion style stands in for it.
const LONG_AGO = new Date("2026-01-01T00:00:00Z");

const partnerId = (name: string) => `lab-partner-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function toTransaction(row: LabRow): Transaction {
  return {
    id: row.id,
    // Stored like real data: UTC midnight of the calendar day, so no time shows.
    date: new Date(`${row.date}T00:00:00Z`),
    amount: row.amount,
    currency: "EUR",
    name: row.reference,
    partner: row.counterparty,
    description: row.reference,
    sourceId: "lab-source",
    partnerId: row.partner ? partnerId(row.partner) : undefined,
    partnerType: row.partner ? "user" : undefined,
    partnerMatchedBy: row.partner ? "auto" : undefined,
    partnerMatchConfidence: row.partner ? 92 : undefined,
    fileIds: row.fileAmount !== undefined ? [`lab-file-${row.id}`] : [],
    updatedAt: LONG_AGO,
  } as unknown as Transaction;
}

const isComplete = (row: LabRow) => row.fileAmount !== undefined;

export function LabStage({
  rows,
  settings,
  slow,
  onLeft,
}: {
  rows: LabRow[];
  settings: LabSettings;
  slow: number;
  onLeft: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const motion = useRef(createListMotion());
  const timingRef = useRef({ settings, slow, onLeft });
  useLayoutEffect(() => {
    timingRef.current = { settings, slow, onLeft };
  });

  const data = useMemo(() => rows.map(toTransaction), [rows]);
  const columns = useMemo(() => {
    const names = [...new Set(rows.flatMap((row) => (row.partner ? [row.partner] : [])))];
    const partners = names.map((name) => ({ id: partnerId(name), name })) as unknown as UserPartner[];
    const files = new Map<string, FileAmountData>(
      rows
        .filter((row) => row.fileAmount !== undefined)
        .map((row) => [row.id, { totalAmount: row.fileAmount!, fileCount: 1, amounts: [{ amount: row.fileAmount!, currency: "EUR" }], hasExtractingFiles: false }])
    );
    return getTransactionColumns(SOURCES, partners, [], [], undefined, files);
  }, [rows]);

  // The same engine the real Transactions table runs (lib/motion), after
  // the table has rendered and before the browser paints.
  useLayoutEffect(() => {
    const { settings: s, slow: k, onLeft: left } = timingRef.current;
    motion.current.update(
      rootRef.current,
      rows.map((row) => ({ id: row.id, complete: isComplete(row), version: row.version, leaving: row.leaving })),
      s,
      { slow: k, onLeft: left }
    );
  }, [rows]);

  // Overrides of the two real cell animations, so the sliders tune the
  // actual CSS the cells use (and slow motion slows it too).
  const c = settings.change;
  const css = `
    .motion-lab-stage .animate-pill-pop { animation-duration: ${c.pillDuration * slow}ms; animation-timing-function: ${bezierCss(c.easing)}; }
    .motion-lab-stage .animate-check-appear { animation-duration: ${c.checkDuration * slow}ms; animation-timing-function: ${bezierCss(c.easing)}; }
  `;

  return (
    <div ref={rootRef} className="motion-lab-stage h-[560px] rounded-md border overflow-hidden">
      <style>{css}</style>
      <DataTable columns={columns} data={data} animateRows={false} />
    </div>
  );
}
