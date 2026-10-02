/**
 * The HTML-to-PDF renderer in a REAL Chromium, with a stand-in for an internal service listening
 * on loopback. The HTML is attacker-controlled (the convertHtmlToPdf callable takes it from the
 * caller, inbound email from anyone who can write to a user's address), so nothing in it may make
 * the browser call that service or put its answer into the PDF.
 *
 * Skipped when no Chromium is installed (set FIBUKI_CHROME_PATH to run it elsewhere).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync } from "fs";
import http from "http";
import type { AddressInfo } from "net";
import { PDFParse } from "pdf-parse";

const CHROME = [
  process.env.FIBUKI_CHROME_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((p): p is string => !!p && existsSync(p));

const SECRET = "INTERNAL-SECRET-4711";
// A 1x1 PNG, so an <img> or CSS background gets something an image decoder accepts.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let internal: http.Server;
let base = "";
const hits: string[] = [];

beforeAll(async () => {
  if (!CHROME) return;
  process.env.FIBUKI_CHROME_PATH = CHROME;
  internal = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (req.url?.endsWith(".png")) {
      res.writeHead(200, { ...headers, "Content-Type": "image/png" }).end(PNG);
    } else if (req.url?.endsWith(".css")) {
      res.writeHead(200, { ...headers, "Content-Type": "text/css" }).end(`body::after { content: "${SECRET}"; }`);
    } else {
      res.writeHead(200, { ...headers, "Content-Type": "text/html" }).end(`<html><body><h1>${SECRET}</h1></body></html>`);
    }
  });
  await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!CHROME) return;
  const { closeBrowser } = await import("./htmlToPdf");
  await closeBrowser();
  internal.closeAllConnections();
  await new Promise((resolve) => internal.close(resolve));
}, 30_000);

beforeEach(() => {
  hits.length = 0;
});

async function render(html: string): Promise<string> {
  const { convertHtmlToPdf } = await import("./htmlToPdf");
  const { pdfBuffer } = await convertHtmlToPdf(html);
  return (await new PDFParse({ data: pdfBuffer }).getText()).text;
}

describe.skipIf(!CHROME)("convertHtmlToPdf cannot be used to reach the network behind us", () => {
  const attacks: Record<string, (url: string) => string> = {
    "an iframe": (url) => `<iframe src="${url}/page" width="600" height="200"></iframe>`,
    "an image": (url) => `<img src="${url}/logo.png">`,
    "a stylesheet": (url) => `<link rel="stylesheet" href="${url}/style.css">`,
    "a CSS background": (url) => `<div style="background:url(${url}/bg.png);width:50px;height:50px">x</div>`,
    "a CSS @import": (url) => `<style>@import url("${url}/style.css");</style>`,
    "an object": (url) => `<object data="${url}/page" type="text/html" width="600" height="200"></object>`,
    "a meta refresh": (url) => `<meta http-equiv="refresh" content="0;url=${url}/page">`,
    "a form post": (url) => `<form id="f" action="${url}/page" method="post"></form><script>document.getElementById("f").submit()</script>`,
    "script that fetches it": (url) =>
      `<script>fetch("${url}/page").then(r => r.text()).then(t => { document.body.append(t); });</script>`,
    "script that sets an image": (url) => `<script>new Image().src = "${url}/logo.png?via=script";</script>`,
  };

  for (const [name, make] of Object.entries(attacks)) {
    it(`${name} makes no request and puts nothing in the PDF`, async () => {
      const text = await render(`<html><body><p>Invoice 42</p>${make(base)}</body></html>`);
      expect(hits).toEqual([]);
      expect(text).not.toContain(SECRET);
      expect(text).toContain("Invoice 42"); // the document itself still renders
    }, 30_000);
  }
});
