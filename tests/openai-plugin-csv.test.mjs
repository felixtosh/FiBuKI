import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = "integrations/openai-plugin/scripts/fibuki-csv.mjs";
const FIXTURES = "tests/fixtures/openai-plugin";

function run(args, env = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, json: JSON.parse(result.stdout) };
}

function convert(fixture, columns, extra = []) {
  const out = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
  return run(["convert", `${FIXTURES}/${fixture}`, ...columns, "--out", out, ...extra]);
}

test("the committed bundle matches lib/import and src (run build.mjs after changing either)", () => {
  execFileSync("node", ["integrations/openai-plugin/build.mjs", "--check"], { stdio: "pipe" });
});

test("analyze: reads a Windows-1252 export (umlauts, semicolons, German amounts)", () => {
  const { json } = run(["analyze", `${FIXTURES}/george-cp1252.csv`]);
  assert.equal(json.encoding, "windows-1252");
  assert.equal(json.delimiter, ";");
  assert.equal(json.totalRows, 4);
  const byName = Object.fromEntries(json.columns.map((c) => [c.name, c]));
  assert.equal(byName.Buchungsdatum.dateFormat, "de");
  assert.equal(byName.Betrag.amountFormat, "de");
  // Names and IBANs must not be offered as amount columns.
  assert.equal(byName.Partnername.amountFormat, null);
  assert.equal(byName["Partner IBAN"].amountFormat, null);
});

test("convert: German amounts to cents, sign kept, umlauts decoded", () => {
  const { json } = convert("george-cp1252.csv", [
    "--date", "Buchungsdatum", "--amount", "Betrag", "--name", "Buchungstext",
    "--partner", "Partnername", "--iban", "Partner IBAN", "--reference", "Zahlungsreferenz",
  ]);
  assert.equal(json.ok, true);
  assert.deepEqual(json.preview.map((t) => t.amount), [-5420, -3990, 341255, -98000]);
  assert.equal(json.preview[0].date, "2026-09-01");
  assert.equal(json.preview[2].partner, "Müller Consulting GmbH");
  assert.equal(json.preview[1].partnerIban, "AT611904300234573201");
  assert.equal(json.incomeCents, 341255);
  assert.equal(json.expenseCents, -5420 - 3990 - 98000);
});

test("convert: a dot-decimal column is not read 100 times too large", () => {
  const { json } = convert("n26-utf8.csv", ["--date", "Date", "--amount", "Amount (EUR)", "--name", "Payee"]);
  assert.equal(json.amountFormat, "us");
  assert.deepEqual(json.preview.map((t) => t.amount), [-8999, -6410, 2500]);
});

test("convert: separate Soll/Haben columns become one signed amount, two-digit years read", () => {
  const { json } = convert("legacy-soll-haben.csv", [
    "--date", "Valuta", "--debit", "Soll", "--credit", "Haben", "--name", "Text",
  ]);
  assert.deepEqual(json.preview.map((t) => [t.date, t.amount]), [
    ["2026-09-22", -4580],
    ["2026-09-26", 240000],
    ["2026-09-27", -12000],
  ]);
});

test("convert: --after drops rows on or before the cutoff and counts them", () => {
  const { json } = convert(
    "george-cp1252.csv",
    ["--date", "Buchungsdatum", "--amount", "Betrag", "--name", "Buchungstext"],
    ["--after", "2026-09-03"]
  );
  assert.equal(json.valid, 2);
  assert.equal(json.outsideRange, 2);
  assert.equal(json.firstDate, "2026-09-15");
});

test("convert: a swapped day/month format is refused instead of filing dates under the wrong month", () => {
  const dir = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
  const file = join(dir, "swapped.csv");
  writeFileSync(file, "Datum;Betrag;Text\n13/09/2026;-1,00;a\n14/09/2026;-2,00;b\n");
  const { code, json } = run(["convert", file, "--date", "Datum", "--amount", "Betrag", "--name", "Text", "--date-format", "us", "--out", dir]);
  assert.equal(code, 1);
  assert.equal(json.ok, false);
  assert.match(json.error, /swapped/);
});

test("convert: a running balance column confirms the amounts over every row", () => {
  const { json } = convert("george-cp1252.csv", [
    "--date", "Buchungsdatum", "--amount", "Betrag", "--name", "Buchungstext", "--balance", "Saldo",
  ]);
  assert.deepEqual(json.balanceCheck, { checked: 3, matched: 3, direction: "oldest-first" });
  assert.deepEqual(json.warnings, []);
});

