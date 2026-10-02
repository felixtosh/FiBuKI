/**
 * The three widgets the plugin shows inside ChatGPT / Claude (MCP Apps): onboarding checklist,
 * progress board, match review. Each is one self-contained HTML document served as a `ui://`
 * resource and attached to the tool whose result it renders.
 *
 * They show what the tools return and call the existing tools (connect, dismiss, auto-connect,
 * upload_file); there is no matching, scoring or VAT logic in here. All server data goes into the
 * page with textContent, never as markup.
 *
 * Bridge: MCP Apps is JSON-RPC 2.0 over postMessage to the host (`ui/initialize`,
 * `ui/notifications/tool-result`, `tools/call`, `ui/message`, `ui/open-link`). ChatGPT's
 * `window.openai` is used where it offers more (uploads) or where the host speaks only that.
 */

import { webOrigin } from "../oauth/oauthCore";

export const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export type WidgetName = "onboarding" | "progress" | "review";

export const WIDGET_URIS: Record<WidgetName, string> = {
  onboarding: "ui://fibuki/onboarding.html",
  progress: "ui://fibuki/progress.html",
  review: "ui://fibuki/review.html",
};

/** The tool whose result each widget renders. */
export const WIDGET_TOOLS: Record<string, WidgetName> = {
  get_onboarding_status: "onboarding",
  get_period_status: "progress",
  list_pending_matches: "review",
};

/** Extra tool metadata: the widget a tool renders, and which arguments are chat attachments. */
export function toolMeta(toolName: string): Record<string, unknown> | undefined {
  const widget = WIDGET_TOOLS[toolName];
  const meta: Record<string, unknown> = {};
  if (widget) {
    meta.ui = { resourceUri: WIDGET_URIS[widget] };
    // ChatGPT's earlier spelling of the same thing.
    meta["openai/outputTemplate"] = WIDGET_URIS[widget];
  }
  if (toolName === "upload_file") meta["openai/fileParams"] = ["file"];
  return Object.keys(meta).length ? meta : undefined;
}

const STYLE = [
  ":root{color-scheme:light dark;--fg:#1a1a1a;--muted:#6b6b6b;--bg:#fff;--card:#f6f6f4;--line:#e2e2de;--accent:#1f6f54;--warn:#b4531a}",
  "@media (prefers-color-scheme:dark){:root{--fg:#ececec;--muted:#9a9a9a;--bg:#1b1b1b;--card:#262626;--line:#3a3a3a;--accent:#5fc19a;--warn:#e69a62}}",
  "*{box-sizing:border-box}",
  "body{margin:0;padding:12px;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:var(--bg)}",
  "h1{font-size:15px;margin:0 0 10px}",
  ".row{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);margin-bottom:6px}",
  ".grow{flex:1;min-width:0}.title{font-weight:600}.sub{color:var(--muted);font-size:12px}",
  ".trunc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  "button{font:inherit;padding:5px 10px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}",
  "button.primary{background:var(--accent);border-color:var(--accent);color:#fff}",
  "button:disabled{opacity:.5;cursor:default}",
  ".dot{width:18px;height:18px;border-radius:50%;border:2px solid var(--line);flex:none;text-align:center;font-size:11px;line-height:14px}",
  ".dot.done{background:var(--accent);border-color:var(--accent);color:#fff}.dot.skipped{color:var(--muted)}",
  ".bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent)}",
  ".warn{color:var(--warn)}.right{text-align:right;white-space:nowrap}",
  ".drop{border:2px dashed var(--line);border-radius:8px;padding:12px;text-align:center;color:var(--muted);margin-top:10px}",
  ".empty{color:var(--muted);padding:14px 4px}.toolbar{display:flex;gap:8px;margin:10px 0}",
].join("");

