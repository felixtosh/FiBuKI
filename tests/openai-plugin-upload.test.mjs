import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "integrations/openai-plugin/scripts/fibuki-upload.mjs";

function fakeApi(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const call = { auth: req.headers.authorization, body: JSON.parse(body) };
        calls.push(call);
        const { status, json } = handler(call);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    server.listen(0, () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile("node", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } }, (error, stdout) => {
      resolve({ code: error ? error.code : 0, json: JSON.parse(stdout) });
    });
  });
}

test("uploads PDFs and images as base64 upload_file calls and reports duplicates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fibuki-upload-"));
  writeFileSync(join(dir, "a1-rechnung.pdf"), "%PDF-1.4 fake");
  writeFileSync(join(dir, "bon.JPG"), "fake jpeg");
  const api = await fakeApi((call) => ({
    status: 200,
    json: {
      success: true,
      result: { success: true, fileId: `id-${call.body.arguments.fileName}`, duplicate: call.body.arguments.fileName === "bon.JPG" },
    },
  }));
  try {
    const { code, json } = await run([join(dir, "a1-rechnung.pdf"), join(dir, "bon.JPG")], {
      FIBUKI_API_KEY: "fk_test",
      FIBUKI_BASE_URL: api.url,
    });
    assert.equal(code, 0);
    assert.equal(json.uploaded, 1);
    assert.equal(json.duplicates, 1);
    assert.equal(api.calls[0].auth, "Bearer fk_test");
    assert.equal(api.calls[0].body.tool, "upload_file");
    assert.equal(api.calls[0].body.arguments.mimeType, "application/pdf");
    assert.equal(Buffer.from(api.calls[0].body.arguments.base64, "base64").toString(), "%PDF-1.4 fake");
    assert.equal(api.calls[1].body.arguments.mimeType, "image/jpeg");
  } finally {
    api.server.close();
  }
});

test("a plan without file upload is reported per file, and other files still go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fibuki-upload-"));
  writeFileSync(join(dir, "a.pdf"), "x");
  writeFileSync(join(dir, "notes.txt"), "not a document");
  const api = await fakeApi(() => ({ status: 400, json: { success: false, error: "This tool requires the fileUpload feature" } }));
  try {
    const { code, json } = await run([join(dir, "a.pdf"), join(dir, "notes.txt")], {
      FIBUKI_API_KEY: "fk_test",
      FIBUKI_BASE_URL: api.url,
    });
    assert.equal(code, 1);
    assert.equal(json.failed, 2);
    assert.match(json.results[0].error, /fileUpload/);
    assert.match(json.results[1].error, /unsupported/);
    assert.equal(api.calls.length, 1); // the .txt never leaves the machine
  } finally {
    api.server.close();
  }
});

test("refuses to run without an API key", async () => {
  const { code, json } = await run(["x.pdf"], { FIBUKI_API_KEY: "" });
  assert.equal(code, 1);
  assert.match(json.error, /FIBUKI_API_KEY/);
});
