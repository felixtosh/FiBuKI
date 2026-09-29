// Standalone Jev spike for FiBuKI. Runs four task suites against
// api.typesafe.ai and reports accuracy, calibration, latency, tokens, cost.
// Usage: node eval.mjs [--task=docs|columns|partners|match|fanout|all]

import {
  DOC_TYPES, DOCS, COLUMN_FIELDS, CSVS,
  PARTNER_CANDIDATES, PARTNER_CASES, MATCH_CASES,
} from "./dataset.mjs";

const API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) { console.error("TYPESAFE_API_KEY not set"); process.exit(1); }

const BASE = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const PRICE_PER_M_INPUT = 0.042; // reported launch pricing, output free

async function callJev(state, questions, { retries = 4 } = {}) {
  const body = JSON.stringify({ state, model: MODEL, questions });
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(BASE, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const latencyMs = performance.now() - t0;
    if (res.status === 429 || res.status === 529) {
      if (attempt >= retries) throw new Error(`throttled after ${retries} retries (${res.status})`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    const json = JSON.parse(text);
    return { json, latencyMs };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded concurrency so we measure per-call latency, not queueing.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const stats = { calls: 0, inputTokens: 0, outputTokens: 0, latencies: [], typeErrors: [] };

function record(result, validKeysByQuestion) {
  stats.calls++;
  stats.latencies.push(result.latencyMs);
  const u = result.json.usage || {};
  stats.inputTokens += u.input_tokens ?? 0;
  stats.outputTokens += u.output_tokens ?? 0;
  // Verify the "type correctness by design" claim: every choice answer must be
  // one of the criteria keys we sent.
  for (const [qKey, valid] of Object.entries(validKeysByQuestion || {})) {
    const ans = result.json.answers?.[qKey];
    if (ans?.type === "choice" && !valid.includes(ans.choice)) {
      stats.typeErrors.push({ qKey, got: ans.choice });
    }
  }
}

function pct(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function summarizeRows(rows) {
  const strict = rows.filter((r) => r.strictOk).length;
  const lenient = rows.filter((r) => r.lenientOk).length;
  const confOk = rows.filter((r) => r.strictOk && r.confidence != null).map((r) => r.confidence);
  const confBad = rows.filter((r) => !r.strictOk && r.confidence != null).map((r) => r.confidence);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    n: rows.length, strict, lenient,
    strictAcc: +(strict / rows.length).toFixed(3),
    lenientAcc: +(lenient / rows.length).toFixed(3),
    meanConfWhenCorrect: mean(confOk)?.toFixed(3) ?? "-",
    meanConfWhenWrong: mean(confBad)?.toFixed(3) ?? "-",
  };
}

function printRows(title, rows, summary) {
  console.log(`\n=== ${title} ===`);
  for (const r of rows) {
    const mark = r.strictOk ? "OK " : r.lenientOk ? "~ok" : "MISS";
    console.log(`${mark}  ${r.id.padEnd(28)} expected=${String(r.expected).padEnd(14)} got=${String(r.got).padEnd(14)} conf=${r.confidence != null ? r.confidence.toFixed(2) : "-"} ${r.latencyMs ? Math.round(r.latencyMs) + "ms" : ""}`);
  }
  console.log("summary:", JSON.stringify(summary));
}

// --- Task 1: document type classification, one call per doc ---
async function runDocs() {
  const questions = { docType: { type: "choice", instructions: "What kind of business document is this? It may be German (Austrian) or English.", criteria: DOC_TYPES } };
  const valid = { docType: Object.keys(DOC_TYPES) };
  const rows = await mapLimit(DOCS, 4, async (doc) => {
    try {
      const result = await callJev(doc.text, questions);
      record(result, valid);
      const ans = result.json.answers.docType;
      const got = ans.choice;
      return {
        id: doc.id, expected: doc.expected, got, confidence: ans.confidence,
        latencyMs: result.latencyMs,
        strictOk: got === doc.expected,
        lenientOk: got === doc.expected || (doc.accept || []).includes(got),
      };
    } catch (e) {
      return { id: doc.id, expected: doc.expected, got: `ERROR:${e.message.slice(0, 60)}`, strictOk: false, lenientOk: false };
    }
  });
  printRows("Document type classification", rows, summarizeRows(rows));
  return rows;
}

// --- Task 2: CSV column matching, one call per CSV with fan-out questions ---
async function runColumns() {
  const rows = [];
  for (const csv of CSVS) {
    const state = {
      description: "Columns of a bank transaction CSV export. Each entry: header plus sample values.",
      columns: csv.columns.map((c) => ({ header: c.header, samples: c.samples })),
    };
    const questions = {};
    for (const c of csv.columns) {
      questions[c.header] = {
        type: "choice",
        instructions: `Which import field does the CSV column \`${c.header}\` (see its samples in state) map to?`,
        criteria: COLUMN_FIELDS,
      };
    }
    const valid = Object.fromEntries(csv.columns.map((c) => [c.header, Object.keys(COLUMN_FIELDS)]));
    try {
      const result = await callJev(state, questions);
      record(result, valid);
      for (const c of csv.columns) {
        const ans = result.json.answers[c.header];
        rows.push({
          id: `${csv.id}/${c.header}`, expected: c.expected, got: ans?.choice,
          confidence: ans?.confidence, latencyMs: result.latencyMs / csv.columns.length,
          strictOk: ans?.choice === c.expected,
          lenientOk: ans?.choice === c.expected || (c.accept || []).includes(ans?.choice),
        });
      }
    } catch (e) {
      for (const c of csv.columns) rows.push({ id: `${csv.id}/${c.header}`, expected: c.expected, got: `ERROR:${e.message.slice(0, 60)}`, strictOk: false, lenientOk: false });
    }
  }
  printRows("CSV column matching (fan-out per file)", rows, summarizeRows(rows));
  return rows;
}

// --- Task 3: partner matching ---
async function runPartners() {
  const questions = { partner: { type: "choice", instructions: "Which existing partner (bookkeeping counterparty) does this document/transaction belong to? Pick `none` if no candidate is the same company.", criteria: PARTNER_CANDIDATES } };
  const valid = { partner: Object.keys(PARTNER_CANDIDATES) };
  const rows = await mapLimit(PARTNER_CASES, 4, async (c) => {
    try {
      const result = await callJev(c.state, questions);
      record(result, valid);
      const ans = result.json.answers.partner;
      return {
        id: c.id, expected: c.expected, got: ans.choice, confidence: ans.confidence,
        latencyMs: result.latencyMs,
        strictOk: ans.choice === c.expected,
        lenientOk: ans.choice === c.expected || (c.accept || []).includes(ans.choice),
      };
    } catch (e) {
      return { id: c.id, expected: c.expected, got: `ERROR:${e.message.slice(0, 60)}`, strictOk: false, lenientOk: false };
    }
  });
  printRows("Partner matching", rows, summarizeRows(rows));
  return rows;
}

// --- Task 4: file-transaction match verification (Noul) ---
async function runMatch() {
  const questions = {
    isMatch: {
      type: "noul",
      instructions: "Is this document the receipt/invoice belonging to this bank transaction? Consider: amounts can differ by tips; card bookings settle 1-3 days after the receipt date; vendor names may differ between bank text and document.",
      criteria: { true: "Same purchase: vendor, amount and timing are consistent", false: "Different purchase, vendor, period or currency" },
    },
  };
  const rows = await mapLimit(MATCH_CASES, 4, async (c) => {
    try {
      const result = await callJev(c.state, questions);
      record(result, {});
      const p = result.json.answers.isMatch.noul;
      const got = p >= 0.5;
      return {
        id: c.id, expected: c.expected, got: `${got} (p=${p.toFixed(2)})`, confidence: Math.abs(p - 0.5) * 2,
        latencyMs: result.latencyMs,
        strictOk: got === c.expected,
        lenientOk: got === c.expected || (c.accept || []).includes(got),
      };
    } catch (e) {
      return { id: c.id, expected: c.expected, got: `ERROR:${e.message.slice(0, 60)}`, strictOk: false, lenientOk: false };
    }
  });
  printRows("File-transaction match verification (noul)", rows, summarizeRows(rows));
  return rows;
}

// --- Task 5: fan-out efficiency, same doc classified 1-question vs 6-question batch ---
async function runFanout() {
  const doc = DOCS[0].text;
  const single = { docType: { type: "choice", instructions: "What kind of business document is this?", criteria: DOC_TYPES } };
  const batched = {
    docType: single.docType,
    hasVat: { type: "noul", instructions: "Does the document show a VAT amount (USt/MwSt)?", criteria: { true: "VAT amount printed", false: "No VAT shown" } },
    isAustrian: { type: "noul", instructions: "Is the issuer an Austrian business (ATU VAT id, Austrian address)?", criteria: { true: "Austrian issuer", false: "Not Austrian" } },
    quality: { type: "score", instructions: "How complete is this document for bookkeeping (issuer, date, amount, VAT)?", criteria: ["Unusable", "Missing key fields", "Complete"] },
    isPaid: { type: "noul", instructions: "Does the document state it was already paid?", criteria: { true: "Marked paid", false: "Payment still due or unstated" } },
    lang: { type: "choice", instructions: "Main language of the document", criteria: { de: "German", en: "English", other: "Other" } },
  };
  const a = await callJev(doc, single); record(a, {});
  const b = await callJev(doc, batched); record(b, {});
  console.log("\n=== Fan-out efficiency (same document) ===");
  console.log(`1 question : ${Math.round(a.latencyMs)}ms, tokens in/out ${a.json.usage?.input_tokens}/${a.json.usage?.output_tokens}`);
  console.log(`6 questions: ${Math.round(b.latencyMs)}ms, tokens in/out ${b.json.usage?.input_tokens}/${b.json.usage?.output_tokens}`);
  console.log("6-question answers:", JSON.stringify(b.json.answers));
}

const task = (process.argv.find((a) => a.startsWith("--task=")) || "--task=all").split("=")[1];
const t0 = performance.now();
if (task === "all" || task === "docs") await runDocs();
if (task === "all" || task === "columns") await runColumns();
if (task === "all" || task === "partners") await runPartners();
if (task === "all" || task === "match") await runMatch();
if (task === "all" || task === "fanout") await runFanout();

console.log("\n=== Totals ===");
console.log(`calls: ${stats.calls}, wall time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`latency ms: p50=${Math.round(pct(stats.latencies, 50))} p90=${Math.round(pct(stats.latencies, 90))} max=${Math.round(Math.max(0, ...stats.latencies))}`);
console.log(`tokens: input=${stats.inputTokens} output=${stats.outputTokens}`);
console.log(`cost: $${((stats.inputTokens / 1e6) * PRICE_PER_M_INPUT).toFixed(6)} (at $${PRICE_PER_M_INPUT}/M input, output free)`);
console.log(`choice type violations: ${stats.typeErrors.length}${stats.typeErrors.length ? " " + JSON.stringify(stats.typeErrors) : ""}`);
