/**
 * Corpus check for the § 11 document classifier (#104).
 *
 * A unit test proves the rule table does what it says. It cannot prove the
 * rule table is right about the documents that actually exist. This runs the
 * classifier read-only over every stored file and prints the DISTRIBUTION —
 * never document text, so the output is safe to paste into an issue.
 *
 * The failure signal it exists for: most of the zero-VAT population is
 * reverse-charge or exempt, NOT receipts. A run that classifies the bulk of
 * those files as receipts is a failed rule table, not a discovered problem —
 * it would fill the chase queue with work that does not exist.
 *
 * Read-only. It calls one listing tool and writes nothing.
 *
 *   FIBUKI_MCP_URL=… FIBUKI_API_KEY=… \
 *     npx vite-node scripts/check-document-type-corpus.ts
 *
 * Add `--receipts` to also list the chase queue (file name, amount, and the
 * § 11 elements missing) — still no document text.
 */

import { classifyFileRecord } from "../src/documents/adapter";

const url = process.env.FIBUKI_MCP_URL;
const apiKey = process.env.FIBUKI_API_KEY;

if (!url || !apiKey) {
  console.error("Set FIBUKI_MCP_URL and FIBUKI_API_KEY (see ~/.secrets/fibuki.env).");
  process.exit(1);
}

interface FileRow {
  fileName?: string;
  extractedAmount?: number | null;
  extractedCurrency?: string | null;
  extractedVatPercent?: number | null;
  extractedRateGroups?: Array<{ rate?: number | null }> | null;
  extractedLineItems?: Array<{ vatPercent?: number | null }> | null;
  [key: string]: unknown;
}

async function callTool(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(url!, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ tool, arguments: args }),
  });
  if (!res.ok) {
    throw new Error(`${tool} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { result?: Record<string, unknown> };
  return body.result ?? (body as Record<string, unknown>);
}

/** Does the document print any positive VAT rate anywhere extraction looked? */
function printsNoRate(file: FileRow): boolean {
  const rates = [
    file.extractedVatPercent,
    ...(file.extractedRateGroups ?? []).map((g) => g?.rate),
    ...(file.extractedLineItems ?? []).map((i) => i?.vatPercent),
  ];
  return !rates.some((rate) => typeof rate === "number" && rate > 0);
}

function tally(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

async function main(): Promise<void> {
  const files: FileRow[] = [];
  let cursor: string | undefined;

  do {
    const page = await callTool("list_files", { limit: 200, ...(cursor ? { cursor } : {}) });
    files.push(...((page.files as FileRow[]) ?? []));
    cursor = (page.nextCursor as string | null) ?? undefined;
  } while (cursor);

  const byType: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const zeroVatByType: Record<string, number> = {};
  let zeroVat = 0;

  for (const file of files) {
    const result = classifyFileRecord(file);
    tally(byType, result.type);
    tally(byReason, result.basis.reason);

    if (printsNoRate(file)) {
      zeroVat++;
      tally(zeroVatByType, result.type);
    }
  }

  console.log(`files: ${files.length}`);
  console.log("type:", JSON.stringify(byType));
  console.log("reason:", JSON.stringify(byReason));
  console.log(`zero-VAT population: ${zeroVat}`);
  console.log("  of which by type:", JSON.stringify(zeroVatByType));

  const receiptShare = zeroVat === 0 ? 0 : (zeroVatByType.receipt ?? 0) / zeroVat;
  if (receiptShare > 0.5) {
    console.error(
      `\nFAILED RULE TABLE: ${Math.round(receiptShare * 100)}% of the zero-VAT population ` +
      `classified as receipts. That population is dominated by reverse charge and exemption, ` +
      `not by payment confirmations.`
    );
    process.exitCode = 1;
  }

  if (process.argv.includes("--receipts")) {
    console.log("\n--- receipts (the chase queue) ---");
    for (const file of files) {
      const result = classifyFileRecord(file);
      if (result.type !== "receipt") continue;
      const amount = ((file.extractedAmount ?? 0) / 100).toFixed(2);
      console.log(
        `${(file.fileName ?? "").slice(0, 46).padEnd(46)} ${amount.padStart(10)} ` +
        `${file.extractedCurrency ?? "?"} | ${result.basis.reason} | ${result.missingElements.join(",")}`
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
