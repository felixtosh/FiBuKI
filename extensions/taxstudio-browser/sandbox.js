// Sandbox script - runs in isolated context where eval is allowed
// Receives scripts via postMessage, executes them, returns commands

window.addEventListener("message", function (event) {
  // Only the embedding frame (the content script's window) may submit scripts.
  if (event.source !== window.parent) return;
  if (!event.data || event.data.type !== "TS_SANDBOX_EXEC") return;

  var script = event.data.script || "";
  var pageData = event.data.pageData || {};
  var requestId = event.data.requestId;

  // Commands to return to content script
  var commands = [];
  var logs = [];

  // Create a mock ctx that builds up commands instead of executing directly
  var ctx = {
    url: pageData.url || "",
    runId: pageData.runId || "",
    reason: pageData.reason || "auto",
    pageSnapshot: pageData.snapshot || null,

    // Logging - collect logs to send back
    log: function () {
      var msg = Array.prototype.slice.call(arguments).join(" ");
      logs.push({ level: "log", message: msg });
    },
    warn: function () {
      var msg = Array.prototype.slice.call(arguments).join(" ");
      logs.push({ level: "warn", message: msg });
    },
    error: function () {
      var msg = Array.prototype.slice.call(arguments).join(" ");
      logs.push({ level: "error", message: msg });
    },

    // Query functions - return from pre-collected data
    query: function (selector) {
      var elements = pageData.elements || {};
      return elements[selector] ? elements[selector][0] : null;
    },
    queryAll: function (selector) {
      var elements = pageData.elements || {};
      return elements[selector] || [];
    },

    // Actions - queue commands to be executed by content script
    click: function (selectorOrIndex) {
      commands.push({ action: "click", target: selectorOrIndex });
    },
    clickAll: function (selector, limit) {
      commands.push({ action: "clickAll", selector: selector, limit: limit || 3 });
    },
    clickSelector: function (selector) {
      commands.push({ action: "clickSelector", selector: selector });
    },

    // Sleep - will be handled by content script
    sleep: function (ms) {
      commands.push({ action: "sleep", ms: ms });
      return Promise.resolve(); // Fake promise, actual sleep done by content script
    },

    // Data attribute downloads from pre-collected data
    findDataAttributeDownloads: function () {
      return pageData.dataAttributeUrls || [];
    },

    // Emit candidates
    emitCandidates: function (urls, origin) {
      commands.push({ action: "emitCandidates", urls: urls, origin: origin });
    },

    // Send debug log
    sendDebugLog: function (data) {
      commands.push({ action: "sendDebugLog", data: data });
    },

    // Get page snapshot (already provided)
    getPageSnapshot: function () {
      return pageData.snapshot || {};
    },

    // Click invoice link by index
    clickInvoiceLink: function (index) {
      commands.push({ action: "clickInvoiceLink", index: index || 0 });
    },

    // Click menu item by text pattern (default: "download")
    clickMenuItem: function (pattern) {
      commands.push({ action: "clickMenuItem", pattern: pattern || "download" });
    },

    // Click expandable section by text pattern (default: "document|pdf")
    clickExpandable: function (pattern) {
      commands.push({ action: "clickExpandable", pattern: pattern || "document|pdf" });
    },

    // Re-collect page data after DOM changes
    refreshSnapshot: function () {
      commands.push({ action: "refreshSnapshot" });
    },
  };

  try {
    // Execute the script
    var runner = new Function("ctx", "commands", "return (async function(){ " + script + "\n})();");

    // Run and wait for completion
    Promise.resolve(runner(ctx, commands))
      .then(function () {
        event.source.postMessage({
          type: "TS_SANDBOX_RESULT",
          requestId: requestId,
          success: true,
          commands: commands,
          logs: logs,
        }, event.origin);
      })
      .catch(function (err) {
        event.source.postMessage({
          type: "TS_SANDBOX_RESULT",
          requestId: requestId,
          success: false,
          error: err.message || String(err),
          commands: commands,
          logs: logs,
        }, event.origin);
      });
  } catch (err) {
    event.source.postMessage({
      type: "TS_SANDBOX_RESULT",
      requestId: requestId,
      success: false,
      error: err.message || String(err),
      commands: commands,
      logs: logs,
    }, event.origin);
  }
});

// Signal ready
window.parent.postMessage({ type: "TS_SANDBOX_READY" }, "*");
