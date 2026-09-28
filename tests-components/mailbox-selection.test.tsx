/**
 * #245: the connect overlay's mail tabs read every mailbox, not only Gmail.
 */

import { describe, expect, it } from "vitest";
import {
  attachableMailboxes,
  filterByMailbox,
  mailboxLabel,
  mailProviderLabel,
  mailTabState,
  showMailboxFilter,
} from "@/lib/mail/mailbox-selection";

const GMAIL = { id: "g1", provider: "gmail", email: "me@gmail.com" };
const IMAP = { id: "i1", provider: "imap", email: "office@example.at" };
const OUTLOOK = { id: "o1", provider: "outlook", email: "me@outlook.com" };

describe("attachableMailboxes", () => {
  it("keeps an IMAP-only setup usable", () => {
    expect(attachableMailboxes([IMAP]).map((m) => m.id)).toEqual(["i1"]);
    expect(mailTabState(attachableMailboxes([IMAP]))).toBe("ready");
  });

  it("keeps Gmail and IMAP together, and leaves out providers the attach path cannot read", () => {
    expect(attachableMailboxes([GMAIL, IMAP, OUTLOOK]).map((m) => m.id)).toEqual(["g1", "i1"]);
  });
});

describe("mailTabState", () => {
  it("tells 'nothing connected' apart from 'needs re-authentication'", () => {
    expect(mailTabState([])).toBe("none");
    expect(mailTabState([{ ...IMAP, needsReauth: true }])).toBe("reauth");
    expect(mailTabState([{ ...IMAP, needsReauth: true }, GMAIL])).toBe("ready");
  });
});

describe("mailbox filter", () => {
  it("appears only with more than one mailbox", () => {
    expect(showMailboxFilter([IMAP])).toBe(false);
    expect(showMailboxFilter([GMAIL, IMAP])).toBe(true);
  });

  it("narrows results to one mailbox, or keeps all", () => {
    const rows = [
      { key: "a", integrationId: "g1" },
      { key: "b", integrationId: "i1" },
    ];
    expect(filterByMailbox(rows, "i1").map((r) => r.key)).toEqual(["b"]);
    expect(filterByMailbox(rows, "all").map((r) => r.key)).toEqual(["a", "b"]);
    expect(filterByMailbox(rows, null).map((r) => r.key)).toEqual(["a", "b"]);
  });
});

describe("labels", () => {
  it("names a row's mailbox, never Gmail by default", () => {
    expect(mailboxLabel(IMAP)).toBe("office@example.at");
    expect(mailboxLabel({ ...IMAP, displayName: "Büro" })).toBe("Büro");
    expect(mailboxLabel(undefined)).toBe("Mailbox");
  });

  it("says Gmail only for a Gmail integration", () => {
    expect(mailProviderLabel("gmail")).toBe("Gmail");
    expect(mailProviderLabel("imap")).toBe("IMAP");
    expect(mailProviderLabel(undefined)).toBe("Mail");
  });
});