test("convert: a balance column in newest-first order reconciles too", () => {
  const dir = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
  const file = join(dir, "newest-first.csv");
  writeFileSync(file, "Datum;Betrag;Text;Saldo\n17.09.2026;-980,00;Miete;6.762,20\n15.09.2026;3.412,55;Honorar;7.742,20\n03.09.2026;-39,90;A1;4.329,65\n01.09.2026;-54,20;REWE;4.369,55\n");
  const { json } = run(["convert", file, "--date", "Datum", "--amount", "Betrag", "--name", "Text", "--balance", "Saldo", "--out", dir]);
  assert.equal(json.balanceCheck.direction, "newest-first");
  assert.equal(json.balanceCheck.matched, json.balanceCheck.checked);
  assert.deepEqual(json.warnings, []);
});

test("convert: amounts that do not add up to the balance are flagged (wrong sign, wrong column)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
  const file = join(dir, "card.csv");
  // A credit card export that lists spending as positive while the balance falls.
  writeFileSync(file, "Datum;Betrag;Text;Saldo\n01.09.2026;54,20;REWE;945,80\n03.09.2026;39,90;A1;905,90\n15.09.2026;120,00;Shell;785,90\n17.09.2026;980,00;Miete;-194,10\n");
  const { json } = run(["convert", file, "--date", "Datum", "--amount", "Betrag", "--name", "Text", "--balance", "Saldo", "--date-format", "de", "--out", dir]);
  assert.equal(json.ok, true);
  assert.equal(json.balanceCheck.matched, 0);
  assert.match(json.warnings[0], /does not add up/);
});

test("convert: a format that reads the decimal mark the wrong way round is refused over all rows", () => {
  const { code, json } = convert(
    "n26-utf8.csv",
    ["--date", "Date", "--amount", "Amount (EUR)", "--name", "Payee"],
    ["--amount-format", "de"]
  );
  assert.equal(code, 1);
  assert.match(json.error, /factor of 100/);
  assert.equal(json.decimalMarkInValues, ".");
  assert.match(json.hint, /--amount-format us/);
});

test("convert: a German file is not mistaken for a dot-decimal one by the same check", () => {
  const { code, json } = convert("george-cp1252.csv", [
    "--date", "Buchungsdatum", "--amount", "Betrag", "--name", "Buchungstext", "--amount-format", "de",
  ]);
  assert.equal(code, 0);
  assert.equal(json.ok, true);
});

test("convert: unreadable rows are listed, not silently dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
  const file = join(dir, "bad.csv");
  writeFileSync(file, "Datum;Betrag;Text\n01.09.2026;-1,00;ok\nnicht-datum;-2,00;bad date\n02.09.2026;;no amount\n03.09.2026;-3,00;\n");
  const { json } = run(["convert", file, "--date", "Datum", "--amount", "Betrag", "--name", "Text", "--date-format", "de", "--amount-format", "de", "--out", dir]);
  assert.equal(json.valid, 1);
  assert.deepEqual(json.skipped.map((s) => s.row), [2, 3, 4]);
});

test("--skip drops lines above the table (account holder, period)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
  const file = join(dir, "preamble.csv");
  writeFileSync(file, "Kontoinhaber;Max Muster\nZeitraum;09/2026\nDatum;Betrag;Text\n01.09.2026;-1,50;Kaffee\n02.09.2026;-2,00;Tee\n03.09.2026;-3,00;Brot\n");
  const { json } = run(["analyze", file, "--skip", "2"]);
  assert.deepEqual(json.columns.map((c) => c.name), ["Datum", "Betrag", "Text"]);
  assert.equal(json.totalRows, 3);
  const converted = run(["convert", file, "--skip", "2", "--date", "Datum", "--amount", "Betrag", "--name", "Text", "--date-format", "de", "--out", dir]);
  assert.deepEqual(converted.json.preview.map((t) => t.amount), [-150, -200, -300]);
});

test("convert: ambiguous dates are not guessed; the answer says how to resolve it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
  const file = join(dir, "ambiguous.csv");
  writeFileSync(file, "Datum;Betrag;Text\n01.09.2026;-1,50;a\n02.09.2026;-2,00;b\n03.09.2026;-3,00;c\n");
  const { code, json } = run(["convert", file, "--date", "Datum", "--amount", "Betrag", "--name", "Text", "--out", dir]);
  assert.equal(code, 1);
  assert.match(json.error, /date format/);
  assert.match(json.hint, /--date-format de/);
});

function fakeApi(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const call = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
        calls.push(call);
        const { status, json } = handler(call, calls.length);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    server.listen(0, () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const importArgs = ["--date", "Buchungsdatum", "--amount", "Betrag", "--name", "Buchungstext", "--chunk", "3", "--import", "--source", "src1"];

/** The server must keep answering while the CLI runs, so no spawnSync here. */
function runAsync(args, env) {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } }, (error, stdout) => {
      resolve({ code: error ? error.code : 0, json: JSON.parse(stdout) });
    });
  });
}

