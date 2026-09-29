import test from "node:test";
import assert from "node:assert/strict";
import { securityHeaderRules } from "../lib/security/headers.js";

const CSP = "default-src 'self'";

function headersFor(path) {
  const merged = new Map();
  for (const rule of securityHeaderRules(CSP)) {
    const pattern = new RegExp(`^${rule.source.replace("(.*)", ".*")}$`);
    if (!pattern.test(path)) continue;
    for (const { key, value } of rule.headers) merged.set(key, value);
  }
  return merged;
}

test("every path carries CORP same-origin", () => {
  assert.equal(headersFor("/transactions").get("Cross-Origin-Resource-Policy"), "same-origin");
});

test("the email logo stays embeddable from webmail clients", () => {
  assert.equal(headersFor("/email-image.png").get("Cross-Origin-Resource-Policy"), "cross-origin");
});

test("COEP is declined on purpose (#255): it breaks the Google sign-in popup and document viewers", () => {
  assert.equal(headersFor("/transactions").has("Cross-Origin-Embedder-Policy"), false);
});

test("the existing headers are kept", () => {
  const h = headersFor("/");
  assert.equal(h.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
  assert.equal(h.get("X-Frame-Options"), "DENY");
  assert.equal(h.get("Content-Security-Policy"), CSP);
});