/** Shared bridge, DOM helpers and strings. Plain ES5 so any host webview runs it. */
const BRIDGE = `
var FB = (function () {
  var pending = {}, nextId = 1, onData = null, last = null;
  var lang = (navigator.language || "en").slice(0, 2) === "de" ? "de" : "en";
  var meta = document.querySelector('meta[name="fibuki-origin"]');
  var origin = meta ? meta.getAttribute("content") : "";

  function post(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params }); }

  function extract(result) {
    if (!result) return null;
    if (result.structuredContent) return result.structuredContent;
    var text = result.content && result.content[0] && result.content[0].text;
    if (text) { try { return JSON.parse(text); } catch (e) { return null; } }
    return null;
  }
  function deliver(data) { if (data) { last = data; if (onData) onData(data); } }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "request failed")); else p.resolve(m.result);
    } else if (m.method === "ui/notifications/tool-result") {
      deliver(extract(m.params));
    }
  });
  window.addEventListener("openai:set_globals", function () {
    if (window.openai && window.openai.toolOutput) deliver(window.openai.toolOutput);
  });

  function callTool(name, args) {
    if (window.openai && window.openai.callTool) {
      return window.openai.callTool(name, args).then(function (r) { return extract(r) || r; });
    }
    return request("tools/call", { name: name, arguments: args }).then(function (r) {
      if (r && r.isError) throw new Error((r.content && r.content[0] && r.content[0].text) || "tool failed");
      return extract(r);
    });
  }
  function say(text) {
    if (window.openai && window.openai.sendFollowUpMessage) return window.openai.sendFollowUpMessage({ prompt: text });
    return request("ui/message", { role: "user", content: [{ type: "text", text: text }] });
  }
  function open(path) {
    var href = /^https:/.test(path) ? path : origin + path;
    if (window.openai && window.openai.openExternal) return window.openai.openExternal({ href: href });
    return request("ui/open-link", { url: href });
  }
  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === "class") node.className = attrs[k];
      else if (k === "onclick") node.addEventListener("click", attrs[k]);
      else if (k === "disabled") node.disabled = !!attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return node;
  }
  function money(cents, currency) {
    try {
      return new Intl.NumberFormat(lang === "de" ? "de-AT" : "en-GB", { style: "currency", currency: currency || "EUR" }).format((cents || 0) / 100);
    } catch (e) { return String((cents || 0) / 100); }
  }
  function mount(render) {
    var root = document.getElementById("root");
    onData = function (data) { while (root.firstChild) root.removeChild(root.firstChild); root.appendChild(render(data)); };
    if (window.openai && window.openai.toolOutput) deliver(window.openai.toolOutput);
    request("ui/initialize", { protocolVersion: "2025-11-21", appInfo: { name: "fibuki-widget", version: "1" }, appCapabilities: {} })
      .then(function () { notify("ui/notifications/initialized", {}); }, function () {});
    return function rerender() { if (last) onData(last); };
  }
  return { lang: lang, t: function (table) { return table[lang] || table.en; }, callTool: callTool, say: say, open: open, h: h, money: money, mount: mount, deliver: deliver, extract: extract };
})();
`;

