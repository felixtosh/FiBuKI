/**
 * The three plugin widgets (functions/src/mcp-api/widgets.ts), run as real pages in jsdom with a fake
 * host on the other side of postMessage. Covers the MCP Apps handshake, rendering from a tool
 * result, the calls the buttons make, and that server text never becomes markup.
 */

import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { renderWidget, type WidgetName } from "../functions/src/mcp-api/widgets";

interface Host {
  dom: JSDOM;
  sent: Array<Record<string, any>>;
  doc: Document;
  /** Deliver a tool result to the widget, as the host does. */
  result(structuredContent: unknown): void;
  /** Answer the widget's pending request with this id. */
  reply(id: number, result: unknown): void;
  text(): string;
}

function open(name: WidgetName, openai?: Record<string, unknown>): Host {
  const sent: Array<Record<string, any>> = [];
  const dom = new JSDOM(renderWidget(name, "https://fibuki.test"), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as any).postMessage = (message: Record<string, any>) => sent.push(message);
      if (openai) (window as any).openai = openai;
    },
  });
  const deliver = (data: unknown) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: dom.window as any }));
  return {
    dom,
    sent,
    doc: dom.window.document,
    result: (structuredContent) =>
      deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } }),
    reply: (id, result) => deliver({ jsonrpc: "2.0", id, result }),
    text: () => dom.window.document.getElementById("root")!.textContent ?? "",
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const buttons = (h: Host) => [...h.doc.querySelectorAll("button")];
const button = (h: Host, label: RegExp) => buttons(h).find((b) => label.test(b.textContent ?? ""))!;

describe("bridge", () => {
  it("opens with ui/initialize, then tells the host it is ready", async () => {
    const host = open("review");
    const init = host.sent.find((m) => m.method === "ui/initialize")!;
    expect(init.params.protocolVersion).toBeTruthy();
    host.reply(init.id, { protocolVersion: init.params.protocolVersion });
    await flush();
    expect(host.sent.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
  });

  it("ignores messages that do not come from the host window", () => {
    const host = open("review");
    host.dom.window.dispatchEvent(
      new host.dom.window.MessageEvent("message", {
        data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { matches: [], total: 0, minConfidence: 85 } } },
        source: null,
      })
    );
    expect(host.doc.getElementById("root")!.children.length).toBe(0);
  });
});

describe("onboarding card", () => {
  const status = {
    complete: false,
    origin: "chatgpt",
    currentStep: "connect_email",
    progress: { done: 1, total: 6 },
    steps: [
      { id: "set_identity", title: "Identity", state: "done", route: "/settings/identity" },
      { id: "connect_email", title: "Mail", state: "open", route: "/integrations/gmail" },
      { id: "add_bank_account", title: "Bank", state: "skipped", route: "/sources" },
    ],
  };

  it("shows progress, marks done and skipped, and opens the page for an open step", async () => {
    const host = open("onboarding");
    host.result(status);
    expect(host.text()).toContain("(1/6)");
    expect(host.doc.querySelectorAll(".dot.done")).toHaveLength(1);
    expect(host.doc.querySelectorAll(".dot.skipped")).toHaveLength(1);

    button(host, /Open in FiBuKI/).click();
    const link = host.sent.find((m) => m.method === "ui/open-link")!;
    expect(link.params.url).toBe("https://fibuki.test/integrations/gmail");
  });

  it("speaks German when the browser does", () => {
    const sent: unknown[] = [];
    const dom = new JSDOM(renderWidget("onboarding", "https://fibuki.test"), {
      runScripts: "dangerously",
      beforeParse(window) {
        (window as any).postMessage = (m: unknown) => sent.push(m);
        Object.defineProperty(window.navigator, "language", { value: "de-AT" });
      },
    });
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: status } },
        source: dom.window as any,
      })
    );
    expect(dom.window.document.getElementById("root")!.textContent).toContain("FiBuKI einrichten");
  });
});