test("--import posts chunks to import_transactions with the API key and reports the total", async () => {
  const api = await fakeApi((call) => ({
    status: 200,
    json: { success: true, result: { success: true, count: call.body.arguments.transactions.length, overLimitCount: 0 } },
  }));
  try {
    const out = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
    const { code, json } = await runAsync(
      ["convert", `${FIXTURES}/george-cp1252.csv`, ...importArgs, "--out", out],
      { FIBUKI_API_KEY: "fk_test", FIBUKI_BASE_URL: api.url }
    );
    assert.equal(code, 0);
    assert.equal(json.imported, 4);
    assert.equal(json.alreadyImported, 0);
    assert.equal(api.calls.length, 2); // 4 rows in chunks of 3
    // One import id across the chunks, so identical lines of the file are not taken for duplicates.
    assert.match(api.calls[0].body.arguments.importJobId, /^api_csv_/);
    assert.equal(api.calls[0].body.arguments.importJobId, api.calls[1].body.arguments.importJobId);
    assert.equal(json.importJobId, api.calls[0].body.arguments.importJobId);
    assert.equal(api.calls[0].url, "/api/mcp");
    assert.equal(api.calls[0].auth, "Bearer fk_test");
    assert.equal(api.calls[0].body.tool, "import_transactions");
    assert.equal(api.calls[0].body.arguments.sourceId, "src1");
    assert.equal(api.calls[0].body.arguments.transactions[0].amount, -5420);
  } finally {
    api.server.close();
  }
});

test("--import stops at a failing chunk and says which, so nothing is sent twice", async () => {
  const api = await fakeApi((call, n) =>
    n === 1
      ? { status: 200, json: { success: true, result: { success: true, count: 3, overLimitCount: 0 } } }
      : { status: 400, json: { success: false, error: "This tool requires a plan upgrade" } }
  );
  try {
    const out = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
    const { code, json } = await runAsync(
      ["convert", `${FIXTURES}/george-cp1252.csv`, ...importArgs, "--out", out],
      { FIBUKI_API_KEY: "fk_test", FIBUKI_BASE_URL: api.url }
    );
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.match(json.error, /chunk 2 of 2/);
    assert.equal(json.importedBeforeFailure, 3);
    assert.equal(json.chunksDone, 1);
    assert.match(json.resumeWithChunk, /chunk-002\.json$/);
    assert.match(json.resumeWithImportJobId, /^api_csv_/);
    assert.deepEqual(JSON.parse(readFileSync(json.resumeWithChunk, "utf8")).map((t) => t.amount), [-98000]);
  } finally {
    api.server.close();
  }
});

test("--import reports how many lines FiBuKI skipped as already imported", async () => {
  const api = await fakeApi((call) => ({
    status: 200,
    json: { success: true, result: { count: 1, duplicateCount: call.body.arguments.transactions.length - 1 } },
  }));
  try {
    const out = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
    const { json } = await runAsync(
      ["convert", `${FIXTURES}/george-cp1252.csv`, ...importArgs, "--chunk", "10", "--out", out, "--import-job-id", "mine"],
      { FIBUKI_API_KEY: "fk_test", FIBUKI_BASE_URL: api.url }
    );
    assert.equal(json.imported, 1);
    assert.equal(json.alreadyImported, 3);
    assert.equal(json.importJobId, "mine");
    assert.equal(api.calls[0].body.arguments.importJobId, "mine");
  } finally {
    api.server.close();
  }
});

test("--import waits out a 429 and retries the same chunk", async () => {
  const api = await fakeApi((call, n) =>
    n === 1
      ? { status: 429, json: { success: false, error: "Rate limit exceeded", retryAfter: 0 } }
      : { status: 200, json: { success: true, result: { count: call.body.arguments.transactions.length } } }
  );
  try {
    const out = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
    const { code, json } = await runAsync(
      ["convert", `${FIXTURES}/george-cp1252.csv`, ...importArgs, "--chunk", "10", "--out", out],
      { FIBUKI_API_KEY: "fk_test", FIBUKI_BASE_URL: api.url }
    );
    assert.equal(code, 0);
    assert.equal(json.imported, 4);
    assert.equal(api.calls.length, 2);
    assert.deepEqual(api.calls[0].body, api.calls[1].body);
  } finally {
    api.server.close();
  }
});

test("--import without a key or source fails before sending anything", async () => {
  const out = mkdtempSync(join(tmpdir(), "fibuki-csv-"));
  const noKey = await runAsync(["convert", `${FIXTURES}/george-cp1252.csv`, ...importArgs, "--out", out], { FIBUKI_API_KEY: "" });
  assert.equal(noKey.json.ok, false);
  assert.match(noKey.json.error, /FIBUKI_API_KEY/);
});