const ONBOARDING = `
var S = FB.t({
  en: { title: "Set up FiBuKI", done: "done", skipped: "skipped", doIt: "Open in FiBuKI", all: "Everything is set up.", steps: { set_identity: "Who you are", connect_email: "Mail", add_bank_account: "Bank account", import_transactions: "Transactions", assign_partner: "First partner", attach_file: "First receipt" }, hint: { set_identity: "Name, company, VAT ID, your IBANs. Keeps your own invoices from counting as expenses.", connect_email: "FiBuKI can fetch invoices from your mailbox in the background, or your assistant can search its own.", add_bank_account: "Add the account your business uses.", import_transactions: "Drop a bank export into the chat and the assistant imports it.", assign_partner: "Name who a payment went to.", attach_file: "Attach a receipt to a payment." } },
  de: { title: "FiBuKI einrichten", done: "erledigt", skipped: "übersprungen", doIt: "In FiBuKI öffnen", all: "Alles eingerichtet.", steps: { set_identity: "Wer du bist", connect_email: "E-Mail", add_bank_account: "Bankkonto", import_transactions: "Umsätze", assign_partner: "Erster Partner", attach_file: "Erster Beleg" }, hint: { set_identity: "Name, Firma, UID, deine IBANs. Damit eigene Rechnungen nicht als Ausgaben zählen.", connect_email: "FiBuKI kann Rechnungen im Hintergrund aus deinem Postfach holen, oder dein Assistent sucht in seinem eigenen.", add_bank_account: "Das Konto, das dein Unternehmen nutzt.", import_transactions: "Zieh einen Bankexport in den Chat, der Assistent importiert ihn.", assign_partner: "Sag, an wen eine Zahlung ging.", attach_file: "Hänge einen Beleg an eine Zahlung." } }
});
FB.mount(function (status) {
  var box = FB.h("div", {}, [FB.h("h1", {}, [S.title + " (" + status.progress.done + "/" + status.progress.total + ")"])]);
  if (status.complete) box.appendChild(FB.h("div", { class: "empty" }, [S.all]));
  status.steps.forEach(function (step) {
    var mark = step.state === "done" ? "✓" : step.state === "skipped" ? "–" : "";
    var action = step.state === "open"
      ? FB.h("button", { class: step.id === status.currentStep ? "primary" : "", onclick: function () { FB.open(step.route); } }, [S.doIt])
      : FB.h("span", { class: "sub" }, [step.state === "done" ? S.done : S.skipped]);
    box.appendChild(FB.h("div", { class: "row" }, [
      FB.h("span", { class: "dot " + step.state }, [mark]),
      FB.h("div", { class: "grow" }, [
        FB.h("div", { class: "title" }, [S.steps[step.id] || step.title]),
        step.state === "open" ? FB.h("div", { class: "sub" }, [S.hint[step.id] || ""]) : null
      ]),
      action
    ]));
  });
  return box;
});
`;