describe("progress board", () => {
  const status = {
    period: { dateFrom: "2026-08-01", dateTo: "2026-09-30" },
    months: [
      { month: "2026-09", total: 4, covered: 2, missing: 1, parked: 1, coveragePercent: 50 },
      { month: "2026-08", total: 2, covered: 2, missing: 0, parked: 0, coveragePercent: 100 },
    ],
    totals: { total: 6, covered: 4, missing: 1, parked: 1, coveragePercent: 67 },
    missing: [{ id: "t1", date: "2026-09-05", amount: -2390, currency: "EUR", name: "REWE", partner: "REWE" }],
    missingTruncated: false,
    truncated: false,
    waitingSuggestions: { count: 3, minConfidence: 85 },
  };

  it("renders coverage per month and the missing lines", () => {
    const host = open("progress");
    host.result(status);
    expect(host.text()).toContain("67%");
    expect(host.text()).toContain("2/4");
    expect(host.text()).toContain("REWE");
    expect(host.text()).toMatch(/23[.,]90/);
  });

  it("offers the review when matches are waiting, by asking the assistant", () => {
    const host = open("progress");
    host.result(status);
    expect(host.text()).toContain("3 matches waiting");
    button(host, /Review matches/).click();
    const message = host.sent.find((m) => m.method === "ui/message")!;
    expect(message.params.content[0].text).toBe("Review matches");
  });

  it("shows no drop zone where the host cannot upload", () => {
    const host = open("progress");
    host.result(status);
    expect(host.doc.querySelector(".drop")).toBeNull();
  });

  it("uploads files picked through the host, then refreshes the board", async () => {
    const calls: Array<[string, any]> = [];
    const host = open("progress", {
      selectFiles: async () => [{ fileId: "file_1", name: "rewe.pdf", mimeType: "application/pdf" }],
      uploadFile: async () => ({ fileId: "file_1" }),
      getFileDownloadUrl: async () => ({ downloadUrl: "https://files.example/rewe" }),
      callTool: async (name: string, args: unknown) => {
        calls.push([name, args]);
        return { structuredContent: name === "get_period_status" ? { ...status, waitingSuggestions: { count: 0, minConfidence: 85 } } : { success: true } };
      },
      sendFollowUpMessage: async () => undefined,
    });
    host.result(status);
    button(host, /Add files/).click();
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await flush();

    expect(calls[0]).toEqual([
      "upload_file",
      { file: { download_url: "https://files.example/rewe", file_id: "file_1" }, fileName: "rewe.pdf", mimeType: "application/pdf" },
    ]);
    expect(calls[1][0]).toBe("get_period_status");
    expect(host.text()).not.toContain("matches waiting"); // re-rendered from the fresh status
  });
});

describe("match review", () => {
  const data = {
    minConfidence: 85,
    count: 2,
    total: 3,
    matches: [
      { fileId: "f1", fileName: "rewe.pdf", filePartner: "REWE", transactionId: "t1", transactionName: "REWE 1234", transactionPartner: "REWE", transactionAmount: -2390, transactionCurrency: "EUR", transactionDate: "2026-09-10", confidence: 91 },
      { fileId: "f2", fileName: "a.pdf", filePartner: null, transactionId: "t2", transactionName: "ACME", transactionPartner: null, transactionAmount: -500, transactionCurrency: "EUR", transactionDate: "2026-09-11", confidence: 86 },
    ],
  };

  it("lists each pair with FiBuKI's confidence and says how many more wait", () => {
    const host = open("review");
    host.result(data);
    expect(host.text()).toContain("91% sure");
    expect(host.text()).toContain("rewe.pdf");
    expect(host.text()).toContain("+1 more waiting");
  });

  it("accept connects exactly that pair through the existing tool", async () => {
    const host = open("review");
    host.result(data);
    button(host, /^Accept$/).click();
    const call = host.sent.find((m) => m.method === "tools/call")!;
    expect(call.params).toEqual({ name: "connect_file_to_transaction", arguments: { fileId: "f1", transactionId: "t1" } });

    host.reply(call.id, { structuredContent: { success: true } });
    await flush();
    expect(host.text()).toContain("Connected");
    expect(buttons(host).filter((b) => /^Accept$/.test(b.textContent ?? "")).length).toBe(2); // the other row is untouched
  });

  it("reject dismisses the suggestion instead of connecting", () => {
    const host = open("review");
    host.result(data);
    button(host, /^Reject$/).click();
    expect(host.sent.find((m) => m.method === "tools/call")!.params).toEqual({
      name: "dismiss_transaction_suggestion",
      arguments: { fileId: "f1", transactionId: "t1" },
    });
  });

  it("keeps the buttons usable and says so when a call fails", async () => {
    const host = open("review");
    host.result(data);
    button(host, /^Accept$/).click();
    const call = host.sent.find((m) => m.method === "tools/call")!;
    host.dom.window.dispatchEvent(
      new host.dom.window.MessageEvent("message", {
        data: { jsonrpc: "2.0", id: call.id, error: { message: "PAIR_REJECTED" } },
        source: host.dom.window as any,
      })
    );
    await flush();
    expect(host.text()).toContain("Did not work");
    expect((button(host, /^Accept$/) as HTMLButtonElement).disabled).toBe(false);
  });

  it("accept all uses the auto-connect tool at the same bar, then reloads the list", async () => {
    const host = open("review");
    host.result(data);
    button(host, /Accept all at 85%/).click();
    const first = host.sent.find((m) => m.method === "tools/call")!;
    expect(first.params).toEqual({ name: "auto_connect_file_suggestions", arguments: { minConfidence: 85 } });
    host.reply(first.id, { structuredContent: { connected: 2 } });
    await flush();
    const second = host.sent.filter((m) => m.method === "tools/call")[1];
    expect(second.params.name).toBe("list_pending_matches");
    host.reply(second.id, { structuredContent: { matches: [], count: 0, total: 0, minConfidence: 85 } });
    await flush();
    expect(host.text()).toContain("Nothing waiting for review.");
  });

  it("never turns server text into markup", () => {
    const host = open("review");
    host.result({
      ...data,
      matches: [{ ...data.matches[0], fileName: '<img src=x onerror="window.pwned=1">', transactionName: "<b>bold</b>", transactionPartner: null }],
    });
    expect(host.doc.querySelector("img")).toBeNull();
    expect(host.doc.querySelector("b")).toBeNull();
    expect(host.text()).toContain("<b>bold</b>");
    expect((host.dom.window as any).pwned).toBeUndefined();
  });
});
