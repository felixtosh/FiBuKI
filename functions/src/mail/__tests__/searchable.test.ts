import { describe, it, expect } from "vitest";
import {
  isSearchableMailIntegration,
  searchedMailIntegrations,
  MAX_SEARCHED_MAIL_INTEGRATIONS,
} from "../searchable";

const at = (iso: string) => new Date(iso);

describe("isSearchableMailIntegration (#746)", () => {
  it("reads an active IMAP Mail Integration like a Gmail one", () => {
    expect(isSearchableMailIntegration({ provider: "imap", isActive: true, needsReauth: false })).toBe(true);
    expect(isSearchableMailIntegration({ provider: "gmail", isActive: true, needsReauth: false })).toBe(true);
  });

  it("treats a record with no provider as Gmail, as before IMAP existed", () => {
    expect(isSearchableMailIntegration({ isActive: true, needsReauth: false })).toBe(true);
  });

  it("passes over an inactive one, one waiting for credentials, and an unknown provider", () => {
    expect(isSearchableMailIntegration({ provider: "imap", isActive: false, needsReauth: false })).toBe(false);
    expect(isSearchableMailIntegration({ provider: "imap", isActive: true, needsReauth: true })).toBe(false);
    expect(isSearchableMailIntegration({ provider: "outlook", isActive: true, needsReauth: false })).toBe(false);
  });

  it("reads a record whose needsReauth was never written", () => {
    expect(isSearchableMailIntegration({ provider: "imap", isActive: true })).toBe(true);
  });
});

describe("searchedMailIntegrations (#746)", () => {
  const mailbox = (id: string, provider: string, created: string, extra: Record<string, unknown> = {}) => ({
    id,
    provider,
    isActive: true,
    needsReauth: false,
    createdAt: at(created),
    ...extra,
  });

  it("caps the mailboxes per search across Gmail and IMAP together, oldest first", () => {
    const records = [
      mailbox("imap-new", "imap", "2026-06-01"),
      mailbox("gmail-1", "gmail", "2026-01-01"),
      mailbox("imap-1", "imap", "2026-02-01"),
      mailbox("gmail-2", "gmail", "2026-03-01"),
      mailbox("imap-2", "imap", "2026-04-01"),
      mailbox("imap-3", "imap", "2026-05-01"),
    ];
    expect(searchedMailIntegrations(records).map((r) => r.id)).toEqual([
      "gmail-1",
      "imap-1",
      "gmail-2",
      "imap-2",
      "imap-3",
    ]);
    expect(MAX_SEARCHED_MAIL_INTEGRATIONS).toBe(5);
  });

  it("does not let a mailbox it passes over take a place under the cap", () => {
    const records = [
      mailbox("broken", "imap", "2026-01-01", { needsReauth: true }),
      mailbox("paused", "gmail", "2026-01-02", { isActive: false }),
      mailbox("ok", "imap", "2026-01-03"),
    ];
    expect(searchedMailIntegrations(records).map((r) => r.id)).toEqual(["ok"]);
  });
});