const PROGRESS = `
var S = FB.t({
  en: { title: "Receipts", of: "covered", missing: "Missing a receipt", more: "more not shown", none: "No missing receipts in this period.", waiting: "matches waiting for your yes", review: "Review matches", add: "Add files", drop: "Attach receipts to the chat, or add them here.", adding: "Uploading", added: "added", failed: "failed", noTx: "No transactions in this period yet.", parked: "on hold (plan limit)", open: "Open in FiBuKI", partial: "Only the newest transactions were counted." },
  de: { title: "Belege", of: "abgedeckt", missing: "Beleg fehlt", more: "weitere nicht angezeigt", none: "Keine fehlenden Belege in diesem Zeitraum.", waiting: "Zuordnungen warten auf dein Ja", review: "Zuordnungen prüfen", add: "Dateien hinzufügen", drop: "Hänge Belege an den Chat an oder füge sie hier hinzu.", adding: "Lade hoch", added: "hinzugefügt", failed: "fehlgeschlagen", noTx: "Noch keine Umsätze in diesem Zeitraum.", parked: "pausiert (Planlimit)", open: "In FiBuKI öffnen", partial: "Nur die neuesten Umsätze wurden gezählt." }
});
var rerender;
function monthLabel(m) {
  var d = new Date(m + "-01T00:00:00Z");
  return d.toLocaleDateString(FB.lang === "de" ? "de-AT" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
function pick() {
  var o = window.openai;
  if (!o || !o.selectFiles || !o.uploadFile || !o.getFileDownloadUrl) return Promise.resolve(null);
  return o.selectFiles().then(function (files) { return { files: files || [], o: o }; });
}
function addFiles(status) {
  pick().then(function (picked) {
    if (!picked || !picked.files.length) return;
    var ok = 0, bad = 0;
    var chain = Promise.resolve();
    picked.files.forEach(function (f) {
      chain = chain.then(function () {
        return picked.o.getFileDownloadUrl({ fileId: f.fileId }).then(function (r) {
          return FB.callTool("upload_file", { file: { download_url: r.downloadUrl, file_id: f.fileId }, fileName: f.name, mimeType: f.mimeType });
        }).then(function () { ok++; }, function () { bad++; });
      });
    });
    chain.then(function () {
      FB.say(S.adding + ": " + ok + " " + S.added + (bad ? ", " + bad + " " + S.failed : "") + ".");
      return FB.callTool("get_period_status", { dateFrom: status.period.dateFrom, dateTo: status.period.dateTo });
    }).then(function (fresh) { FB.deliver(fresh); }, function () {});
  });
}
rerender = FB.mount(function (status) {
  var box = FB.h("div", {}, [FB.h("h1", {}, [S.title + " " + status.totals.coveragePercent + "% " + S.of])]);
  if (!status.months.length) box.appendChild(FB.h("div", { class: "empty" }, [S.noTx]));
  status.months.forEach(function (m) {
    box.appendChild(FB.h("div", { class: "row" }, [
      FB.h("div", { class: "grow" }, [
        FB.h("div", { class: "title" }, [monthLabel(m.month)]),
        FB.h("div", { class: "bar" }, [FB.h("i", { style: "width:" + m.coveragePercent + "%" }, [])]),
        FB.h("div", { class: "sub" }, [m.covered + "/" + m.total + " " + S.of + (m.parked ? " · " + m.parked + " " + S.parked : "")])
      ]),
      FB.h("div", { class: "right " + (m.missing ? "warn" : "") }, [m.missing ? String(m.missing) : "✓"])
    ]));
  });
  if (status.truncated) box.appendChild(FB.h("div", { class: "sub" }, [S.partial]));
  if (status.waitingSuggestions.count) {
    box.appendChild(FB.h("div", { class: "toolbar" }, [
      FB.h("span", {}, [status.waitingSuggestions.count + " " + S.waiting]),
      FB.h("button", { class: "primary", onclick: function () { FB.say(S.review); } }, [S.review])
    ]));
  }
  box.appendChild(FB.h("h1", {}, [S.missing]));
  if (!status.missing.length) box.appendChild(FB.h("div", { class: "empty" }, [S.none]));
  status.missing.forEach(function (t) {
    box.appendChild(FB.h("div", { class: "row" }, [
      FB.h("div", { class: "grow" }, [
        FB.h("div", { class: "title trunc" }, [t.partner || t.name || "–"]),
        FB.h("div", { class: "sub" }, [t.date])
      ]),
      FB.h("div", { class: "right" }, [FB.money(t.amount, t.currency)])
    ]));
  });
  if (status.missingTruncated) box.appendChild(FB.h("div", { class: "sub" }, ["… " + S.more]));
  if (window.openai && window.openai.selectFiles) {
    box.appendChild(FB.h("div", { class: "drop" }, [
      FB.h("div", {}, [S.drop]),
      FB.h("button", { onclick: function () { addFiles(status); } }, [S.add])
    ]));
  }
  return box;
});
`;

