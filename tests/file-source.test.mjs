import test from "node:test";
import assert from "node:assert/strict";
import { fileSourceKind, fileSourceView } from "../lib/files/file-source.js";

test("a legacy File with no sourceType is an upload", () => {
  assert.equal(fileSourceKind({}), "upload");
  assert.equal(fileSourceKind({ sourceType: "upload" }), "upload");
});

test("every gmail_* sourceType is a Gmail source, linked to its integration", () => {
  for (const sourceType of ["gmail", "gmail_html_invoice", "gmail_invoice_link"]) {
    assert.equal(fileSourceKind({ sourceType }), "gmail");
  }
  const view = fileSourceView({
    sourceType: "gmail",
    gmailIntegrationId: "int1",
    gmailIntegrationEmail: "me@example.com",
  });
  assert.equal(view.text, "me@example.com");
  assert.equal(view.href, "/integrations/int1");
  assert.equal(view.isMail, true);
});

test("a mail source without an address falls back to the translated default", () => {
  const view = fileSourceView({ sourceType: "gmail" });
  assert.equal(view.text, null);
  assert.equal(view.labelKey, "gmail");
  assert.equal(view.href, null);
});

test("forwarded mail links to the inbound-address page", () => {
  for (const sourceType of ["email_inbound", "email_inbound_body"]) {
    const view = fileSourceView({ sourceType });
    assert.equal(view.kind, "forwarding");
    assert.equal(view.href, "/integrations/email-inbound");
    assert.equal(view.isMail, true);
  }
});

test("a FiBuKI-issued invoice is invoicing, whichever field says so", () => {
  assert.equal(fileSourceKind({ sourceType: "fibuki_invoice" }), "invoicing");
  assert.equal(fileSourceKind({ invoiceId: "inv1" }), "invoicing");
  assert.equal(fileSourceKind({ isFibukiGenerated: true }), "invoicing");
});

test("a browser pull is a Browser source named by its domain, not an Upload (#bug)", () => {
  const view = fileSourceView({ sourceType: "browser", sourceDomain: "amazon.de" });
  assert.equal(view.kind, "browser");
  assert.equal(view.icon, "globe");
  assert.equal(view.text, "amazon.de");
  assert.equal(view.isMail, false);
  assert.equal(fileSourceView({ sourceType: "browser" }).text, null);
});

test("Dropbox and Drive files are cloud sources linked to their integration", () => {
  for (const sourceType of ["dropbox", "gdrive"]) {
    const view = fileSourceView({ sourceType, sourceIntegrationId: "c1" });
    assert.equal(view.kind, sourceType);
    assert.equal(view.icon, "cloud");
    assert.equal(view.href, "/integrations/c1");
    assert.equal(view.isMail, false);
  }
  assert.equal(fileSourceView({ sourceType: "dropbox" }).href, null);
});