const REVIEW = `
var S = FB.t({
  en: { title: "Matches to confirm", accept: "Accept", reject: "Reject", all: "Accept all at", none: "Nothing waiting for review.", sure: "sure", done: "Connected", gone: "Rejected", failed: "Did not work", more: "more waiting", receipt: "Receipt", payment: "Payment" },
  de: { title: "Zuordnungen bestätigen", accept: "Übernehmen", reject: "Ablehnen", all: "Alle übernehmen ab", none: "Nichts zu prüfen.", sure: "sicher", done: "Verbunden", gone: "Abgelehnt", failed: "Hat nicht geklappt", more: "weitere warten", receipt: "Beleg", payment: "Zahlung" }
});
var rerender;
rerender = FB.mount(function (data) {
  var box = FB.h("div", {}, [FB.h("h1", {}, [S.title])]);
  var rows = data.matches;
  if (!rows.length) { box.appendChild(FB.h("div", { class: "empty" }, [S.none])); return box; }
  var bar = data.minConfidence;
  box.appendChild(FB.h("div", { class: "toolbar" }, [
    FB.h("button", { class: "primary", onclick: function (e) {
      e.target.disabled = true;
      FB.callTool("auto_connect_file_suggestions", { minConfidence: bar }).then(function () {
        return FB.callTool("list_pending_matches", { minConfidence: bar });
      }).then(function (fresh) { FB.deliver(fresh); }, function () { e.target.disabled = false; });
    } }, [S.all + " " + bar + "%"])
  ]));
  rows.forEach(function (m) {
    var status = FB.h("span", { class: "sub" }, []);
    var accept = FB.h("button", { class: "primary" }, [S.accept]);
    var reject = FB.h("button", {}, [S.reject]);
    function act(tool, label, args) {
      accept.disabled = true; reject.disabled = true;
      FB.callTool(tool, args).then(function () {
        status.textContent = label;
        accept.style.display = "none"; reject.style.display = "none";
      }, function () {
        status.textContent = S.failed;
        accept.disabled = false; reject.disabled = false;
      });
    }
    accept.addEventListener("click", function () { act("connect_file_to_transaction", S.done, { fileId: m.fileId, transactionId: m.transactionId }); });
    reject.addEventListener("click", function () { act("dismiss_transaction_suggestion", S.gone, { fileId: m.fileId, transactionId: m.transactionId }); });
    box.appendChild(FB.h("div", { class: "row" }, [
      FB.h("div", { class: "grow" }, [
        FB.h("div", { class: "title trunc" }, [S.receipt + ": " + (m.fileName || m.filePartner || "–")]),
        FB.h("div", { class: "sub trunc" }, [S.payment + ": " + (m.transactionPartner || m.transactionName || "–") + " · " + (m.transactionDate || "") + " · " + FB.money(m.transactionAmount, m.transactionCurrency)]),
        FB.h("div", { class: "sub" }, [m.confidence + "% " + S.sure])
      ]),
      status, accept, reject
    ]));
  });
  if (data.total > rows.length) box.appendChild(FB.h("div", { class: "sub" }, ["+" + (data.total - rows.length) + " " + S.more]));
  return box;
});
`;

const BODIES: Record<WidgetName, { title: string; script: string }> = {
  onboarding: { title: "FiBuKI setup", script: ONBOARDING },
  progress: { title: "FiBuKI receipts", script: PROGRESS },
  review: { title: "FiBuKI matches", script: REVIEW },
};

/** The full document for one widget. `origin` is where "open in FiBuKI" links point. */
export function renderWidget(name: WidgetName, origin: string = webOrigin()): string {
  const { title, script } = BODIES[name];
  const safeOrigin = origin.replace(/[^A-Za-z0-9:/._-]/g, "");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="fibuki-origin" content="${safeOrigin}">` +
    `<title>${title}</title><style>${STYLE}</style></head>` +
    `<body><div id="root"></div><script>${BRIDGE}${script}</script></body></html>`
  );
}

export interface WidgetResource {
  uri: string;
  name: string;
  title: string;
  mimeType: string;
  description: string;
}

export function listWidgetResources(): WidgetResource[] {
  return (Object.keys(WIDGET_URIS) as WidgetName[]).map((name) => ({
    uri: WIDGET_URIS[name],
    name: `fibuki-${name}`,
    title: BODIES[name].title,
    mimeType: WIDGET_MIME_TYPE,
    description: `FiBuKI ${name} widget`,
  }));
}

export function widgetNameForUri(uri: string): WidgetName | null {
  return (Object.keys(WIDGET_URIS) as WidgetName[]).find((n) => WIDGET_URIS[n] === uri) ?? null;
}
