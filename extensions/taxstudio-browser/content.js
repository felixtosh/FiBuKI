(function () {
  var EXTENSION_PING = "TAXSTUDIO_EXTENSION_PING";
  var EXTENSION_PONG = "TAXSTUDIO_EXTENSION_PONG";
  var EXTENSION_SOURCE = "taxstudio_extension";
  var VERSION = "0.0.1";
  var MARKER_NAME = "taxstudio-extension";
  var OVERLAY_ID = "taxstudio-overlay";
  var LIST_ID = "taxstudio-overlay-list";
  var COUNT_ID = "taxstudio-overlay-count";
  var MORE_ID = "taxstudio-overlay-more";
  var STATUS_ID = "taxstudio-overlay-status";
  var WINDOW_NAME_PREFIX = "ts_pull_";
  var HASH_PREFIX = "ts_run=";
  var LOGIN_PROMPT_ID = "taxstudio-login-prompt";
  var MASCOT_LAUNCHER_ID = "taxstudio-mascot-launcher";
  var MASCOT_LAUNCHER_STYLE_ID = "taxstudio-mascot-launcher-style";
  var MASCOT_CORNER_KEY = "ts_mascot_corner";
  var currentRunId = null;
  var lastMenuAnchor = null;
  var lastMenuOpenedAt = 0;
  var lastMenuContext = "unknown";
  var menuObserver = null;
  var lastMenuButton = null;
  var pausedForLogin = false;
  var originalPullUrl = null;
  var loginCheckInterval = null;
  var devExtractorCalls = [];
  var appBaseUrl = "https://fibuki.com";
  var DEV_EXTRACTOR_FALLBACK_URL = appBaseUrl + "/api/browser/extractor";
  var DEV_EXTRACTOR_MAX_CALLS = 6;
  var DEV_EXTRACTOR_WINDOW_MS = 60 * 1000;
  var clickGooglePaymentsRetryCount = 0;

  // Learn mode state
  var LEARN_OVERLAY_ID = "taxstudio-learn-overlay";
  var learnMode = false;
  var learnRunId = null;
  var learnSessionStart = 0;
  var learnPartnerName = "";
  var learnTransactionId = null;
  var learnActions = [];
  var learnPdfCount = 0;
  var learnLastUrl = "";
  var learnInvoiceListUrl = null;
  var learnExpectingInvoiceSelect = false;

  var overlayState = {
    items: [],
    limit: 4,
  };
  var manualCaptureMode = false;
  var lastManualInvoiceClickAt = 0;
  var seenNetworkUrls = {};
  var lastDataAttrCount = 0;
  var isTopFrame = window.top === window;
  var mascotLauncherInterval = null;
  var mascotCorner = "bottom_right";
  var suppressLauncherClick = false;

  try {
    var existing = document.querySelector('meta[name="' + MARKER_NAME + '"]');
    if (!existing) {
      var marker = document.createElement("meta");
      marker.setAttribute("name", MARKER_NAME);
      marker.setAttribute("content", VERSION);
      document.head.appendChild(marker);
    }
  } catch (err) {
    // Ignore DOM errors
  }

  // Load persisted app base URL from storage
  try {
    chrome.storage.local.get(["ts_app_base_url"], function (result) {
      if (result && result.ts_app_base_url) {
        appBaseUrl = result.ts_app_base_url;
        DEV_EXTRACTOR_FALLBACK_URL = appBaseUrl + "/api/browser/extractor";
      }
    });
  } catch (err) {}

  if (isTopFrame) {
    console.log("[FiBuKI] Content script ready (TOP)", window.location.href, "name:", window.name);
  } else {
    console.log("[FiBuKI] Content script ready (IFRAME)", window.location.href, "name:", window.name);
  }
  chrome.runtime.sendMessage({ type: "TS_INJECT_HOOK" });
  document.addEventListener("click", handleManualInvoiceClick, true);
  if (isTopFrame) {
    setTimeout(refreshMascotLauncher, 800);
    setTimeout(refreshMascotLauncher, 2500);
    if (mascotLauncherInterval) clearInterval(mascotLauncherInterval);
    mascotLauncherInterval = setInterval(refreshMascotLauncher, 3000);
    window.addEventListener("hashchange", function () {
      setTimeout(refreshMascotLauncher, 300);
    });
    window.addEventListener("popstate", function () {
      setTimeout(refreshMascotLauncher, 300);
    });
  }

  // Self-start for payments.google.com iframes that load/reload during an active pull
  if (!isTopFrame && window.location.origin.indexOf("payments.google.com") !== -1) {
    // Check if this iframe is embedded in admin.google.com billing page
    var isEmbeddedInBilling = false;
    try {
      var hostOrigin = new URLSearchParams(window.location.search).get("hostOrigin");
      if (hostOrigin) {
        var decoded = atob(hostOrigin);
        isEmbeddedInBilling = decoded.indexOf("admin.google.com") !== -1;
      }
    } catch (e) {}
    if (!isEmbeddedInBilling) {
      try {
        isEmbeddedInBilling = window.location.href.indexOf("admin.google.com") !== -1 ||
                              window.location.search.indexOf("admin.google.com") !== -1;
      } catch (e) {}
    }

    if (isEmbeddedInBilling) {
      console.log("[FiBuKI] Payments iframe in billing context, checking for active run...");
      // Small delay to ensure all functions are defined
      setTimeout(function () {
        // Ask background if there's an active run for this tab
        chrome.runtime.sendMessage({ type: "TS_CHECK_ACTIVE_RUN" }, function (response) {
          if (response && response.runId && !currentRunId) {
            manualCaptureMode = !!response.manual;
            console.log("[FiBuKI] Found active run, mode:", manualCaptureMode ? "manual" : "auto", response.runId);
            currentRunId = response.runId;
            if (manualCaptureMode) {
              return;
            }
            clickGooglePaymentsRetryCount = 0; // Reset retry counter
            // IMPORTANT: Expand ALL cards FIRST, then do downloads
            // Cards must be expanded before any PDF links become visible
            setTimeout(expandGooglePaymentsCards, 800);
            setTimeout(expandGooglePaymentsCards, 2500);
            setTimeout(expandGooglePaymentsCards, 4500);
            // Only start PDF downloads AFTER cards are expanded
            // Sequential processing: one invoice at a time (~2.3s each)
            setTimeout(clickGooglePaymentsDownloadButtons, 6000);
          }
        });
      }, 100);
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data || {};
    if (data.type === "TAXSTUDIO_VISIBLE_PULL" && data.url && data.runId) {
      console.log("[FiBuKI] Start visible pull:", data.runId, data.url);
      chrome.runtime.sendMessage({
        type: "TS_START_PULL",
        url: data.url,
        runId: data.runId,
        appOrigin: window.location.origin,
        authToken: data.authToken || null,
      });
      return;
    }
    if (data.type === "TAXSTUDIO_START_REPLAY" && data.partnerId && data.recipe) {
      console.log("[FiBuKI] Start replay mode:", data.partnerId, data.partnerName);
      var replayPayload = {
        type: "TS_START_REPLAY",
        partnerId: data.partnerId,
        partnerName: data.partnerName || "",
        transactionId: data.transactionId || null,
        recipe: data.recipe,
        transactionAmount: data.transactionAmount || 0,
        transactionDate: data.transactionDate || null,
        transactionCurrency: data.transactionCurrency || "EUR",
        appOrigin: window.location.origin,
        authToken: data.authToken || null,
      };
      function sendReplayWithRetry(attempt) {
        try {
          chrome.runtime.sendMessage(replayPayload, function (response) {
            var err = chrome.runtime.lastError;
            if (err || !response || !response.ok) {
              var errMsg = err ? err.message : "no response";
              console.warn("[FiBuKI] Background not responsive for replay (attempt " + attempt + "):", errMsg);
              if (errMsg && errMsg.indexOf("context invalidated") !== -1) {
                window.postMessage({ type: "TAXSTUDIO_REPLAY_ERROR", error: "Extension was updated. Please refresh this page and try again." }, "*");
                return;
              }
              if (attempt < 3) {
                setTimeout(function () { sendReplayWithRetry(attempt + 1); }, 500);
              } else {
                window.postMessage({ type: "TAXSTUDIO_REPLAY_ERROR", error: "Extension background not responding. Try reloading the extension." }, "*");
              }
            } else {
              console.log("[FiBuKI] Background acknowledged replay mode:", response.runId);
            }
          });
        } catch (e) {
          console.error("[FiBuKI] Extension context invalidated:", e.message);
          window.postMessage({ type: "TAXSTUDIO_REPLAY_ERROR", error: "Extension was updated. Please refresh this page and try again." }, "*");
        }
      }
      sendReplayWithRetry(1);
      return;
    }
    if (data.type === "TAXSTUDIO_REPLAY_TIER2_COMMANDS" && data.commands) {
      console.log("[FiBuKI] Forwarding Tier 2 commands to background:", (data.commands || []).length);
      try {
        chrome.runtime.sendMessage({
          type: "TS_REPLAY_TIER2_COMMANDS",
          runId: data.runId || "",
          commands: data.commands || [],
          isDone: data.isDone || false,
          appOrigin: window.location.origin,
        });
      } catch (e) {
        console.error("[FiBuKI] Failed to forward Tier 2 commands:", e.message);
      }
      return;
    }
    if (data.type === "TAXSTUDIO_START_LEARN" && data.partnerId) {
      console.log("[FiBuKI] Start learn mode:", data.partnerId, data.partnerName);
      var learnPayload = {
        type: "TS_START_LEARN",
        partnerId: data.partnerId,
        partnerName: data.partnerName || "",
        transactionId: data.transactionId || null,
        startUrl: data.startUrl || null,
        appOrigin: window.location.origin,
        authToken: data.authToken || null,
      };
      // Send with response callback to detect dormant/invalidated service worker
      function sendLearnWithRetry(attempt) {
        try {
          chrome.runtime.sendMessage(learnPayload, function (response) {
            var err = chrome.runtime.lastError;
            if (err || !response || !response.ok) {
              var errMsg = err ? err.message : "no response";
              console.warn("[FiBuKI] Background not responsive (attempt " + attempt + "):", errMsg);
              if (errMsg && errMsg.indexOf("context invalidated") !== -1) {
                window.postMessage({ type: "TAXSTUDIO_LEARN_ERROR", error: "Extension was updated. Please refresh this page and try again." }, "*");
                return;
              }
              if (attempt < 3) {
                setTimeout(function () { sendLearnWithRetry(attempt + 1); }, 500);
              } else {
                window.postMessage({ type: "TAXSTUDIO_LEARN_ERROR", error: "Extension background not responding. Try reloading the extension." }, "*");
              }
            } else {
              console.log("[FiBuKI] Background acknowledged learn mode:", response.runId);
            }
          });
        } catch (e) {
          // chrome.runtime may throw synchronously if context is invalidated
          console.error("[FiBuKI] Extension context invalidated:", e.message);
          window.postMessage({ type: "TAXSTUDIO_LEARN_ERROR", error: "Extension was updated. Please refresh this page and try again." }, "*");
        }
      }
      sendLearnWithRetry(1);
      return;
    }
    if (data.type === "TAXSTUDIO_DEV_EXTRACT") {
      runRemoteExtractor("manual");
      return;
    }
    if (data.type !== EXTENSION_PING) return;
    window.postMessage(
      {
        type: EXTENSION_PONG,
        source: EXTENSION_SOURCE,
        version: VERSION,
      },
      "*"
    );
  });

  // Diagnostic: log ALL TS_ messages from MAIN world hooks
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data || {};
    if (typeof data.type === "string" && data.type.indexOf("TS_") === 0) {
      console.log("[FiBuKI] MAIN→CS message:", data.type, data.url ? data.url.slice(0, 80) : "", data.base64 ? "(base64:" + data.base64.length + ")" : "", data.href ? data.href.slice(0, 60) : "");
    }
  });

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data || {};
    if (data.type !== "TS_NETWORK_PDF" || !data.url) return;
    var runId = currentRunId || learnRunId;
    console.log("[FiBuKI] TS_NETWORK_PDF handler: url:", data.url.slice(0, 80), "runId:", runId, "learnRunId:", learnRunId);
    if (!runId) return;
    if (manualCaptureMode && !learnRunId && Date.now() - lastManualInvoiceClickAt > 8000) {
      return;
    }
    var url = data.url;
    if (seenNetworkUrls[url]) return;
    try {
      if (new URL(url).origin !== window.location.origin) return;
    } catch (err) {
      return;
    }
    seenNetworkUrls[url] = true;
    overlayState.items.push({ url: url, label: guessLabel(url) });
    if (isTopFrame) {
      renderOverlayList();
    }
    chrome.runtime.sendMessage({
      type: "TS_DOWNLOAD_URLS",
      runId: runId,
      urls: [url],
      pageOrigin: window.location.origin,
    });
  });

  // Handle TS_BLOB_PDF — blob URL createObjectURL with PDF content
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data || {};
    if (data.type !== "TS_BLOB_PDF" || !data.base64) return;
    var runId = currentRunId || learnRunId || replayRunId;
    console.log("[FiBuKI] TS_BLOB_PDF received, base64 size:", data.base64.length, "runId:", runId, "learnRunId:", learnRunId, "currentRunId:", currentRunId, "replayRunId:", replayRunId);
    if (!runId) {
      console.warn("[FiBuKI] TS_BLOB_PDF dropped — no active runId");
      return;
    }

    try {
      // Decode base64 to Uint8Array
      var binary = atob(data.base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      // Verify PDF magic bytes
      if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
        console.log("[FiBuKI] TS_BLOB_PDF is valid PDF, uploading...", bytes.length, "bytes");
        chrome.runtime.sendMessage({
          type: "TS_UPLOAD_FILE",
          runId: runId,
          buffer: Array.from(bytes),
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          sourceUrl: data.blobUrl || "blob-capture",
        });
      } else {
        console.warn("[FiBuKI] TS_BLOB_PDF not a PDF, magic bytes:", bytes[0], bytes[1], bytes[2], bytes[3]);
      }
    } catch (e) {
      console.warn("[FiBuKI] TS_BLOB_PDF decode error:", e);
    }
  });

  // Handle TS_ANCHOR_DOWNLOAD — anchor.click() with blob: or data: href
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data || {};
    if (data.type !== "TS_ANCHOR_DOWNLOAD" || !data.href) return;
    var runId = currentRunId || learnRunId || replayRunId;
    if (!runId) return;

    var href = data.href;
    var filename = data.filename || "download.pdf";
    console.log("[FiBuKI] TS_ANCHOR_DOWNLOAD captured:", href.slice(0, 60), filename);

    if (href.indexOf("blob:") === 0) {
      // Blob URLs can't be fetched from content script (different execution context).
      // Blob PDFs are already captured by TS_BLOB_PDF handler via URL.createObjectURL hook.
      console.log("[FiBuKI] TS_ANCHOR_DOWNLOAD: blob URL skipped (handled by TS_BLOB_PDF)");
    } else if (href.indexOf("data:") === 0) {
      // data: URI — check for PDF content type and decode
      try {
        var isPdfData = href.indexOf("data:application/pdf") === 0;
        if (!isPdfData) return;
        var base64Match = href.match(/;base64,(.+)/);
        if (!base64Match) return;
        var binary = atob(base64Match[1]);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        chrome.runtime.sendMessage({
          type: "TS_UPLOAD_FILE",
          runId: runId,
          buffer: Array.from(bytes),
          filename: filename.indexOf(".pdf") !== -1 ? filename : filename + ".pdf",
          mimeType: "application/pdf",
          sourceUrl: "data-uri-capture",
        });
      } catch (e) {
        console.warn("[FiBuKI] TS_ANCHOR_DOWNLOAD data URI decode error:", e);
      }
    }
  });

  function ensureOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;

    // Save original styles so we can restore later
    if (!window.__tsOriginalPadding) {
      window.__tsOriginalPadding = document.documentElement.style.padding || "";
      window.__tsOriginalBoxSizing = document.documentElement.style.boxSizing || "";
      window.__tsOriginalBodyPadding = document.body.style.padding || "";
      window.__tsOriginalBodyBoxSizing = document.body.style.boxSizing || "";
      window.__tsOriginalBodyMargin = document.body.style.margin || "";
    }
    // Push page content inward so it's not hidden behind the 16px border
    document.documentElement.style.setProperty('padding', '16px', 'important');
    document.documentElement.style.setProperty('box-sizing', 'border-box', 'important');
    document.body.style.setProperty('padding', '16px', 'important');
    document.body.style.setProperty('box-sizing', 'border-box', 'important');
    document.body.style.setProperty('margin', '0', 'important');

    // Inject animation styles for gradient border with hue shift and breathing
    var styleId = "ts-overlay-styles";
    if (!document.getElementById(styleId)) {
      var style = document.createElement("style");
      style.id = styleId;
      style.textContent =
        "@keyframes ts-gradient-rotate { " +
          "0% { background-position: 0% 50%; } " +
          "50% { background-position: 100% 50%; } " +
          "100% { background-position: 0% 50%; } " +
        "} " +
        "@keyframes ts-hue-shift { " +
          "0% { filter: hue-rotate(0deg); } " +
          "100% { filter: hue-rotate(360deg); } " +
        "} " +
        "@keyframes ts-glow-breathe { " +
          "0%, 100% { opacity: 0.35; filter: blur(12px) hue-rotate(0deg); } " +
          "50% { opacity: 0.6; filter: blur(16px) hue-rotate(180deg); } " +
        "} " +
        "#" + OVERLAY_ID + "-glow { " +
          "position: fixed !important; " +
          "inset: -20px !important; " +
          "background: linear-gradient(90deg, #10b981, #06b6d4, #8b5cf6, #ec4899, #f59e0b, #10b981) !important; " +
          "background-size: 300% 300% !important; " +
          "animation: ts-gradient-rotate 3s ease infinite, ts-glow-breathe 6s ease-in-out infinite !important; " +
          "pointer-events: none !important; " +
          "z-index: 2147483647 !important; " +
          "-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "-webkit-mask-composite: xor !important; " +
          "mask-composite: exclude !important; " +
          "padding: 24px !important; " +
          "transition: transform 0.8s ease-out !important; " +
        "} " +
        "#" + OVERLAY_ID + "-border { " +
          "position: fixed !important; " +
          "inset: 0 !important; " +
          "background: linear-gradient(90deg, #10b981, #06b6d4, #8b5cf6, #ec4899, #f59e0b, #10b981) !important; " +
          "background-size: 300% 300% !important; " +
          "animation: ts-gradient-rotate 3s ease infinite, ts-hue-shift 12s linear infinite !important; " +
          "pointer-events: none !important; " +
          "z-index: 2147483646 !important; " +
          "-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "-webkit-mask-composite: xor !important; " +
          "mask-composite: exclude !important; " +
          "padding: 16px !important; " +
          "transition: transform 0.8s ease-out !important; " +
        "}";
      (document.head || document.documentElement).appendChild(style);
    }

    // Create the glow layer (behind border, with breathing)
    var glowEl = document.getElementById(OVERLAY_ID + "-glow");
    if (!glowEl) {
      glowEl = document.createElement("div");
      glowEl.id = OVERLAY_ID + "-glow";
      document.body.appendChild(glowEl);
    }

    // Create the animated gradient border element
    var borderEl = document.getElementById(OVERLAY_ID + "-border");
    if (!borderEl) {
      borderEl = document.createElement("div");
      borderEl.id = OVERLAY_ID + "-border";
      document.body.appendChild(borderEl);

      // Subtle random organic movement (affects both glow and border)
      var moveX = 0, moveY = 0;
      var targetX = 0, targetY = 0;
      setInterval(function() {
        // Pick new random target within small range
        targetX = (Math.random() - 0.5) * 3; // -1.5 to 1.5px
        targetY = (Math.random() - 0.5) * 3;
      }, 2000);
      function animateMove() {
        // Ease toward target
        moveX += (targetX - moveX) * 0.02;
        moveY += (targetY - moveY) * 0.02;
        var transform = "translate(" + moveX + "px, " + moveY + "px)";
        if (borderEl) borderEl.style.transform = transform;
        if (glowEl) glowEl.style.transform = transform;
        requestAnimationFrame(animateMove);
      }
      animateMove();
    }

    var overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "2147483647";

    var badge = document.createElement("div");
    badge.textContent = "TS";
    badge.style.position = "fixed";
    badge.style.top = "12px";
    badge.style.right = "12px";
    badge.style.padding = "6px 10px";
    badge.style.borderRadius = "999px";
    badge.style.background = "linear-gradient(135deg, #10b981, #06b6d4, #8b5cf6)";
    badge.style.backgroundSize = "200% 200%";
    badge.style.animation = "ts-gradient-rotate 3s ease infinite, ts-hue-shift 12s linear infinite";
    badge.style.color = "#ffffff";
    badge.style.font = "600 12px/1 sans-serif";
    badge.style.boxShadow = "0 6px 16px rgba(16, 185, 129, 0.35)";
    badge.style.pointerEvents = "none";

    var panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.right = "12px";
    panel.style.bottom = "12px";
    panel.style.width = "320px";
    panel.style.maxHeight = "40vh";
    panel.style.overflow = "hidden";
    panel.style.borderRadius = "14px";
    panel.style.background = "rgba(6, 16, 38, 0.92)";
    panel.style.backdropFilter = "blur(8px)";
    panel.style.color = "#e6f2ff";
    panel.style.font = "500 12px/1.4 'Inter', sans-serif";
    panel.style.boxShadow = "0 12px 30px rgba(4, 11, 24, 0.35)";
    panel.style.pointerEvents = "auto";

    var header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.padding = "10px 12px";
    header.style.borderBottom = "1px solid rgba(255,255,255,0.08)";

    var titleWrap = document.createElement("div");
    titleWrap.style.display = "flex";
    titleWrap.style.flexDirection = "column";
    titleWrap.style.gap = "2px";

    var title = document.createElement("div");
    title.textContent = "FiBuKI Collector";
    title.style.fontWeight = "600";
    title.style.fontSize = "12px";

    var status = document.createElement("div");
    status.id = STATUS_ID;
    status.textContent = "Waiting for page...";
    status.style.fontSize = "10px";
    status.style.opacity = "0.7";

    titleWrap.appendChild(title);
    titleWrap.appendChild(status);

    var count = document.createElement("span");
    count.id = COUNT_ID;
    count.textContent = "0 found";
    count.style.fontSize = "11px";
    count.style.opacity = "0.7";

    // Pause button
    var pauseBtn = document.createElement("button");
    pauseBtn.id = "taxstudio-pause-btn";
    pauseBtn.textContent = "Pause";
    pauseBtn.style.padding = "4px 10px";
    pauseBtn.style.borderRadius = "6px";
    pauseBtn.style.border = "1px solid rgba(255,255,255,0.2)";
    pauseBtn.style.background = "rgba(239, 68, 68, 0.2)";
    pauseBtn.style.color = "#fca5a5";
    pauseBtn.style.font = "600 10px/1 sans-serif";
    pauseBtn.style.cursor = "pointer";
    pauseBtn.style.marginLeft = "8px";
    pauseBtn.addEventListener("click", function() {
      var newPausedState = !pausedForLogin;
      pausedForLogin = newPausedState;
      // Broadcast pause/resume to all frames via background
      chrome.runtime.sendMessage({
        type: "TS_TOGGLE_PAUSE",
        runId: currentRunId,
        paused: newPausedState,
      });
      if (newPausedState) {
        pauseBtn.textContent = "Resume";
        pauseBtn.style.background = "rgba(34, 197, 94, 0.2)";
        pauseBtn.style.color = "#86efac";
        setOverlayStatus("PAUSED - Click Resume to continue");
        console.log("[FiBuKI] Automation PAUSED by user");
      } else {
        pauseBtn.textContent = "Pause";
        pauseBtn.style.background = "rgba(239, 68, 68, 0.2)";
        pauseBtn.style.color = "#fca5a5";
        setOverlayStatus("Resumed...");
        console.log("[FiBuKI] Automation RESUMED by user");
        // Restart automation
        setTimeout(function() { expandGooglePaymentsCards(); }, 500);
        setTimeout(function() { clickGooglePaymentsDownloadButtons(); }, 2000);
      }
    });

    var headerRight = document.createElement("div");
    headerRight.style.display = "flex";
    headerRight.style.alignItems = "center";
    headerRight.appendChild(count);
    headerRight.appendChild(pauseBtn);

    header.appendChild(titleWrap);
    header.appendChild(headerRight);

    var list = document.createElement("div");
    list.id = LIST_ID;
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "8px";
    list.style.padding = "10px 12px";
    list.style.maxHeight = "28vh";
    list.style.overflow = "hidden";

    var more = document.createElement("button");
    more.id = MORE_ID;
    more.textContent = "Load more";
    more.style.width = "100%";
    more.style.padding = "10px 12px";
    more.style.border = "none";
    more.style.cursor = "pointer";
    more.style.font = "600 11px/1 sans-serif";
    more.style.background = "transparent";
    more.style.color = "#7dd3fc";
    more.style.borderTop = "1px solid rgba(255,255,255,0.08)";
    more.style.display = "none";
    more.addEventListener("click", function () {
      overlayState.limit += 4;
      renderOverlayList();
    });

    panel.appendChild(header);
    panel.appendChild(list);
    panel.appendChild(more);

    overlay.appendChild(badge);
    overlay.appendChild(panel);
    document.documentElement.appendChild(overlay);
  }

  // Login page detection patterns
  // Use [/\-_\.] prefix to catch hyphenated compounds like /mein-magenta-login/
  var LOGIN_URL_PATTERNS = [
    /[/\-_.]signin/i,
    /[/\-_.]sign-in/i,
    /[/\-_.]login/i,
    /[/\-_.]log-in/i,
    /[/\-_.]anmeld/i,        // German: anmelden, anmeldung
    /[/\-_.]einloggen/i,     // German: einloggen
    /\/auth\//i,
    /\/authenticate/i,
    /\/oauth\//i,
    /\/sso\//i,
    /accounts\.google\.com\/.*ServiceLogin/i,
    /accounts\.google\.com\/.*signin/i,
    /accounts\.google\.com\/.*identifier/i,
    /accounts\.google\.com\/.*challenge/i,
    /login\.microsoftonline\.com/i,
    /auth0\.com\/.*login/i,
    /\/saml\//i,
  ];

  // URLs that look like login but aren't (utility iframes, etc.)
  var LOGIN_WHITELIST_PATTERNS = [
    /RotateCookiesPage/i,
    /widget\/app/i,
    /auth_warmup/i,
  ];

  function isLoginPage(url) {
    if (!url) url = window.location.href;
    // Only check TOP frame for login redirects - iframes shouldn't trigger this
    if (!isTopFrame) return false;
    // Check whitelist first
    for (var i = 0; i < LOGIN_WHITELIST_PATTERNS.length; i++) {
      if (LOGIN_WHITELIST_PATTERNS[i].test(url)) {
        return false;
      }
    }
    // Check login patterns
    for (var i = 0; i < LOGIN_URL_PATTERNS.length; i++) {
      if (LOGIN_URL_PATTERNS[i].test(url)) {
        return true;
      }
    }
    return false;
  }

  function showLoginPrompt() {
    if (!isTopFrame) return;
    if (document.getElementById(LOGIN_PROMPT_ID)) return;

    var overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;

    var prompt = document.createElement("div");
    prompt.id = LOGIN_PROMPT_ID;
    prompt.style.position = "fixed";
    prompt.style.left = "50%";
    prompt.style.bottom = "20px";
    prompt.style.transform = "translateX(-50%)";
    prompt.style.padding = "16px 24px";
    prompt.style.borderRadius = "12px";
    prompt.style.background = "rgba(6, 16, 38, 0.95)";
    prompt.style.backdropFilter = "blur(12px)";
    prompt.style.color = "#e6f2ff";
    prompt.style.font = "500 14px/1.5 'Inter', sans-serif";
    prompt.style.boxShadow = "0 -4px 30px rgba(4, 11, 24, 0.5)";
    prompt.style.textAlign = "center";
    prompt.style.zIndex = "2147483647";
    prompt.style.pointerEvents = "auto";
    prompt.style.border = "1px solid rgba(255,255,255,0.1)";
    prompt.style.display = "flex";
    prompt.style.alignItems = "center";
    prompt.style.gap = "16px";

    var icon = document.createElement("div");
    icon.textContent = "🔐";
    icon.style.fontSize = "24px";

    var textWrap = document.createElement("div");

    var title = document.createElement("div");
    title.textContent = "Login Required";
    title.style.fontSize = "14px";
    title.style.fontWeight = "600";

    var message = document.createElement("div");
    message.textContent = "Please sign in, then click Done";
    message.style.opacity = "0.7";
    message.style.fontSize = "12px";

    textWrap.appendChild(title);
    textWrap.appendChild(message);

    var doneBtn = document.createElement("button");
    doneBtn.textContent = "Done - I'm logged in";
    doneBtn.style.padding = "12px 24px";
    doneBtn.style.border = "none";
    doneBtn.style.borderRadius = "8px";
    doneBtn.style.background = "linear-gradient(135deg, #10b981, #06b6d4)";
    doneBtn.style.color = "#fff";
    doneBtn.style.font = "600 14px/1 sans-serif";
    doneBtn.style.cursor = "pointer";
    doneBtn.style.transition = "transform 0.15s, box-shadow 0.15s";
    doneBtn.style.boxShadow = "0 4px 12px rgba(16, 185, 129, 0.3)";
    doneBtn.addEventListener("mouseenter", function () {
      doneBtn.style.transform = "scale(1.02)";
      doneBtn.style.boxShadow = "0 6px 16px rgba(16, 185, 129, 0.4)";
    });
    doneBtn.addEventListener("mouseleave", function () {
      doneBtn.style.transform = "scale(1)";
      doneBtn.style.boxShadow = "0 4px 12px rgba(16, 185, 129, 0.3)";
    });
    doneBtn.addEventListener("click", function () {
      hideLoginPrompt();
      resumeAfterLogin();
    });

    prompt.appendChild(icon);
    prompt.appendChild(textWrap);
    prompt.appendChild(doneBtn);

    overlay.appendChild(prompt);
    setOverlayStatus("Waiting for login...");
  }

  function hideLoginPrompt() {
    var prompt = document.getElementById(LOGIN_PROMPT_ID);
    if (prompt) {
      prompt.remove();
    }
  }

  function removePullOverlay() {
    manualCaptureMode = false;
    [OVERLAY_ID, OVERLAY_ID + "-border", OVERLAY_ID + "-glow", LOGIN_PROMPT_ID].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    });

    // Restore original padding on documentElement and body
    if (window.__tsOriginalPadding !== undefined) {
      if (window.__tsOriginalPadding) {
        document.documentElement.style.padding = window.__tsOriginalPadding;
      } else {
        document.documentElement.style.removeProperty('padding');
      }
      if (window.__tsOriginalBoxSizing) {
        document.documentElement.style.boxSizing = window.__tsOriginalBoxSizing;
      } else {
        document.documentElement.style.removeProperty('box-sizing');
      }
      if (window.__tsOriginalBodyPadding) {
        document.body.style.padding = window.__tsOriginalBodyPadding;
      } else {
        document.body.style.removeProperty('padding');
      }
      if (window.__tsOriginalBodyBoxSizing) {
        document.body.style.boxSizing = window.__tsOriginalBodyBoxSizing;
      } else {
        document.body.style.removeProperty('box-sizing');
      }
      if (window.__tsOriginalBodyMargin) {
        document.body.style.margin = window.__tsOriginalBodyMargin;
      } else {
        document.body.style.removeProperty('margin');
      }
      delete window.__tsOriginalPadding;
      delete window.__tsOriginalBoxSizing;
      delete window.__tsOriginalBodyPadding;
      delete window.__tsOriginalBodyBoxSizing;
      delete window.__tsOriginalBodyMargin;
    }

    if (isTopFrame) {
      setTimeout(refreshMascotLauncher, 250);
    }
  }

  function resumeAfterLogin() {
    console.log("[FiBuKI] Resuming after login, original URL:", originalPullUrl);
    pausedForLogin = false;

    // If we're on a different page than where we started, go back
    if (originalPullUrl && window.location.href !== originalPullUrl) {
      // Check if we're still on a login page
      if (isLoginPage()) {
        setOverlayStatus("Still on login page, please complete sign in");
        pausedForLogin = true;
        showLoginPrompt();
        return;
      }
      // Navigate back to original URL
      setOverlayStatus("Returning to invoice page...");
      window.location.href = originalPullUrl;
      return;
    }

    // Resume automation - expand cards FIRST, then downloads
    setOverlayStatus("Resuming invoice collection...");
    setTimeout(clickGooglePaymentsAllTime, 500);
    setTimeout(clickGooglePaymentsAllTimeOption, 1200);
    setTimeout(expandGooglePaymentsCards, 3000);
    setTimeout(expandGooglePaymentsCards, 7000);
    // Downloads only after cards are expanded (sequential processing)
    setTimeout(clickGooglePaymentsDownloadButtons, 10000);
  }

  function checkForLoginRedirect() {
    if (!currentRunId) return;
    if (pausedForLogin) return;
    // Don't run login check during replay or learn mode
    if (replayMode || learnMode) return;

    var currentUrl = window.location.href;

    // Check if we're on a login page
    if (isLoginPage(currentUrl)) {
      console.log("[FiBuKI] Login page detected:", currentUrl);
      pausedForLogin = true;
      showLoginPrompt();
      return;
    }

    // If we were paused and now we're back on the original URL, resume
    if (originalPullUrl && currentUrl === originalPullUrl && pausedForLogin) {
      console.log("[FiBuKI] Back on original page, resuming");
      hideLoginPrompt();
      resumeAfterLogin();
    }
  }

  function startLoginCheck() {
    if (loginCheckInterval) {
      clearInterval(loginCheckInterval);
    }
    loginCheckInterval = setInterval(checkForLoginRedirect, 1000);
  }

  function stopLoginCheck() {
    if (loginCheckInterval) {
      clearInterval(loginCheckInterval);
      loginCheckInterval = null;
    }
  }

  function ensureMascotLauncherStyles() {
    if (document.getElementById(MASCOT_LAUNCHER_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = MASCOT_LAUNCHER_STYLE_ID;
    style.textContent =
      "#" + MASCOT_LAUNCHER_ID + "{" +
        "position:fixed;" +
        "right:8px;" +
        "bottom:-8px;" +
        "width:36px;" +
        "height:32px;" +
        "padding:0;" +
        "margin:0;" +
        "border:none;" +
        "background:transparent;" +
        "cursor:pointer;" +
        "z-index:2147483645;" +
        "transition:transform .18s ease;" +
      "}" +
      "#" + MASCOT_LAUNCHER_ID + ":hover{" +
        "transform:scale(1.05);" +
      "}" +
      "#" + MASCOT_LAUNCHER_ID + " img{" +
        "width:100%;" +
        "height:100%;" +
        "object-fit:contain;" +
        "filter:drop-shadow(0 -2px 8px rgba(2, 6, 23, .35));" +
        "animation:ts-mascot-bob 2.8s ease-in-out infinite;" +
        "user-select:none;" +
        "-webkit-user-drag:none;" +
      "}" +
      "@keyframes ts-mascot-bob{" +
        "0%,100%{transform:translateY(0)}" +
        "50%{transform:translateY(-3px)}" +
      "}";
    (document.head || document.documentElement).appendChild(style);
  }

  function hideMascotLauncher() {
    var launcher = document.getElementById(MASCOT_LAUNCHER_ID);
    if (launcher) launcher.remove();
  }

  function applyMascotCorner(launcher, corner) {
    if (!launcher) return;
    launcher.style.left = "auto";
    launcher.style.right = "auto";
    launcher.style.top = "auto";
    launcher.style.bottom = "auto";
    if (corner === "top_left") {
      launcher.style.left = "8px";
      launcher.style.top = "8px";
      return;
    }
    if (corner === "top_right") {
      launcher.style.right = "8px";
      launcher.style.top = "8px";
      return;
    }
    if (corner === "bottom_left") {
      launcher.style.left = "8px";
      launcher.style.bottom = "-8px";
      return;
    }
    launcher.style.right = "8px";
    launcher.style.bottom = "-8px";
  }

  function loadMascotCorner(callback) {
    try {
      chrome.storage.local.get([MASCOT_CORNER_KEY], function (result) {
        var value = result && result[MASCOT_CORNER_KEY];
        if (value === "top_left" || value === "top_right" || value === "bottom_left" || value === "bottom_right") {
          mascotCorner = value;
        }
        callback(mascotCorner);
      });
    } catch (err) {
      callback(mascotCorner);
    }
  }

  function saveMascotCorner(corner) {
    mascotCorner = corner;
    try {
      var payload = {};
      payload[MASCOT_CORNER_KEY] = corner;
      chrome.storage.local.set(payload);
    } catch (err) {}
  }

  function enableMascotDragging(launcher) {
    if (!launcher) return;
    var dragState = null;
    launcher.addEventListener("mousedown", function (event) {
      if (event.button !== 0) return;
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        dragged: false,
      };
      function onMove(moveEvent) {
        if (!dragState) return;
        var dx = moveEvent.clientX - dragState.startX;
        var dy = moveEvent.clientY - dragState.startY;
        if (!dragState.dragged && Math.sqrt(dx * dx + dy * dy) > 10) {
          dragState.dragged = true;
          launcher.style.transition = "none";
        }
        if (!dragState.dragged) return;
        launcher.style.left = Math.max(0, moveEvent.clientX - 18) + "px";
        launcher.style.top = Math.max(0, moveEvent.clientY - 16) + "px";
        launcher.style.right = "auto";
        launcher.style.bottom = "auto";
      }
      function onUp(upEvent) {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        if (!dragState) return;
        var wasDragged = dragState.dragged;
        dragState = null;
        if (!wasDragged) return;
        launcher.style.transition = "transform .18s ease";
        var horizontal = upEvent.clientX < window.innerWidth / 2 ? "left" : "right";
        var vertical = upEvent.clientY < window.innerHeight / 2 ? "top" : "bottom";
        var nextCorner = vertical + "_" + horizontal;
        saveMascotCorner(nextCorner);
        applyMascotCorner(launcher, nextCorner);
        suppressLauncherClick = true;
        setTimeout(function () {
          suppressLauncherClick = false;
        }, 180);
      }
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
  }

  function requestManualCaptureStart(source) {
    if (!isTopFrame) return;
    if (learnMode || replayMode) return;
    chrome.runtime.sendMessage(
      {
        type: "TS_START_MANUAL_CAPTURE",
        source: source || "launcher_click",
        appOrigin: window.location.origin,
      },
      function (response) {
        var err = chrome.runtime.lastError;
        if (err || !response || !response.ok) {
          console.warn("[FiBuKI] Manual capture start failed:", err ? err.message : "no response");
          return;
        }
        if (response.runId) {
          currentRunId = response.runId;
          manualCaptureMode = true;
        }
        hideMascotLauncher();
      }
    );
  }

  function pageLooksLikeInvoiceList() {
    var href = (window.location.href || "").toLowerCase();
    if (/invoice|billing|receipt|rechnung|facture|faktura|abrechnung|transactions|payments/.test(href)) {
      return true;
    }
    if (document.querySelector("[data-download-url],[data-download],[data-file],[data-link]")) {
      return true;
    }
    var nodes = document.querySelectorAll("a, button, [role='button'], [role='link']");
    var max = Math.min(nodes.length, 180);
    var invoiceSignals = 0;
    var downloadSignals = 0;
    for (var i = 0; i < max; i += 1) {
      var el = nodes[i];
      if (!el || el.hasAttribute("disabled")) continue;
      var text = ((el.innerText || el.textContent || "").trim().slice(0, 160)).toLowerCase();
      if (!text) continue;
      if (/invoice|receipt|rechnung|facture|faktura|bill|beleg|abrechnung/.test(text)) {
        invoiceSignals += 1;
      }
      if (/download|pdf/.test(text)) {
        downloadSignals += 1;
      }
      if ((invoiceSignals >= 2 && downloadSignals >= 1) || invoiceSignals >= 4 || downloadSignals >= 5) {
        return true;
      }
    }
    return false;
  }

  function refreshMascotLauncher() {
    if (!isTopFrame) return;
    if (document.hidden) return;
    if (learnMode || replayMode || currentRunId) {
      hideMascotLauncher();
      return;
    }
    if (!pageLooksLikeInvoiceList()) {
      hideMascotLauncher();
      return;
    }
    if (document.getElementById(MASCOT_LAUNCHER_ID)) return;
    ensureMascotLauncherStyles();
    var launcher = document.createElement("button");
    launcher.id = MASCOT_LAUNCHER_ID;
    launcher.type = "button";
    launcher.title = "download invoices directly to FiBuKI";
    launcher.setAttribute("aria-label", "download invoices directly to FiBuKI");
    var img = document.createElement("img");
    img.alt = "FiBuKI";
    img.src = chrome.runtime.getURL("icons/icon128.png");
    launcher.appendChild(img);
    enableMascotDragging(launcher);
    launcher.addEventListener("click", function (event) {
      if (suppressLauncherClick) return;
      event.preventDefault();
      event.stopPropagation();
      requestManualCaptureStart("launcher_click");
    });
    document.documentElement.appendChild(launcher);
    loadMascotCorner(function (corner) {
      applyMascotCorner(launcher, corner);
    });
  }

  function getManualCandidateUrlFromElement(target) {
    if (!target || !target.getAttribute) return "";
    var raw =
      target.getAttribute("href") ||
      target.getAttribute("data-download-url") ||
      target.getAttribute("data-download") ||
      target.getAttribute("data-url") ||
      target.getAttribute("data-href") ||
      target.getAttribute("data-file") ||
      target.getAttribute("data-link") ||
      "";
    if (!raw) return "";
    if (raw.indexOf("javascript:") === 0 || raw.indexOf("mailto:") === 0) return "";
    try {
      return new URL(raw, window.location.href).toString();
    } catch (err) {
      return "";
    }
  }

  function handleManualInvoiceClick(event) {
    if (!manualCaptureMode || !currentRunId) return;
    if (pausedForLogin || learnMode || replayMode) return;
    if (!event || event.button !== 0) return;
    var target = event.target;
    if (!target || !target.closest) return;
    if (document.getElementById(OVERLAY_ID) && document.getElementById(OVERLAY_ID).contains(target)) return;
    if (document.getElementById(MASCOT_LAUNCHER_ID) && document.getElementById(MASCOT_LAUNCHER_ID).contains(target)) return;

    var clickable = target.closest("a[href],button,[role='button'],[role='link'],[data-download-url],[data-download],[data-url],[data-href],[data-file],[data-link]");
    if (!clickable) return;

    var text = (
      (clickable.innerText || clickable.textContent || "") + " " +
      (clickable.getAttribute("aria-label") || "") + " " +
      (clickable.getAttribute("title") || "")
    ).toLowerCase();
    var candidateUrl = getManualCandidateUrlFromElement(clickable);
    var isLikelyInvoiceAction =
      /invoice|receipt|rechnung|facture|faktura|beleg|abrechnung|download|pdf/.test(text) ||
      (candidateUrl ? looksLikeDownload(candidateUrl) : false);

    if (!isLikelyInvoiceAction) return;

    lastManualInvoiceClickAt = Date.now();
    if (isTopFrame) {
      setOverlayStatus("Invoice click captured. Waiting for file...");
    }
    if (!candidateUrl) return;
    if (!seenNetworkUrls[candidateUrl]) {
      seenNetworkUrls[candidateUrl] = true;
      overlayState.items.push({ url: candidateUrl, label: guessLabel(candidateUrl) });
      if (isTopFrame) {
        renderOverlayList();
      }
    }
    chrome.runtime.sendMessage({
      type: "TS_DOWNLOAD_URLS",
      runId: currentRunId,
      urls: [candidateUrl],
      pageOrigin: "",
    });
  }

  function renderOverlayList() {
    var list = document.getElementById(LIST_ID);
    var count = document.getElementById(COUNT_ID);
    var more = document.getElementById(MORE_ID);
    if (!list || !count || !more) return;
    list.innerHTML = "";
    count.textContent = overlayState.items.length + " found";
    overlayState.items.slice(0, overlayState.limit).forEach(function (item) {
      var row = document.createElement("div");
      row.style.display = "flex";
      row.style.flexDirection = "column";
      row.style.gap = "2px";
      row.style.padding = "6px 8px";
      row.style.borderRadius = "10px";
      row.style.background = "rgba(255,255,255,0.05)";
      row.style.border = "1px solid rgba(255,255,255,0.06)";

      var label = document.createElement("div");
      label.textContent = item.label;
      label.style.fontSize = "11px";
      label.style.fontWeight = "600";
      label.style.whiteSpace = "nowrap";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";

      var url = document.createElement("div");
      url.textContent = item.url;
      url.style.fontSize = "10px";
      url.style.opacity = "0.7";
      url.style.whiteSpace = "nowrap";
      url.style.overflow = "hidden";
      url.style.textOverflow = "ellipsis";

      row.appendChild(label);
      row.appendChild(url);
      list.appendChild(row);
    });
    if (overlayState.items.length > overlayState.limit) {
      more.style.display = "block";
    } else {
      more.style.display = "none";
    }
  }

  function setOverlayStatus(text) {
    var status = document.getElementById(STATUS_ID);
    if (!status) return;
    status.textContent = text;
  }

  function sendDevLog(level, payload) {
    if (!currentRunId) return;
    try {
      chrome.runtime.sendMessage({
        type: "TS_DEV_LOG",
        runId: currentRunId,
        level: level,
        payload: payload,
      });
    } catch (err) {
      // ignore
    }
  }

  function canRunDevExtractor() {
    var now = Date.now();
    devExtractorCalls = devExtractorCalls.filter(function (ts) {
      return now - ts < DEV_EXTRACTOR_WINDOW_MS;
    });
    if (devExtractorCalls.length >= DEV_EXTRACTOR_MAX_CALLS) {
      return false;
    }
    devExtractorCalls.push(now);
    return true;
  }

  function getDevExtractorSettings(callback) {
    try {
      chrome.storage.local.get(["ts_dev_extractor_enabled", "ts_dev_extractor_url"], function (result) {
        var enabled = true;
        if (result && typeof result.ts_dev_extractor_enabled === "boolean") {
          enabled = result.ts_dev_extractor_enabled;
        }
        var url = (result && result.ts_dev_extractor_url) || DEV_EXTRACTOR_FALLBACK_URL;
        callback(enabled, url);
      });
    } catch (err) {
      callback(true, DEV_EXTRACTOR_FALLBACK_URL);
    }
  }

  function emitCandidateUrls(urls, origin) {
    if (!currentRunId || !urls || !urls.length) return;
    var added = 0;
    urls.forEach(function (url) {
      if (seenNetworkUrls[url]) return;
      seenNetworkUrls[url] = true;
      overlayState.items.push({ url: url, label: guessLabel(url) });
      added += 1;
    });
    if (added > 0) {
      if (isTopFrame) {
        setOverlayStatus("Dev extractor found " + added + " urls");
        renderOverlayList();
      }
      chrome.runtime.sendMessage({
        type: "TS_DOWNLOAD_URLS",
        runId: currentRunId,
        urls: urls.slice(0, 5),
        pageOrigin: origin || window.location.origin,
      });
    }
  }

  // Sandbox iframe for dynamic script execution (bypasses CSP)
  var sandboxFrame = null;
  var sandboxReady = false;
  var sandboxQueue = [];
  var sandboxCallbacks = {};
  var sandboxRequestId = 0;

  function ensureSandbox(callback) {
    if (sandboxReady && sandboxFrame) {
      callback();
      return;
    }
    sandboxQueue.push(callback);
    if (sandboxFrame) return; // Already creating

    sandboxFrame = document.createElement("iframe");
    sandboxFrame.src = chrome.runtime.getURL("sandbox.html");
    sandboxFrame.style.display = "none";
    document.documentElement.appendChild(sandboxFrame);
  }

  window.addEventListener("message", function (event) {
    if (!event.data) return;

    // Sandbox ready signal
    if (event.data.type === "TS_SANDBOX_READY") {
      sandboxReady = true;
      sandboxQueue.forEach(function (cb) { cb(); });
      sandboxQueue = [];
      return;
    }

    // Sandbox execution result
    if (event.data.type === "TS_SANDBOX_RESULT") {
      var cb = sandboxCallbacks[event.data.requestId];
      if (cb) {
        delete sandboxCallbacks[event.data.requestId];
        cb(event.data);
      }
    }
  });

  function collectPageData() {
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll('button, [role="button"]')
    ).slice(0, 100);
    var menuButtons = Array.prototype.slice.call(
      document.querySelectorAll('[aria-haspopup="true"]')
    ).slice(0, 50);

    // Collect all links that might be invoice/document links
    var allLinks = Array.prototype.slice.call(document.querySelectorAll("a[href]"));
    var invoiceLinks = allLinks.filter(function (a) {
      var text = (a.textContent || "").trim();
      var href = a.getAttribute("href") || "";
      // Match: invoice numbers, "Created:", "PDF", document patterns
      return /\d{5,}/.test(text) || // Long numbers (invoice IDs)
             /created:/i.test(text) ||
             /pdf|invoice|document/i.test(text) ||
             /pdf|invoice|doc/i.test(href);
    }).slice(0, 30);

    // Collect menu items (for after clicking invoice links)
    var menuItems = Array.prototype.slice.call(
      document.querySelectorAll('[role="menuitem"], [role="option"], .goog-menuitem, [data-value]')
    ).slice(0, 30);

    // Find expandable sections (Documents, PDF Invoice, etc.)
    var expandables = Array.prototype.slice.call(
      document.querySelectorAll('[aria-expanded], [role="button"][aria-controls]')
    ).slice(0, 20);

    return {
      url: window.location.href,
      runId: currentRunId,
      snapshot: {
        title: document.title,
        bodyHTML: document.body.innerHTML.slice(0, 50000),
        tables: document.querySelectorAll("table").length,
        buttons: buttons.map(function (b, i) {
          return {
            index: i,
            text: (b.textContent || "").trim().slice(0, 100),
            ariaLabel: b.getAttribute("aria-label"),
            hasPopup: b.getAttribute("aria-haspopup"),
            className: b.className || "",
          };
        }),
        menuButtons: menuButtons.map(function (b, i) {
          return {
            index: i,
            text: (b.textContent || "").trim().slice(0, 100),
            ariaLabel: b.getAttribute("aria-label"),
            className: b.className || "",
          };
        }),
        invoiceLinks: invoiceLinks.map(function (a, i) {
          return {
            index: i,
            text: (a.textContent || "").trim().slice(0, 100),
            href: (a.getAttribute("href") || "").slice(0, 200),
            className: a.className || "",
          };
        }),
        menuItems: menuItems.map(function (m, i) {
          return {
            index: i,
            text: (m.textContent || "").trim().slice(0, 100),
            ariaLabel: m.getAttribute("aria-label"),
            dataValue: m.getAttribute("data-value"),
          };
        }),
        expandables: expandables.map(function (e, i) {
          return {
            index: i,
            text: (e.textContent || "").trim().slice(0, 100),
            expanded: e.getAttribute("aria-expanded"),
          };
        }),
        menus: menuButtons.length,
        links: allLinks.length,
      },
      dataAttributeUrls: findDataAttributeDownloads(),
    };
  }

  function executeCommands(commands, callback) {
    var index = 0;
    var menuButtonNodes = Array.prototype.slice.call(
      document.querySelectorAll('[aria-haspopup="true"]')
    );
    var buttonNodes = Array.prototype.slice.call(
      document.querySelectorAll('button, [role="button"]')
    );

    // Collect invoice links fresh each time (they might appear after clicks)
    function getInvoiceLinks() {
      return Array.prototype.slice.call(document.querySelectorAll("a[href]")).filter(function (a) {
        var text = (a.textContent || "").trim();
        var href = a.getAttribute("href") || "";
        return /\d{5,}/.test(text) || /created:/i.test(text) ||
               /pdf|invoice|document/i.test(text) || /pdf|invoice|doc/i.test(href);
      });
    }

    // Collect menu items fresh (they appear after opening dropdowns)
    function getMenuItems() {
      return Array.prototype.slice.call(
        document.querySelectorAll('[role="menuitem"], [role="option"], .goog-menuitem, [jsaction]')
      );
    }

    function next() {
      if (index >= commands.length) {
        if (callback) callback();
        return;
      }
      var cmd = commands[index++];

      switch (cmd.action) {
        case "click":
          // target can be index or selector
          var node = null;
          if (typeof cmd.target === "number") {
            node = menuButtonNodes[cmd.target] || buttonNodes[cmd.target];
          } else if (typeof cmd.target === "string") {
            node = document.querySelector(cmd.target);
          }
          if (node) dispatchMouseSequence(node);
          next();
          break;

        case "clickSelector":
          var el = document.querySelector(cmd.selector);
          if (el) dispatchMouseSequence(el);
          next();
          break;

        case "clickAll":
          var nodes = Array.prototype.slice.call(document.querySelectorAll(cmd.selector));
          nodes.slice(0, cmd.limit || 3).forEach(function (n) {
            dispatchMouseSequence(n);
          });
          next();
          break;

        case "sleep":
          setTimeout(next, cmd.ms || 500);
          break;

        case "emitCandidates":
          emitCandidateUrls(cmd.urls || [], cmd.origin || window.location.origin);
          next();
          break;

        case "sendDebugLog":
          fetch(appBaseUrl + "/api/browser/log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId: currentRunId,
              url: window.location.href,
              type: (cmd.data && cmd.data.type) || "extractor_debug",
              pageSnapshot: cmd.data && (cmd.data.snapshot || cmd.data.pageSnapshot) || null,
            }),
          }).catch(function () {});
          next();
          break;

        case "clickInvoiceLink":
          // Click an invoice link by index
          var invoiceLinks = getInvoiceLinks();
          var linkIndex = cmd.index || 0;
          if (invoiceLinks[linkIndex]) {
            sendDevLog("log", "Clicking invoice link " + linkIndex + ": " + (invoiceLinks[linkIndex].textContent || "").trim().slice(0, 50));
            dispatchMouseSequence(invoiceLinks[linkIndex]);
          } else {
            sendDevLog("warn", "Invoice link " + linkIndex + " not found, have " + invoiceLinks.length);
          }
          next();
          break;

        case "clickMenuItem":
          // Click a menu item by text pattern
          var menuItems = getMenuItems();
          var pattern = cmd.pattern ? new RegExp(cmd.pattern, "i") : /download/i;
          var found = null;
          for (var mi = 0; mi < menuItems.length; mi++) {
            var itemText = (menuItems[mi].textContent || "").trim();
            if (pattern.test(itemText)) {
              found = menuItems[mi];
              break;
            }
          }
          if (found) {
            sendDevLog("log", "Clicking menu item: " + (found.textContent || "").trim().slice(0, 50));
            dispatchMouseSequence(found);
          } else {
            sendDevLog("warn", "Menu item matching /" + (cmd.pattern || "download") + "/ not found");
          }
          next();
          break;

        case "clickExpandable":
          // Click an expandable section by text pattern
          var expandables = Array.prototype.slice.call(
            document.querySelectorAll('[aria-expanded], [role="button"][aria-controls]')
          );
          var expPattern = cmd.pattern ? new RegExp(cmd.pattern, "i") : /document|pdf/i;
          var expFound = null;
          for (var ei = 0; ei < expandables.length; ei++) {
            var expText = (expandables[ei].textContent || "").trim();
            if (expPattern.test(expText)) {
              expFound = expandables[ei];
              break;
            }
          }
          if (expFound) {
            sendDevLog("log", "Clicking expandable: " + (expFound.textContent || "").trim().slice(0, 50));
            dispatchMouseSequence(expFound);
          } else {
            sendDevLog("warn", "Expandable matching /" + (cmd.pattern || "document|pdf") + "/ not found");
          }
          next();
          break;

        case "refreshSnapshot":
          // Re-collect page data after DOM changes and send debug log
          var freshData = collectPageData();
          fetch(appBaseUrl + "/api/browser/log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId: currentRunId,
              url: window.location.href,
              type: "refresh_snapshot",
              pageSnapshot: freshData.snapshot,
            }),
          }).catch(function () {});
          next();
          break;

        default:
          next();
      }
    }
    next();
  }

  function runRemoteExtractor(reason) {
    if (!currentRunId) return;
    if (pausedForLogin) return;
    if (!canRunDevExtractor()) {
      sendDevLog("warn", "Dev extractor throttled (6/min).");
      return;
    }

    getDevExtractorSettings(function (enabled, url) {
      if (!enabled) return;

      // Fetch script via background to avoid CORS
      chrome.runtime.sendMessage({
        type: "TS_FETCH_EXTRACTOR",
        url: url,
      }, function (response) {
        if (!response || !response.script) {
          sendDevLog("error", "Failed to fetch extractor script");
          return;
        }

        var script = response.script;
        if (!script.trim()) {
          sendDevLog("warn", "Dev extractor empty.");
          return;
        }

        setOverlayStatus("Running dev extractor...");

        // Ensure sandbox is ready
        ensureSandbox(function () {
          var pageData = collectPageData();
          pageData.reason = reason || "auto";

          var reqId = ++sandboxRequestId;
          sandboxCallbacks[reqId] = function (result) {
            // Process logs
            (result.logs || []).forEach(function (log) {
              sendDevLog(log.level || "log", log.message);
            });

            if (!result.success) {
              sendDevLog("error", "Sandbox error: " + (result.error || "unknown"));
              return;
            }

            // Execute commands returned from sandbox
            if (result.commands && result.commands.length) {
              executeCommands(result.commands, function () {
                setOverlayStatus("Extractor completed.");
              });
            } else {
              setOverlayStatus("Extractor completed (no actions).");
            }
          };

          // Send to sandbox
          sandboxFrame.contentWindow.postMessage({
            type: "TS_SANDBOX_EXEC",
            requestId: reqId,
            script: script,
            pageData: pageData,
          }, "*");
        });
      });
    });
  }

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_SHOW_OVERLAY") return;
    // Don't show pull overlay when in replay or learn mode
    if (replayMode || learnMode) return;
    manualCaptureMode = !!message.manual;
    var frameType = isTopFrame ? "TOP" : "IFRAME";
    console.log("[FiBuKI] TS_SHOW_OVERLAY (" + frameType + ")", message.runId || "", manualCaptureMode ? "manual" : "auto", window.location.origin);
    if (isTopFrame) {
      hideMascotLauncher();
      ensureOverlay();
    }
    var incomingRunId = message.runId || null;
    if (currentRunId !== incomingRunId) {
      currentRunId = incomingRunId;
      overlayState.items = [];
      overlayState.limit = 4;
      seenNetworkUrls = {};
      pausedForLogin = false;
      clickGooglePaymentsRetryCount = 0;
      if (!manualCaptureMode) {
        // Store original URL for returning after login
        originalPullUrl = window.location.href;
        console.log("[FiBuKI] Original pull URL stored:", originalPullUrl);
      }
    }
    if (isTopFrame) {
      console.log("[FiBuKI] Visible pull active:", currentRunId || "");
      setOverlayStatus(
        manualCaptureMode
          ? "Manual mode: click invoice downloads."
          : "Waiting for invoice buttons..."
      );
      if (!manualCaptureMode) {
        // Start monitoring for login redirects
        startLoginCheck();
      }
    }
    if (manualCaptureMode) {
      stopLoginCheck();
      if (isTopFrame) {
        renderOverlayList();
      }
      return;
    }
    // Check if we're already on a login page
    if (isLoginPage()) {
      console.log("[FiBuKI] Already on login page, pausing");
      pausedForLogin = true;
      if (isTopFrame) {
        showLoginPrompt();
      }
      return; // Don't start automation
    }
    setTimeout(scanForInvoices, 800);
    waitForInvoiceButtons(triggerInvoiceClicks);
    setTimeout(triggerPdfMenuDownloads, 1600);
    setTimeout(function () {
      runRemoteExtractor("auto");
    }, 1200);
    observeDownloadAttributes();
    // Special handling for Google Payments iframe
    // 1. First try to select "All time" date range
    setTimeout(clickGooglePaymentsAllTime, 1000);
    setTimeout(clickGooglePaymentsAllTime, 3000); // Retry if first attempt failed
    // 2. Expand ALL cards FIRST (sequential processing ~500ms per card)
    //    Give plenty of time before starting downloads
    setTimeout(expandGooglePaymentsCards, 5000);  // After date change settles
    setTimeout(expandGooglePaymentsCards, 10000); // Second pass for any missed
    setTimeout(expandGooglePaymentsCards, 15000); // Third pass
    // 3. Start PDF downloads AFTER cards are expanded
    //    clickGooglePaymentsDownloadButtons now processes sequentially (~2.3s per invoice)
    setTimeout(clickGooglePaymentsDownloadButtons, 17000);
    // 4. After first batch, try to load more and repeat
    setTimeout(clickGooglePaymentsLoadMore, 40000);  // After ~10 invoices processed
    setTimeout(expandGooglePaymentsCards, 42000);
    setTimeout(clickGooglePaymentsDownloadButtons, 45000); // Second batch
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_FILE_UPLOADED") return;
    if (!message.runId || message.runId !== currentRunId) return;
    var filename = message.filename || "file";
    setOverlayStatus("Uploaded: " + filename);
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_PAUSE_FOR_LOGIN") return;
    if (!message.runId || message.runId !== currentRunId) return;
    pausedForLogin = true;
    setOverlayStatus("Login required. Please sign in.");
  });

  // Listen for pause/resume broadcasts from other frames
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_SET_PAUSED") return;
    if (!message.runId || message.runId !== currentRunId) return;
    pausedForLogin = message.paused;
    var ft = isTopFrame ? "TOP" : "IFRAME";
    console.log("[FiBuKI] Pause state set (" + ft + "):", pausedForLogin);
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_PULL_EVENT") return;
    window.postMessage(
      {
        type: "TAXSTUDIO_PULL_EVENT",
        runId: message.runId,
        status: message.status,
      },
      "*"
    );
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_DEV_LOG") return;
    window.postMessage(
      {
        type: "TS_DEV_LOG",
        runId: message.runId,
        level: message.level,
        payload: message.payload,
      },
      "*"
    );
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_FRAME_CANDIDATES") return;
    if (!isTopFrame) return;
    if (!currentRunId || message.runId !== currentRunId) return;
    var urls = message.urls || [];
    var origin = message.origin || window.location.origin;
    if (!urls.length) return;
    var added = 0;
    urls.forEach(function (url) {
      if (seenNetworkUrls[url]) return;
      seenNetworkUrls[url] = true;
      overlayState.items.push({ url: url, label: guessLabel(url) });
      added += 1;
    });
    if (added > 0) {
      setOverlayStatus("Found data-attribute downloads: " + added);
      renderOverlayList();
      chrome.runtime.sendMessage({
        type: "TS_DOWNLOAD_URLS",
        runId: currentRunId,
        urls: urls.slice(0, 5),
        pageOrigin: origin,
      });
    }
  });
  try {
    if (window.name && window.name.indexOf(WINDOW_NAME_PREFIX) === 0) {
      var runId = window.name.slice(WINDOW_NAME_PREFIX.length);
      console.log("[FiBuKI] Attaching to run", runId);
      chrome.runtime.sendMessage({
        type: "TS_ATTACH_PULL",
        runId: runId,
      });
    }
  } catch (err) {
    // ignore
  }

  try {
    if (window.location.hash && window.location.hash.indexOf(HASH_PREFIX) !== -1) {
      var hashRunId = window.location.hash.replace("#", "").split(HASH_PREFIX)[1];
      if (hashRunId) {
        console.log("[FiBuKI] Attaching via hash", hashRunId);
        chrome.runtime.sendMessage({
          type: "TS_ATTACH_PULL",
          runId: hashRunId,
        });
      }
    }
  } catch (err) {
    // ignore
  }

  function scanForInvoices() {
    if (!currentRunId) return;
    if (pausedForLogin) return;
    var links = Array.prototype.slice.call(document.querySelectorAll("a[href]"));
    var matches = [];
    var seen = {};
    var keywordRe = /(invoice|receipt|bill|rechnung|facture|faktura)/i;
    var baseOrigin = window.location.origin;

    // Log all clickable elements in payments.google.com iframe for debugging
    if (!isTopFrame && window.location.origin.indexOf("payments.google.com") !== -1) {
      var clickables = document.querySelectorAll('[role="button"], [jsaction], button, a[href]');
      console.log("[FiBuKI] Payments iframe clickables:", clickables.length);
      Array.prototype.slice.call(clickables).slice(0, 10).forEach(function (el, i) {
        var text = (el.textContent || "").trim().slice(0, 60);
        var tag = el.tagName;
        var role = el.getAttribute("role") || "";
        var jsaction = (el.getAttribute("jsaction") || "").slice(0, 50);
        if (text && text.length < 200 && !/wiz_progress/.test(text)) {
          console.log("[FiBuKI]   " + i + ": <" + tag + "> role=" + role + " text=\"" + text + "\" jsaction=" + jsaction);
        }
      });
    }

    links.forEach(function (link) {
      var href = link.getAttribute("href") || "";
      var text = link.textContent || "";
      var absolute = "";
      try {
        absolute = new URL(href, window.location.href).toString();
      } catch (err) {
        return;
      }
      if (absolute.indexOf("javascript:") === 0) return;
      if (absolute.indexOf("mailto:") === 0) return;
      if (new URL(absolute).origin !== baseOrigin) return;

      var isPdfLink = absolute.toLowerCase().indexOf(".pdf") !== -1;
      if (isPdfLink || (keywordRe.test(absolute) && absolute.toLowerCase().indexOf("pdf") !== -1)) {
        if (!seen[absolute]) {
          seen[absolute] = true;
          matches.push(absolute);
        }
      }
    });

    if (matches.length > 50) {
      matches = matches.slice(0, 50);
    }

    var dataMatches = findDataAttributeDownloads();
    dataMatches.forEach(function (url) {
      if (!seen[url]) {
        seen[url] = true;
        matches.push(url);
      }
    });

    var frameType = isTopFrame ? "TOP" : "IFRAME";
    console.log("[FiBuKI] Invoice link scan (" + frameType + "):", matches.length, "found", window.location.origin);
    overlayState.items = matches.map(function (url) {
      return { url: url, label: guessLabel(url) };
    });
    if (matches.length) {
      setOverlayStatus("Found invoice links on page.");
    }
    renderOverlayList();
    chrome.runtime.sendMessage({
      type: "TS_PULL_RESULTS",
      runId: currentRunId,
      urls: matches,
    });

    chrome.runtime.sendMessage({
      type: "TS_DOWNLOAD_URLS",
      runId: currentRunId,
      urls: matches.slice(0, 5),
      pageOrigin: window.location.origin,
    });
  }

  function observeDownloadAttributes() {
    if (!currentRunId) return;
    if (pausedForLogin) return;
    var observer = new MutationObserver(function () {
      if (pausedForLogin) return;
      scanDataAttributeDownloads();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanDataAttributeDownloads();
    var intervalId = window.setInterval(scanDataAttributeDownloads, 1200);
    setTimeout(function () {
      observer.disconnect();
      window.clearInterval(intervalId);
    }, 8000);
  }

  function scanDataAttributeDownloads() {
    if (pausedForLogin) return;
    // SKIP clicking for payments.google.com - clickGooglePaymentsDownloadButtons handles this
    if (window.location.origin.indexOf("payments.google.com") === -1) {
      clickMenuDownloadTriggers();
    }
    var candidates = findDataAttributeDownloads();
    if (!candidates.length) return;
    var added = 0;
    candidates.forEach(function (url) {
      if (seenNetworkUrls[url]) return;
      seenNetworkUrls[url] = true;
      overlayState.items.push({ url: url, label: guessLabel(url) });
      added += 1;
    });
    if (added > 0) {
      if (isTopFrame) {
        setOverlayStatus("Found data-attribute downloads: " + added);
        renderOverlayList();
        chrome.runtime.sendMessage({
          type: "TS_DOWNLOAD_URLS",
          runId: currentRunId,
          urls: candidates.slice(0, 5),
          pageOrigin: window.location.origin,
        });
      } else {
        chrome.runtime.sendMessage({
          type: "TS_FRAME_CANDIDATES",
          runId: currentRunId,
          urls: candidates,
          origin: window.location.origin,
        });
      }
      // SKIP clicking for payments.google.com - clickGooglePaymentsDownloadButtons handles this
      if (window.location.origin.indexOf("payments.google.com") === -1) {
        clickDataDownloadElements();
      }
    }
  }

  function clickMenuDownloadTriggers() {
    if (pausedForLogin) return;
    var selectors = [
      ".b3id-document-zippy-line-item[aria-haspopup='true']",
      ".b3-document-zippy-line-item[aria-haspopup='true']",
      ".b3id-document-zippy-actions-menu[role='button']",
      ".b3-document-zippy-actions-menu[role='button']",
    ];
    var nodes = collectNodesWithSelectors(document, selectors.join(","));
    var clicked = 0;
    nodes.forEach(function (node) {
      if (clicked >= 2) return;
      if (node.getAttribute("data-ts-menu-opened") === "true") return;
      if (node.hasAttribute("disabled")) return;
      if (!node.offsetParent && node.getBoundingClientRect().width === 0) return;
      try {
        if (isInPdfGroup(node)) {
          lastMenuContext = "pdf";
        } else {
          lastMenuContext = "unknown";
        }
        lastMenuButton = node;
        var rect = node.getBoundingClientRect();
        lastMenuAnchor = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          time: Date.now(),
        };
        lastMenuOpenedAt = Date.now();
        node.click();
        node.setAttribute("data-ts-menu-opened", "true");
        clicked += 1;
        var ft = isTopFrame ? "TOP" : "IFRAME";
        console.log("[FiBuKI] Opened download menu (" + ft + ")", window.location.origin);
      } catch (err) {
        // ignore
      }
    });
  }

  function findDataAttributeDownloads() {
    var selectors = [
      "[data-download-url]",
      "[data-download]",
      "[data-url]",
      "[data-href]",
      "[data-file]",
      "[data-link]",
      // REMOVED: "[data-ui-reference]" - too broad, catches CSV header buttons
    ];
    var nodes = collectNodesWithSelectors(document, selectors.join(","));
    var urls = [];
    var seen = {};

    nodes.forEach(function (node) {
      var attrs = node.attributes;
      if (!attrs) return;
      if (isInCsvGroup(node)) return;
      // Skip card header download buttons (these download CSVs!)
      if (node.classList && (
          node.classList.contains('b3id-card-header-image-container') ||
          node.classList.contains('b3id-image-with-caption'))) {
        return;
      }
      // Skip elements with aria-label="Download" that contain SVG (header icons)
      if (node.getAttribute('aria-label') === 'Download' && node.querySelector('svg')) {
        return;
      }
      var inPdfGroup = isInPdfGroup(node);
      for (var i = 0; i < attrs.length; i += 1) {
        var attr = attrs[i];
        if (!attr || !attr.name || !attr.value) continue;
        if (attr.name.indexOf("data-") !== 0) continue;
        var value = attr.value;
        if (!value) continue;
        if (value.indexOf("http") === 0 || value.indexOf("/") === 0) {
          var absolute = "";
          try {
            absolute = new URL(value, window.location.href).toString();
          } catch (err) {
            continue;
          }
          if (new URL(absolute).origin !== window.location.origin) continue;
          if (seen[absolute]) continue;
          if (!inPdfGroup && !looksLikeDownload(value)) continue;
          seen[absolute] = true;
          urls.push(absolute);
        }
      }
    });

    if (urls.length && urls.length !== lastDataAttrCount) {
      console.log("[FiBuKI] Data-attr download candidates:", urls.length);
      lastDataAttrCount = urls.length;
    }
    return urls.slice(0, 30);
  }

  function collectNodesWithSelectors(root, selector) {
    var results = [];
    try {
      results = results.concat(Array.prototype.slice.call(root.querySelectorAll(selector)));
    } catch (err) {
      // ignore
    }
    var all = [];
    try {
      all = Array.prototype.slice.call(root.querySelectorAll("*"));
    } catch (err) {
      all = [];
    }
    all.forEach(function (el) {
      if (el.shadowRoot) {
        results = results.concat(collectNodesWithSelectors(el.shadowRoot, selector));
      }
    });
    return results;
  }

  function clickDataDownloadElements() {
    if (pausedForLogin) return;
    var selectors = [
      "[data-download-url]",
      "[data-download]",
      "[data-url]",
      "[data-href]",
      "[data-file]",
      "[data-link]",
    ];
    var nodes = collectNodesWithSelectors(document, selectors.join(","));
    var clicked = 0;
    nodes.forEach(function (node) {
      if (clicked >= 3) return;
      if (node.getAttribute("data-ts-clicked") === "true") return;
      if (node.getAttribute("aria-haspopup") === "true") return;
      if (node.hasAttribute("disabled")) return;
      // Skip CSV downloads - only want PDFs
      if (isInCsvGroup(node)) {
        console.log("[FiBuKI] Skipping CSV group element");
        return;
      }
      var downloadUrl = node.getAttribute("data-download-url") ||
                        node.getAttribute("data-download") ||
                        node.getAttribute("data-url") || "";
      if (downloadUrl && /\.csv|format=csv|account_activities/i.test(downloadUrl)) {
        console.log("[FiBuKI] Skipping CSV download URL");
        return;
      }
      try {
        node.click();
        node.setAttribute("data-ts-clicked", "true");
        clicked += 1;
        console.log("[FiBuKI] Clicked data-download trigger (PDF)");
      } catch (err) {
        // ignore
      }
    });
  }

  function looksLikeDownload(value) {
    var lower = value.toLowerCase();
    if (lower.indexOf(".csv") !== -1) return false;
    if (lower.indexOf(".pdf") !== -1) return true;
    if (lower.indexOf("download") !== -1) return true;
    if (lower.indexOf("invoice") !== -1) return true;
    if (lower.indexOf("doc=") !== -1) return true;
    return false;
  }

  function isInCsvGroup(node) {
    var current = node;
    var steps = 0;
    while (current && steps < 8) {
      // Check for document group containers
      if (current.classList && current.classList.contains("b3id-document-zippy-group")) {
        var header = current.querySelector(".b3id-document-zippy-group-header");
        if (header && /csv|account.*activit/i.test(header.textContent || "")) {
          return true;
        }
      }
      // Also check element's own text content for CSV markers
      var ownText = (current.textContent || "").slice(0, 200).toLowerCase();
      if (/csv\s*invoice|account\s*activit/i.test(ownText) && !/pdf\s*invoice/i.test(ownText)) {
        return true;
      }
      current = current.parentElement;
      steps += 1;
    }
    return false;
  }

  function isInPdfGroup(node) {
    var current = node;
    var steps = 0;
    while (current && steps < 6) {
      if (current.classList && current.classList.contains("b3id-document-zippy-group")) {
        var header = current.querySelector(".b3id-document-zippy-group-header");
        if (header && /pdf/i.test(header.textContent || "")) {
          return true;
        }
      }
      current = current.parentElement;
      steps += 1;
    }
    return false;
  }

  function triggerInvoiceClicks() {
    if (!currentRunId) return;
    if (pausedForLogin) return;
    // SKIP for payments.google.com - clickGooglePaymentsDownloadButtons handles this
    if (window.location.origin.indexOf("payments.google.com") !== -1) {
      console.log("[FiBuKI] triggerInvoiceClicks SKIPPED for payments.google.com");
      return;
    }
    var candidates = Array.prototype.slice.call(
      document.querySelectorAll("a, button, [role='button']")
    );
    var keywordRe = /(pdf|rechnung|download)/i;
    var clicked = 0;

    candidates.forEach(function (el) {
      if (clicked >= 3) return;
      var text = (el.textContent || "").trim();
      if (!text) return;
      // Skip CSV/activity buttons
      if (/csv|account.*activit/i.test(text)) return;
      // Match PDF keywords, or invoice with PDF/number pattern
      var isPdfRelated = keywordRe.test(text) || (/invoice/i.test(text) && /pdf|\d{5,}/i.test(text));
      if (!isPdfRelated) return;
      var inPdfGroup = isInPdfGroup(el);
      var isDownloadOnly = /^download$/i.test(text);
      if (isDownloadOnly && !inPdfGroup) return;
      if (isInCardHeader(el) && !inPdfGroup) return;
      if (el.hasAttribute("disabled")) return;
      if (el.getAttribute("aria-haspopup") === "true") return;
      try {
        el.click();
        clicked += 1;
        console.log("[FiBuKI] Clicked download trigger:", text);
      } catch (err) {
        // ignore
      }
    });

    if (clicked === 0) {
      console.log("[FiBuKI] No PDF/invoice buttons found to click.");
      setOverlayStatus("No PDF buttons found yet.");
    } else {
      setOverlayStatus("Triggered download buttons.");
    }
  }

  // Track which PDF invoice we're currently processing
  var currentPdfInvoiceIndex = 0;
  var pdfInvoiceQueue = [];

  // Special handler for Google Payments iframe - clicks PDF invoice links then Download
  // SEQUENTIAL: clicks ONE invoice, waits for dropdown, clicks Download, then next
  function clickGooglePaymentsDownloadButtons() {
    if (isTopFrame) return;
    if (pausedForLogin) return;
    if (window.location.origin.indexOf("payments.google.com") === -1) return;

    // First, check if there are unexpanded cards that need expanding
    var datePattern = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+\s*[–-]\s*\d+,?\s*\d{4}/i;
    var unexpandedCards = Array.prototype.slice.call(
      document.querySelectorAll('[aria-expanded="false"]')
    ).filter(function(el) {
      var text = (el.textContent || "").trim();
      return datePattern.test(text) && el.getAttribute("data-ts-expanded") !== "true";
    });

    // Check for visible PDF groups (cards that ARE expanded)
    var visiblePdfGroups = document.querySelectorAll('.b3id-document-zippy-group');
    console.log("[FiBuKI] PDF download check: " + unexpandedCards.length + " unexpanded cards, " + visiblePdfGroups.length + " visible PDF groups");

    // If there are unexpanded cards but no visible PDF groups, cards need to expand first
    if (unexpandedCards.length > 0 && visiblePdfGroups.length === 0) {
      clickGooglePaymentsRetryCount++;
      if (clickGooglePaymentsRetryCount < 5) {
        console.log("[FiBuKI] Cards not expanded yet, triggering expansion and retrying in 3s... (attempt " + clickGooglePaymentsRetryCount + ")");
        // Try to expand cards
        unexpandedCards.slice(0, 3).forEach(function(card, i) {
          setTimeout(function() {
            try {
              card.click();
              dispatchMouseSequence(card);
              card.setAttribute("data-ts-expanded", "true");
              console.log("[FiBuKI] Expanded card " + i);
            } catch (err) {}
          }, i * 500);
        });
        // Retry after cards expand
        setTimeout(clickGooglePaymentsDownloadButtons, 3000);
        return;
      }
    }

    // Find PDF invoice line items that have dropdowns (aria-haspopup="true")
    // These are inside b3id-document-zippy-group elements
    var pdfLineItems = Array.prototype.slice.call(
      document.querySelectorAll('.b3id-document-zippy-line-item[aria-haspopup="true"]')
    ).filter(function(el) {
      if (el.getAttribute("data-ts-invoice-done") === "true") return false;

      // Check if this is in a PDF group (not CSV)
      var group = el.closest('.b3id-document-zippy-group');
      if (!group) return false;

      var header = group.querySelector('.b3id-document-zippy-group-header');
      if (!header) return false;

      var headerText = (header.textContent || "").toLowerCase();

      // Only include if it's a PDF Invoice group
      if (/pdf\s*invoice/i.test(headerText)) {
        console.log("[FiBuKI] Found PDF invoice group:", headerText.slice(0, 50));
        return true;
      }
      return false;
    });

    console.log("[FiBuKI] PDF invoice line items with dropdown (IFRAME):", pdfLineItems.length);

    if (pdfLineItems.length === 0) {
      // Log what groups we do see for debugging
      Array.prototype.slice.call(visiblePdfGroups).forEach(function(group, i) {
        var header = group.querySelector('.b3id-document-zippy-group-header');
        var headerText = header ? (header.textContent || "").trim().slice(0, 60) : "no header";
        var lineItems = group.querySelectorAll('.b3id-document-zippy-line-item');
        console.log("[FiBuKI] Group " + i + ": \"" + headerText + "\" with " + lineItems.length + " line items");
      });
    }

    // Build queue of PDF invoices to process
    pdfInvoiceQueue = pdfLineItems.slice(0, 20);
    currentPdfInvoiceIndex = 0;

    // Start processing one at a time
    processNextPdfInvoice();
  }

  // Process one PDF invoice at a time: click line item → wait for dropdown → click Download → next
  function processNextPdfInvoice() {
    if (pausedForLogin) return;
    if (currentPdfInvoiceIndex >= pdfInvoiceQueue.length) {
      console.log("[FiBuKI] PDF invoice queue complete");
      return;
    }

    var lineItem = pdfInvoiceQueue[currentPdfInvoiceIndex];
    if (!lineItem || lineItem.getAttribute("data-ts-invoice-done") === "true") {
      currentPdfInvoiceIndex++;
      setTimeout(processNextPdfInvoice, 100);
      return;
    }

    var text = (lineItem.textContent || "").trim().slice(0, 50);
    console.log("[FiBuKI] Processing PDF invoice " + (currentPdfInvoiceIndex + 1) + "/" + pdfInvoiceQueue.length + ": \"" + text + "\"");

    // Scroll into view
    lineItem.scrollIntoView({ behavior: "instant", block: "center" });

    // Click the line item to open its dropdown menu
    try {
      lineItem.click();
      dispatchMouseSequence(lineItem);
      lineItem.setAttribute("data-ts-invoice-done", "true");
    } catch (err) {
      console.log("[FiBuKI] Invoice click error:", err.message);
      currentPdfInvoiceIndex++;
      setTimeout(processNextPdfInvoice, 100);
      return;
    }

    // Wait for dropdown to appear (poll for it)
    var attempts = 0;
    var maxAttempts = 20;
    var checkInterval = setInterval(function() {
      attempts++;

      // Look for visible dropdown menu
      var menus = Array.prototype.slice.call(
        document.querySelectorAll('[role="menu"], .goog-menu, .jfk-menu')
      ).filter(function(m) {
        var rect = m.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      if (menus.length > 0) {
        clearInterval(checkInterval);
        console.log("[FiBuKI] Dropdown appeared after " + attempts + " checks");

        // Find and click Download
        var downloadClicked = false;
        menus.forEach(function(menu) {
          if (downloadClicked) return;
          var items = menu.querySelectorAll('[role="menuitem"], .goog-menuitem, .goog-menuitem-content');
          Array.prototype.slice.call(items).forEach(function(item) {
            if (downloadClicked) return;
            var itemText = (item.textContent || "").trim().toLowerCase();
            if (itemText === "download") {
              console.log("[FiBuKI] Clicking Download in dropdown");
              item.click();
              dispatchMouseSequence(item);
              downloadClicked = true;
            }
          });
        });

        if (!downloadClicked) {
          console.log("[FiBuKI] No Download found in dropdown");
        }

        // Move to next invoice
        currentPdfInvoiceIndex++;
        setTimeout(processNextPdfInvoice, 2000); // 2s between invoices for download to start
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(checkInterval);
        console.log("[FiBuKI] Dropdown did not appear after " + attempts + " checks");
        currentPdfInvoiceIndex++;
        setTimeout(processNextPdfInvoice, 500);
      }
    }, 100); // Check every 100ms
  }

  // Click Download button in the currently open dropdown (not any random one)
  function clickDownloadInCurrentDropdown() {
    // Find visible menu/dropdown that just appeared
    var menus = Array.prototype.slice.call(
      document.querySelectorAll('[role="menu"], [role="listbox"], .goog-menu, [class*="popup"]')
    ).filter(function(m) {
      var rect = m.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    console.log("[FiBuKI] Visible menus for Download:", menus.length);

    // Find Download in the visible menu
    var downloadClicked = false;
    menus.forEach(function(menu) {
      if (downloadClicked) return;

      // Check if this menu is for a PDF (not CSV)
      var menuText = (menu.textContent || "").toLowerCase();
      if (/csv|account.*activit/i.test(menuText) && !/pdf/i.test(menuText.slice(0, 50))) {
        console.log("[FiBuKI] Skipping CSV menu");
        return;
      }

      var items = menu.querySelectorAll('[role="menuitem"], [role="option"], .goog-menuitem');
      Array.prototype.slice.call(items).forEach(function(item) {
        if (downloadClicked) return;
        var itemText = (item.textContent || "").trim().toLowerCase();

        // IMPORTANT: Skip header download icons - these download CSVs!
        // Only click text "Download" items, not icon buttons with aria-label
        if (item.classList.contains('b3id-card-header-image-container')) return;
        if (item.classList.contains('b3id-image-with-caption')) return;
        if (item.querySelector('svg')) return; // Skip if contains SVG icon

        if (itemText === "download") {
          console.log("[FiBuKI] Clicking Download in dropdown");
          dispatchMouseSequence(item);
          downloadClicked = true;
        }
      });
    });

    if (!downloadClicked) {
      console.log("[FiBuKI] No Download button found in dropdown");
    }
  }

  // Click Download in dropdown menu after invoice link is clicked
  function clickGooglePaymentsMenuDownload() {
    if (isTopFrame) return;
    if (pausedForLogin) return;
    if (window.location.origin.indexOf("payments.google.com") === -1) return;

    // Look for menu items with "Download" text
    var menuItems = Array.prototype.slice.call(
      document.querySelectorAll('[role="menuitem"], [role="option"], .goog-menuitem, .goog-menuitem-content')
    ).filter(function (el) {
      var text = (el.textContent || "").trim().toLowerCase();
      var rect = el.getBoundingClientRect();
      if (text !== "download" || rect.width <= 0 || rect.height <= 0) return false;

      // IMPORTANT: Skip header download icons - these download CSVs!
      if (el.classList.contains('b3id-card-header-image-container')) return false;
      if (el.classList.contains('b3id-image-with-caption')) return false;
      if (el.querySelector('svg')) return false; // Skip if contains SVG icon
      if (el.getAttribute('aria-label') === 'Download' && el.querySelector('svg')) return false;

      // Check if this Download is in a PDF context (not CSV)
      // Walk up the DOM to find context clues
      var current = el;
      var steps = 0;
      var contextText = "";
      while (current && steps < 8) {
        contextText += " " + (current.textContent || "").slice(0, 200);
        // Check siblings too
        if (current.previousElementSibling) {
          contextText += " " + (current.previousElementSibling.textContent || "").slice(0, 200);
        }
        current = current.parentElement;
        steps++;
      }
      contextText = contextText.toLowerCase();

      // Skip if CSV markers found
      if (/csv|account.*activit/i.test(contextText) && !/pdf/i.test(contextText.slice(0, 100))) {
        console.log("[FiBuKI] Skipping CSV Download menu item");
        return false;
      }

      return true;
    });

    console.log("[FiBuKI] Google Payments Download menu items (IFRAME, PDF only):", menuItems.length);

    menuItems.slice(0, 3).forEach(function (item, i) {
      if (item.getAttribute("data-ts-menu-clicked") === "true") return;
      var text = (item.textContent || "").trim();
      console.log("[FiBuKI] Clicking Download menu item " + i + ": \"" + text + "\"");
      try {
        dispatchMouseSequence(item);
        item.setAttribute("data-ts-menu-clicked", "true");
      } catch (err) {
        console.log("[FiBuKI] Menu click error:", err.message);
      }
    });

    // Only click small Download buttons if they're inside a visible menu/popup
    // (not the header activity download icons)
    var menuPopups = document.querySelectorAll('[role="menu"], .goog-menu, [class*="popup"]');
    if (menuPopups.length === 0) {
      console.log("[FiBuKI] No menu popup visible, skipping small download buttons");
      return;
    }

    var downloadBtns = [];
    Array.prototype.slice.call(menuPopups).forEach(function (menu) {
      // Check if this menu is in a PDF context (not CSV)
      var menuText = (menu.textContent || "").toLowerCase();
      var isCSVMenu = /csv|account.*activit/i.test(menuText) && !/pdf/i.test(menuText.slice(0, 100));
      if (isCSVMenu) {
        console.log("[FiBuKI] Skipping CSV menu popup");
        return;
      }

      var btns = menu.querySelectorAll('[role="button"], [role="menuitem"], .goog-menuitem');
      Array.prototype.slice.call(btns).forEach(function (btn) {
        var text = (btn.textContent || "").trim().toLowerCase();
        if (text === "download") {
          downloadBtns.push(btn);
        }
      });
    });

    console.log("[FiBuKI] Google Payments menu Download buttons (IFRAME, PDF only):", downloadBtns.length);

    downloadBtns.slice(0, 2).forEach(function (btn, i) {
      if (btn.getAttribute("data-ts-dl-clicked") === "true") return;
      console.log("[FiBuKI] Clicking menu Download button " + i);
      try {
        dispatchMouseSequence(btn);
        btn.setAttribute("data-ts-dl-clicked", "true");
      } catch (err) {
        console.log("[FiBuKI] Menu download click error:", err.message);
      }
    });
  }

  // Expand collapsed billing period cards
  function expandGooglePaymentsCards() {
    if (isTopFrame) return;
    if (pausedForLogin) return;
    if (window.location.origin.indexOf("payments.google.com") === -1) return;

    // Date pattern: "Nov 1 – 30, 2025" or "Dec 1-31, 2025" (no ^ anchor - can be anywhere in text)
    var datePattern = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+\s*[–-]\s*\d+,?\s*\d{4}/i;

    // Find ALL potential expandable elements - be aggressive
    var allClickables = Array.prototype.slice.call(
      document.querySelectorAll([
        '[aria-expanded="false"]',
        '[data-is-collapsed="true"]',
        '.b3id-header-container',
        '.b3-header-container',
        '.b3id-collapsing-card',
        '[role="button"]',
        '[jsaction]'
      ].join(', '))
    );

    // Filter to those with date ranges that aren't expanded yet
    var expandableCards = allClickables.filter(function (el) {
      var text = (el.textContent || "").trim();
      var rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 20) return false;
      if (el.getAttribute("data-ts-expanded") === "true") return false;
      if (el.getAttribute("aria-expanded") === "true") return false;
      // Must contain a date pattern like "Nov 1 – 30, 2025"
      if (!datePattern.test(text)) return false;
      // Skip if it's the already-expanded one (has "Documents" or "PDF Invoice" visible)
      if (/documents\s*\(\d+\)|pdf\s*invoice/i.test(text)) return false;
      // SKIP tooltip icons - they're not the clickable headers!
      var classStr = el.className || "";
      if (/tooltip|inline-tooltip/i.test(classStr)) return false;
      // Skip SPAN elements - headers are DIVs
      if (el.tagName === "SPAN") return false;
      return true;
    });

    // Score elements to pick the best one for each date
    function scoreElement(el) {
      var score = 0;
      var classStr = el.className || "";
      // Prefer elements with header-container class (these are the actual expandable headers)
      if (/b3id-header-container|b3-header-container/i.test(classStr)) score += 100;
      // Prefer elements with aria-expanded directly on them
      if (el.hasAttribute("aria-expanded")) score += 50;
      // Prefer role=heading or role=button
      var role = el.getAttribute("role") || "";
      if (role === "heading" || role === "button") score += 20;
      // Prefer DIV over other elements
      if (el.tagName === "DIV") score += 10;
      return score;
    }

    // Dedupe by getting the best scored element for each date
    var seenDates = {};
    var uniqueCards = [];
    expandableCards.forEach(function (el) {
      var text = (el.textContent || "").trim();
      var match = text.match(datePattern);
      if (!match) return;
      var dateKey = match[0];
      var score = scoreElement(el);
      if (!seenDates[dateKey]) {
        seenDates[dateKey] = { el: el, score: score };
        uniqueCards.push(el);
      } else {
        // Prefer higher scored element
        if (score > seenDates[dateKey].score) {
          var idx = uniqueCards.indexOf(seenDates[dateKey].el);
          if (idx !== -1) uniqueCards[idx] = el;
          seenDates[dateKey] = { el: el, score: score };
        }
      }
    });

    console.log("[FiBuKI] Expandable billing cards found (IFRAME):", uniqueCards.length);

    // Process cards SEQUENTIALLY with delays - this prevents focus issues
    var cardsToExpand = uniqueCards.slice(0, 12);

    function expandNextCard(index) {
      if (index >= cardsToExpand.length) {
        console.log("[FiBuKI] Card expansion complete");
        return;
      }

      var card = cardsToExpand[index];
      var text = (card.textContent || "").trim();
      var match = text.match(datePattern);
      console.log("[FiBuKI] Expanding card " + index + "/" + cardsToExpand.length + ":", match ? match[0] : text.slice(0, 30));

      // Find the actual clickable element - Google uses complex jsaction handlers
      // The actual clickable is often NOT the header-container but a parent or sibling
      var header = card;

      // Strategy 1: Find the closest collapsing-card parent (it often has the click handler)
      var collapsingCard = card.closest('.b3id-collapsing-card, .b3-collapsing-card');

      // Strategy 2: Find element with jsaction containing "click:" (actual click handler)
      var jsactionEl = null;
      if (collapsingCard) {
        jsactionEl = collapsingCard.querySelector('[jsaction*="click:"]');
      }
      if (!jsactionEl && card.parentElement) {
        jsactionEl = card.parentElement.querySelector('[jsaction*="click:"]');
      }
      if (!jsactionEl) {
        // Check ancestors for jsaction
        var current = card;
        for (var i = 0; i < 5 && current; i++) {
          var ja = current.getAttribute('jsaction') || '';
          if (ja.indexOf('click:') !== -1) {
            jsactionEl = current;
            break;
          }
          current = current.parentElement;
        }
      }

      // Use jsaction element if found, otherwise fall back to aria-expanded element
      if (jsactionEl) {
        header = jsactionEl;
      } else if (card.getAttribute("aria-expanded") === null) {
        header = card.querySelector('[aria-expanded="false"]') || card;
      }

      // Debug: log element details
      console.log("[FiBuKI] Card element:", header.tagName,
        "class=" + (header.className || "").slice(0, 60),
        "jsaction=" + (header.getAttribute("jsaction") || "none").slice(0, 50),
        "aria-expanded=" + header.getAttribute("aria-expanded"),
        "role=" + header.getAttribute("role"),
        "collapsingCard=" + (collapsingCard ? "found" : "none"));

      // Skip if already expanded
      if (header.getAttribute("aria-expanded") === "true") {
        console.log("[FiBuKI] Card already expanded, skipping to next");
        setTimeout(function() { expandNextCard(index + 1); }, 100);
        return;
      }
      if (header.getAttribute("data-ts-expanded") === "true") {
        setTimeout(function() { expandNextCard(index + 1); }, 100);
        return;
      }

      try {
        // Scroll element into view first
        header.scrollIntoView({ behavior: "instant", block: "center" });

        // Find all possible click targets: the header itself, any jsaction elements, any buttons
        var clickTargets = [header];
        var jsactionEl = header.querySelector('[jsaction]') || (header.getAttribute('jsaction') ? header : null);
        if (jsactionEl && clickTargets.indexOf(jsactionEl) === -1) clickTargets.push(jsactionEl);
        var buttonEl = header.querySelector('[role="button"]');
        if (buttonEl && clickTargets.indexOf(buttonEl) === -1) clickTargets.push(buttonEl);
        // Also check parent for jsaction
        if (header.parentElement && header.parentElement.getAttribute('jsaction')) {
          clickTargets.push(header.parentElement);
        }

        console.log("[FiBuKI] Card " + index + " click targets:", clickTargets.length);

        // Small delay then try all targets
        setTimeout(function() {
          clickTargets.forEach(function(target, ti) {
            try {
              // Focus first
              target.focus();

              // Native click (creates "trusted" event in some cases)
              target.click();

              // Full mouse/pointer sequence
              dispatchMouseSequence(target);

              // Keyboard events
              target.dispatchEvent(new KeyboardEvent("keydown", {
                key: " ", code: "Space", keyCode: 32, which: 32, bubbles: true, cancelable: true
              }));
              target.dispatchEvent(new KeyboardEvent("keyup", {
                key: " ", code: "Space", keyCode: 32, which: 32, bubbles: true, cancelable: true
              }));
              target.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
              }));

              // Also try dispatching click on document at element position (for delegated handlers)
              var rect = target.getBoundingClientRect();
              var docClick = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
                detail: 1
              });
              document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.dispatchEvent(docClick);
            } catch (e) {}
          });

          header.setAttribute("data-ts-expanded", "true");

          // Check if it worked and log result
          setTimeout(function() {
            var ariaVal = header.getAttribute("aria-expanded");
            console.log("[FiBuKI] Card " + index + " expand result: aria-expanded=" + ariaVal);
            // Continue to next card after delay
            setTimeout(function() { expandNextCard(index + 1); }, 300);
          }, 200);
        }, 100);

      } catch (err) {
        console.log("[FiBuKI] Card expand error:", err.message);
        setTimeout(function() { expandNextCard(index + 1); }, 100);
      }
    }

    // Start sequential expansion
    expandNextCard(0);
  }

  // Click the date range dropdown trigger and immediately select "All time"
  function clickGooglePaymentsAllTime() {
    if (isTopFrame) return;
    if (pausedForLogin) return;
    if (window.location.origin.indexOf("payments.google.com") === -1) return;

    // Look for date range selector - usually a button/dropdown with text like "Last 3 months", "This month", etc.
    var dateSelectors = Array.prototype.slice.call(
      document.querySelectorAll('[role="button"], [role="listbox"], [aria-haspopup="true"], [aria-haspopup="listbox"]')
    ).filter(function (el) {
      var text = (el.textContent || "").trim().toLowerCase();
      var rect = el.getBoundingClientRect();
      // Match date range patterns
      return rect.width > 0 && rect.height > 0 &&
             (/last\s*\d+\s*month|this\s*(month|year)|previous\s*(month|year)|all\s*time|custom\s*date/i.test(text) ||
              /month|year|time|date/i.test(text) && text.length < 50);
    });

    console.log("[FiBuKI] Date range selectors found (IFRAME):", dateSelectors.length);

    if (dateSelectors.length === 0) return;

    // Click the first date selector to open dropdown
    var selector = dateSelectors[0];
    var selectorText = (selector.textContent || "").trim().toLowerCase();

    // SKIP if already showing "All time" - don't re-open the dropdown
    if (selectorText === "all time" || /^all\s*time$/i.test(selectorText)) {
      console.log("[FiBuKI] Already set to 'All time', skipping");
      return;
    }

    if (selector.getAttribute("data-ts-alltime-done") === "true") return;

    console.log("[FiBuKI] Clicking date range selector:", (selector.textContent || "").trim().slice(0, 30));
    try {
      dispatchMouseSequence(selector);

      // Immediately watch for dropdown to appear and click "All time"
      var attempts = 0;
      var maxAttempts = 20;
      var checkInterval = setInterval(function () {
        attempts++;

        // Search for "All time" option
        var allTimeOption = Array.prototype.slice.call(
          document.querySelectorAll('*')
        ).filter(function (el) {
          var text = (el.textContent || "").trim().toLowerCase();
          var rect = el.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 10) return false;
          if (text !== "all time") return false;
          // Skip HTML/BODY
          if (el.tagName === "HTML" || el.tagName === "BODY") return false;
          return true;
        })[0];

        if (allTimeOption) {
          console.log("[FiBuKI] Found 'All time' option, clicking:", allTimeOption.tagName);
          clearInterval(checkInterval);
          dispatchMouseSequence(allTimeOption);
          selector.setAttribute("data-ts-alltime-done", "true");
          return;
        }

        if (attempts >= maxAttempts) {
          console.log("[FiBuKI] 'All time' option not found after", attempts, "attempts");
          clearInterval(checkInterval);
        }
      }, 50); // Check every 50ms

    } catch (err) {
      console.log("[FiBuKI] Date selector click error:", err.message);
    }
  }

  // Click "All time" option in the date range dropdown
  function clickGooglePaymentsAllTimeOption() {
    if (isTopFrame) return;
    if (pausedForLogin) return;
    if (window.location.origin.indexOf("payments.google.com") === -1) return;

    // Look for "All time" menu item - search ALL visible elements with that text
    var allElements = Array.prototype.slice.call(
      document.querySelectorAll('*')
    ).filter(function (el) {
      var text = (el.textContent || "").trim().toLowerCase();
      var rect = el.getBoundingClientRect();
      // Must be visible and contain "all time"
      if (rect.width < 20 || rect.height < 10) return false;
      if (text !== "all time") return false;
      // Skip if parent also matches (get the most specific element)
      var parent = el.parentElement;
      if (parent && (parent.textContent || "").trim().toLowerCase() === "all time") return false;
      return true;
    });

    // Log what we found for debugging
    if (allElements.length === 0) {
      // Try to find anything containing "all time" for debugging
      var debugElements = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function (el) {
        var text = (el.textContent || "").trim().toLowerCase();
        return text.indexOf("all time") !== -1 && el.getBoundingClientRect().width > 0;
      });
      if (debugElements.length > 0) {
        console.log("[FiBuKI] Elements containing 'all time':", debugElements.length);
        debugElements.slice(0, 3).forEach(function (el, i) {
          console.log("[FiBuKI]   " + i + ": <" + el.tagName + "> text=\"" + (el.textContent || "").trim().slice(0, 50) + "\"");
        });
      }
    }

    var menuItems = allElements;
    console.log("[FiBuKI] 'All time' options found (IFRAME):", menuItems.length);

    if (menuItems.length === 0) return;

    var option = menuItems[0];
    if (option.getAttribute("data-ts-alltime-clicked") === "true") return;

    console.log("[FiBuKI] Clicking 'All time' option");
    try {
      dispatchMouseSequence(option);
      option.setAttribute("data-ts-alltime-clicked", "true");
    } catch (err) {
      console.log("[FiBuKI] All time click error:", err.message);
    }
  }

  // Click "Load more" or pagination buttons
  function clickGooglePaymentsLoadMore() {
    if (isTopFrame) return;
    if (pausedForLogin) return;
    if (window.location.origin.indexOf("payments.google.com") === -1) return;

    // Look for "Load more", "Show more", pagination buttons
    var loadMoreBtns = Array.prototype.slice.call(
      document.querySelectorAll('[role="button"], button, a')
    ).filter(function (el) {
      var text = (el.textContent || "").trim().toLowerCase();
      var rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
             (/load\s*more|show\s*more|see\s*more|next|older/i.test(text) ||
              /expand|more\s*transactions|more\s*invoices/i.test(text));
    });

    console.log("[FiBuKI] Load more buttons found (IFRAME):", loadMoreBtns.length);

    if (loadMoreBtns.length === 0) return;

    loadMoreBtns.slice(0, 2).forEach(function (btn, i) {
      if (btn.getAttribute("data-ts-loadmore-clicked") === "true") return;
      console.log("[FiBuKI] Clicking load more button " + i + ":", (btn.textContent || "").trim().slice(0, 30));
      try {
        dispatchMouseSequence(btn);
        btn.setAttribute("data-ts-loadmore-clicked", "true");
      } catch (err) {
        console.log("[FiBuKI] Load more click error:", err.message);
      }
    });
  }

  function triggerPdfMenuDownloads() {
    if (pausedForLogin) return;
    // SKIP for payments.google.com - clickGooglePaymentsDownloadButtons handles this
    if (window.location.origin.indexOf("payments.google.com") !== -1) {
      console.log("[FiBuKI] triggerPdfMenuDownloads SKIPPED for payments.google.com");
      return;
    }
    var pdfGroups = Array.prototype.slice.call(
      document.querySelectorAll(".b3id-document-zippy-group")
    );
    var menus = [];
    pdfGroups.forEach(function (group) {
      var header = group.querySelector(".b3id-document-zippy-group-header");
      if (!header || !/pdf/i.test(header.textContent || "")) return;
      var menuButtons = group.querySelectorAll(
        ".b3id-document-zippy-line-item[role='button'][aria-haspopup='true']"
      );
      menuButtons.forEach(function (btn) {
        if (btn.getAttribute("data-ts-menu-opened") === "true") return;
        menus.push(btn);
      });
    });

    menus.slice(0, 3).forEach(function (btn) {
      try {
        var rect = btn.getBoundingClientRect();
        lastMenuAnchor = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          time: Date.now(),
        };
        lastMenuButton = btn;
        lastMenuOpenedAt = Date.now();
        lastMenuContext = "pdf";
        btn.click();
        btn.setAttribute("data-ts-menu-opened", "true");
        var ft = isTopFrame ? "TOP" : "IFRAME";
        console.log("[FiBuKI] Opened download menu (" + ft + ")", window.location.origin);
      } catch (err) {
        // ignore
      }
    });
    startMenuObserver();
    scanMenuItemsWithRetries(6, 450);
  }

  function scanMenuItemsWithRetries(tries, delay) {
    var attempts = 0;
    var intervalId = window.setInterval(function () {
      attempts += 1;
      var clicked = scanAndClickMenuItems();
      if (clicked > 0 || attempts >= tries) {
        window.clearInterval(intervalId);
      }
    }, delay);
  }

  function scanAndClickMenuItems() {
    // SKIP for payments.google.com - clickGooglePaymentsDownloadButtons handles this
    if (window.location.origin.indexOf("payments.google.com") !== -1) {
      console.log("[FiBuKI] scanAndClickMenuItems SKIPPED for payments.google.com");
      return 0;
    }
    // SKIP for ogs.google.com - Google apps widget, not relevant
    if (window.location.origin.indexOf("ogs.google.com") !== -1) {
      return 0;
    }
    // Broader search for Google's menu patterns
    var menuContainers = collectNodesWithSelectors(
      document,
      "[role='menu'], [role='listbox'], .goog-menu, .jfk-menu, [class*='menu'][class*='popup'], [class*='dropdown'], [data-menu-open='true']"
    );
    if (!menuContainers.length && lastMenuButton) {
      var ownedId =
        lastMenuButton.getAttribute("aria-owns") || lastMenuButton.getAttribute("aria-controls") || "";
      if (ownedId) {
        var owned = document.getElementById(ownedId);
        if (owned) {
          menuContainers = [owned];
        }
      }
    }
    // Also look for visible elements with menuitem role anywhere
    if (!menuContainers.length) {
      var visibleMenuItems = Array.prototype.slice.call(
        document.querySelectorAll('[role="menuitem"], [role="option"]')
      ).filter(function (el) {
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (visibleMenuItems.length > 0 && visibleMenuItems.length <= 10) {
        var ft = isTopFrame ? "TOP" : "IFRAME";
        console.log("[FiBuKI] Found visible menu items directly (" + ft + "):", visibleMenuItems.length);
        visibleMenuItems.forEach(function (item, i) {
          var text = (item.textContent || "").trim().slice(0, 50);
          console.log("[FiBuKI]   MenuItem " + i + ": \"" + text + "\"");
        });
      }
    }
    var scopedContainer = chooseMenuContainer(menuContainers);
    if (scopedContainer) {
      menuContainers = [scopedContainer];
    }
    var menuItems = [];
    var selectors = [
      "[role^='menuitem']",
      ".goog-menuitem",
      ".goog-menuitem-content",
      ".jfk-menuitem",
      ".jfk-menuitem-content",
      "[class*='menuitem']",
      "[data-action]",
      "[data-value]",
      "[data-download-url]",
      "[jsaction]",
      "[aria-label]",
    ].join(",");
    if (menuContainers.length) {
      menuContainers.forEach(function (menu) {
        menuItems = menuItems.concat(collectNodesWithSelectors(menu, selectors));
      });
    } else {
      menuItems = collectNodesWithSelectors(document, selectors);
    }
    menuItems = menuItems.filter(function (item, index, arr) {
      if (!item) return false;
      // Filter out structural/non-interactive elements
      var tag = item.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "BODY" || tag === "HTML" ||
          tag === "HEAD" || tag === "META" || tag === "LINK" || tag === "NOSCRIPT") return false;
      if (arr.indexOf(item) !== index) return false;
      if (item.getAttribute("data-ts-clicked") === "true") return false;
      if (!item.isConnected) return false;
      // Filter out very large elements (likely containers, not menu items)
      var rect = item.getBoundingClientRect();
      if (rect.width > 500 || rect.height > 300) return false;
      return true;
    });
    if (lastMenuContext === "pdf" && !scopedContainer && menuItems.length > 6) {
      return 0;
    }
    var ft = isTopFrame ? "TOP" : "IFRAME";
    console.log(
      "[FiBuKI] Menu containers (" + ft + "):",
      menuContainers.length,
      "items:",
      menuItems.length,
      "scoped:",
      scopedContainer ? "yes" : "no",
      window.location.origin
    );
    menuItems.slice(0, 5).forEach(function (item, index) {
      var label = getNodeLabel(item);
      var dataUrl = item.getAttribute("data-download-url") || "";
      var onclick = item.getAttribute("onclick") || "";
      var jsaction = item.getAttribute("jsaction") || "";
      var dataAction = item.getAttribute("data-action") || "";
      var dataValue = item.getAttribute("data-value") || "";
      var dataLabel = item.getAttribute("data-label") || "";
      var dataTooltip = item.getAttribute("data-tooltip") || item.getAttribute("data-tooltip-text") || "";
      // Log outerHTML for debugging Google's structure
      var outerSnippet = (item.outerHTML || "").slice(0, 300);
      console.log(
        "[FiBuKI] Menu item",
        index + 1,
        "label:",
        label.slice(0, 50),
        "jsaction:",
        jsaction.slice(0, 100),
        "html:",
        outerSnippet
      );
    });
    var clicked = 0;
    menuItems.forEach(function (item) {
      if (clicked >= 2) return;

      // SKIP header download icons - these download CSVs!
      if (item.classList.contains('b3id-card-header-image-container')) return;
      if (item.classList.contains('b3id-image-with-caption')) return;
      if (item.querySelector('svg') && item.getAttribute('aria-label') === 'Download') return;

      var label = getNodeLabel(item);
      var dataUrl = item.getAttribute("data-download-url") || "";
      var title = item.getAttribute("title") || "";
      var onclick = item.getAttribute("onclick") || "";
      var jsaction = item.getAttribute("jsaction") || "";
      var dataAction = item.getAttribute("data-action") || "";
      var dataValue = item.getAttribute("data-value") || "";
      var dataLabel = item.getAttribute("data-label") || "";
      var dataTooltip = item.getAttribute("data-tooltip") || item.getAttribute("data-tooltip-text") || "";
      if (
        !label &&
        !dataLabel &&
        !dataTooltip &&
        !dataUrl &&
        !title &&
        !onclick &&
        !jsaction &&
        !dataAction &&
        !dataValue
      ) {
        return;
      }
      if (
        !isDownloadMenuItem(
          label,
          dataLabel,
          dataTooltip,
          title,
          dataUrl,
          onclick,
          jsaction,
          dataAction,
          dataValue,
          item.className || ""
        )
      ) {
        return;
      }
      if (item.getAttribute("data-ts-clicked") === "true") return;
      try {
        dispatchMouseSequence(item);
        item.setAttribute("data-ts-clicked", "true");
        clicked += 1;
        console.log("[FiBuKI] Clicked menu item:", label || dataLabel || dataAction || dataValue || "menuitem");
      } catch (err) {
        // ignore
      }
    });
    if (clicked === 0 && menuItems.length) {
      var recentMenu = Date.now() - lastMenuOpenedAt < 4000;
      var smallMenu = menuItems.length <= 4;
      if (recentMenu && smallMenu && lastMenuContext === "pdf") {
        try {
          menuItems.slice(0, 2).forEach(function (item) {
            dispatchMouseSequence(item);
            item.setAttribute("data-ts-clicked", "true");
          });
          console.log("[FiBuKI] Clicked menu items fallback (pdf) with dispatchMouseSequence");
        } catch (err) {
          console.log("[FiBuKI] Fallback (pdf) error:", err.message);
        }
      } else {
        try {
          dispatchMouseSequence(menuItems[0]);
          menuItems[0].setAttribute("data-ts-clicked", "true");
          console.log("[FiBuKI] Clicked first menu item fallback with dispatchMouseSequence");
        } catch (err) {
          console.log("[FiBuKI] Fallback error:", err.message);
        }
      }
      console.log("[FiBuKI] Menu items found but no download match.");
      setOverlayStatus("Menu open, no PDF action detected.");
    }
    if (clicked === 0 && lastMenuContext === "pdf") {
      if (menuItems.length === 1 && menuItems[0]) {
        try {
          dispatchMouseSequence(menuItems[0]);
          menuItems[0].setAttribute("data-ts-clicked", "true");
          console.log("[FiBuKI] Clicked single menu item fallback");
          clicked += 1;
        } catch (err) {
          // ignore
        }
      }
      var fallbackClicked = clickNearMenuAnchor();
      if (fallbackClicked) {
        clicked += 1;
      }
      if (clicked === 0) {
        keyboardMenuSelect();
      }
    }
    return clicked;
  }

  function startMenuObserver() {
    if (menuObserver) return;
    menuObserver = new MutationObserver(function (mutations) {
      var foundMenu = false;
      mutations.forEach(function (mutation) {
        Array.prototype.slice.call(mutation.addedNodes || []).forEach(function (node) {
          if (!node || node.nodeType !== 1) return;
          if (node.matches && node.matches("[role='menu'], .goog-menu, .jfk-menu")) {
            foundMenu = true;
          } else if (
            node.querySelector &&
            node.querySelector("[role='menu'], .goog-menu, .jfk-menu")
          ) {
            foundMenu = true;
          }
        });
      });
      if (foundMenu) {
        scanAndClickMenuItems();
      }
    });
    try {
      menuObserver.observe(document.body, { childList: true, subtree: true });
      setTimeout(function () {
        if (menuObserver) {
          menuObserver.disconnect();
          menuObserver = null;
        }
      }, 6000);
    } catch (err) {
      menuObserver = null;
    }
  }

  function chooseMenuContainer(menuContainers) {
    if (!menuContainers.length) return null;
    var now = Date.now();
    if (!lastMenuAnchor || now - lastMenuAnchor.time > 8000) return null;
    var closest = null;
    var closestDist = Infinity;
    menuContainers.forEach(function (menu) {
      var rect = menu.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      var centerX = rect.left + rect.width / 2;
      var centerY = rect.top + rect.height / 2;
      var dx = centerX - lastMenuAnchor.x;
      var dy = centerY - lastMenuAnchor.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closest = menu;
      }
    });
    if (closest && closestDist < 400) {
      return closest;
    }
    return null;
  }

  function clickNearMenuAnchor() {
    if (!lastMenuAnchor) return false;
    var now = Date.now();
    if (now - lastMenuAnchor.time > 6000) return false;
    var offsets = [
      { x: 0, y: 48 },
      { x: 0, y: 72 },
      { x: 0, y: 96 },
      { x: 12, y: 60 },
      { x: -12, y: 60 },
    ];
    for (var i = 0; i < offsets.length; i += 1) {
      var pointX = lastMenuAnchor.x + offsets[i].x;
      var pointY = lastMenuAnchor.y + offsets[i].y;
      var candidate = document.elementFromPoint(pointX, pointY);
      if (!candidate) continue;
      var clickable = findClickableCandidate(candidate);
      if (clickable) {
        try {
          clickable.click();
          clickable.setAttribute("data-ts-clicked", "true");
          console.log("[FiBuKI] Clicked near-menu fallback:", clickable.className || clickable.tagName);
          return true;
        } catch (err) {
          // ignore
        }
      }
    }
    return false;
  }

  function isInCardHeader(node) {
    var current = node;
    var steps = 0;
    while (current && steps < 6) {
      if (current.classList && current.classList.contains("b3-card-header-image-container")) {
        return true;
      }
      if (current.classList && current.classList.contains("b3-card-header")) {
        return true;
      }
      current = current.parentElement;
      steps += 1;
    }
    return false;
  }

  function keyboardMenuSelect() {
    if (!lastMenuButton) return;
    try {
      lastMenuButton.focus();
      var down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
      var enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      lastMenuButton.dispatchEvent(down);
      lastMenuButton.dispatchEvent(enter);
      console.log("[FiBuKI] Keyboard menu fallback sent");
    } catch (err) {
      // ignore
    }
  }

  function dispatchMouseSequence(node) {
    try {
      var rect = node.getBoundingClientRect();
      var centerX = rect.left + rect.width / 2;
      var centerY = rect.top + rect.height / 2;
      var eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: centerX,
        clientY: centerY,
        screenX: centerX,
        screenY: centerY,
      };
      // PointerEvents for modern Google frameworks
      if (typeof PointerEvent !== "undefined") {
        ["pointerdown", "pointerup"].forEach(function (type) {
          var evt = new PointerEvent(type, Object.assign({}, eventInit, {
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          }));
          node.dispatchEvent(evt);
        });
      }
      // MouseEvents
      ["mousedown", "mouseup", "click"].forEach(function (type) {
        var evt = new MouseEvent(type, eventInit);
        node.dispatchEvent(evt);
      });
      // Also try native click
      node.click();
    } catch (err) {
      console.log("[FiBuKI] dispatchMouseSequence error:", err.message);
    }
  }

  function findClickableCandidate(node) {
    var current = node;
    var steps = 0;
    while (current && steps < 5) {
      if (current.nodeType !== 1) return null;
      var className = current.className || "";
      var jsaction = current.getAttribute ? current.getAttribute("jsaction") || "" : "";
      var role = current.getAttribute ? current.getAttribute("role") || "" : "";
      if (
        /menuitem/i.test(role) ||
        /menuitem|menu|popup|download/i.test(className) ||
        /download|pdf|invoice|doc=/.test(jsaction.toLowerCase())
      ) {
        return current;
      }
      current = current.parentElement;
      steps += 1;
    }
    return null;
  }

  function getNodeLabel(node) {
    var text = (node.innerText || node.textContent || "").trim();
    if (text) return text;
    var attrs = [
      "aria-label",
      "data-label",
      "data-tooltip",
      "data-tooltip-text",
      "title",
      "data-name",
      "data-value",
    ];
    for (var i = 0; i < attrs.length; i += 1) {
      var value = node.getAttribute(attrs[i]);
      if (value && value.trim()) return value.trim();
    }
    var child = node.querySelector(
      "[aria-label], [data-label], [data-tooltip], [data-tooltip-text], [title]"
    );
    if (child) {
      var childText = (child.getAttribute("aria-label") ||
        child.getAttribute("data-label") ||
        child.getAttribute("data-tooltip") ||
        child.getAttribute("data-tooltip-text") ||
        child.getAttribute("title") ||
        "").trim();
      if (childText) return childText;
    }
    return "";
  }

  function isDownloadMenuItem(
    label,
    dataLabel,
    dataTooltip,
    title,
    dataUrl,
    onclick,
    jsaction,
    dataAction,
    dataValue,
    className
  ) {
    var combined = (label + " " + dataLabel + " " + dataTooltip + " " + title).toLowerCase();

    // SKIP CSV/activity files - we only want PDFs
    if (/csv|account.*activit|activity.*report/i.test(combined)) {
      return false;
    }

    // SKIP header download icons (these download CSVs!)
    var classStr = (typeof className === 'string') ? className : (className ? String(className) : '');
    if (/b3id-card-header|b3id-image-with-caption/i.test(classStr)) {
      return false;
    }

    if (dataUrl) {
      // Only accept data URLs that look like PDFs, not CSVs
      if (/\.csv|account.*activit/i.test(dataUrl)) return false;
      return true;
    }
    // Match PDF or Download specifically, not just "invoice"
    if (/pdf|download/i.test(combined)) return true;
    // Only match "invoice" if it's likely a PDF invoice (has PDF nearby or number pattern)
    if (/invoice/i.test(combined) && (/pdf|\d{5,}/i.test(combined))) return true;
    if (onclick && /doc=|download|pdf/.test(onclick.toLowerCase())) return true;
    if (jsaction && /doc=|download|pdf/.test(jsaction.toLowerCase())) return true;
    if (dataAction && /download|pdf/.test(dataAction.toLowerCase())) return true;
    if (dataValue && /download|pdf/.test(dataValue.toLowerCase())) return true;
    if (classStr && /download|pdf/.test(classStr.toLowerCase())) return true;
    return false;
  }

  function waitForInvoiceButtons(callback) {
    if (pausedForLogin) return;
    var resolved = false;
    var timeoutId = null;
    var observer = null;

    function checkNow() {
      if (pausedForLogin) return;
      var nodes = Array.prototype.slice.call(
        document.querySelectorAll("a, button, [role='button']")
      );
      var matches = nodes.filter(function (el) {
        var text = (el.textContent || "").trim().toLowerCase();
        if (!text) return false;
        if (el.hasAttribute("disabled")) return false;
        if (!el.offsetParent && el.getBoundingClientRect().width === 0) return false;
        // Skip CSV/activity buttons
        if (/csv|account.*activit/i.test(text)) return false;
        return /pdf|rechnung|download/i.test(text) || (/invoice/i.test(text) && /pdf|\d{5,}/i.test(text));
      });
      if (matches.length) {
        setOverlayStatus("Invoice buttons ready: " + matches.length);
        return true;
      }
      return false;
    }

    function done() {
      if (resolved) return;
      resolved = true;
      if (observer) observer.disconnect();
      if (timeoutId) window.clearTimeout(timeoutId);
      callback();
    }

    if (checkNow()) {
      done();
      return;
    }

    observer = new MutationObserver(function () {
      if (checkNow()) {
        done();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    timeoutId = window.setTimeout(function () {
      setOverlayStatus("Timed out waiting for buttons.");
      done();
    }, 5000);
  }

  function guessLabel(url) {
    try {
      var parsed = new URL(url);
      var last = parsed.pathname.split("/").pop() || "Invoice";
      return last.length > 0 ? last : "Invoice";
    } catch (err) {
      return "Invoice";
    }
  }

  // ============================================================================
  // LEARN MODE — Record user navigation to teach invoice fetching
  // ============================================================================

  function buildUniqueSelector(el) {
    if (!el) return null;
    if (el.id) return "#" + el.id;
    var path = [];
    var current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      var tag = (current.tagName || "").toLowerCase();
      if (current.id) {
        path.unshift("#" + current.id);
        break;
      }
      var parent = current.parentElement;
      if (parent) {
        var siblings = parent.children;
        var index = 0;
        for (var i = 0; i < siblings.length; i++) {
          if (siblings[i] === current) { index = i + 1; break; }
        }
        path.unshift(tag + ":nth-child(" + index + ")");
      } else {
        path.unshift(tag);
      }
      current = parent;
    }
    return path.join(" > ") || null;
  }

  function buildClickTarget(el) {
    if (!el) return null;
    var text = (el.textContent || "").trim().slice(0, 120);
    var tagName = (el.tagName || "").toLowerCase();
    var ariaLabel = el.getAttribute("aria-label") || undefined;
    var href = el.getAttribute("href") || undefined;

    // Build CSS selector (brittle fallback)
    var selector = tagName;
    if (el.id) {
      selector = "#" + el.id;
    } else if (el.className && typeof el.className === "string") {
      var classes = el.className.trim().split(/\s+/).slice(0, 3).join(".");
      if (classes) selector = tagName + "." + classes;
    }

    // Get context: nearest heading or section text
    var contextText = "";
    var parent = el.parentElement;
    for (var i = 0; i < 5 && parent; i++) {
      var heading = parent.querySelector("h1, h2, h3, h4, [role='heading']");
      if (heading) {
        contextText = (heading.textContent || "").trim().slice(0, 80);
        break;
      }
      parent = parent.parentElement;
    }

    return {
      text: text,
      tagName: tagName,
      ariaLabel: ariaLabel,
      href: href,
      selector: selector,
      contextText: contextText || undefined,
    };
  }

  /**
   * Capture the current page HTML with inlined styles for PDF conversion.
   * Removes extension UI elements and inlines accessible CSSOM stylesheets.
   */
  function capturePageHtml() {
    var clone = document.documentElement.cloneNode(true);

    // Remove extension UI elements
    var removeIds = [
      LEARN_OVERLAY_ID,
      LEARN_OVERLAY_ID + "-border",
      LEARN_OVERLAY_ID + "-glow",
      OVERLAY_ID,
      OVERLAY_ID + "-border",
      OVERLAY_ID + "-glow",
    ];
    removeIds.forEach(function (id) {
      var el = clone.querySelector("#" + id);
      if (el) el.remove();
    });
    // Remove injected style tags
    var tsStyles = clone.querySelectorAll(
      "[id^='ts-learn-'], [id^='taxstudio-']"
    );
    tsStyles.forEach(function (el) {
      el.remove();
    });

    // Inline all accessible stylesheets from CSSOM
    var head = clone.querySelector("head");
    if (!head) {
      head = document.createElement("head");
      clone.insertBefore(head, clone.firstChild);
    }
    var inlinedIndices = [];
    for (var i = 0; i < document.styleSheets.length; i++) {
      try {
        var sheet = document.styleSheets[i];
        var rules = sheet.cssRules || sheet.rules;
        if (!rules) continue;
        var css = "";
        for (var j = 0; j < rules.length; j++) {
          css += rules[j].cssText + "\n";
        }
        var style = document.createElement("style");
        style.textContent = css;
        head.appendChild(style);
        inlinedIndices.push(i);
      } catch (e) {
        // Cross-origin stylesheet — keep as <link>
      }
    }

    // Remove original <link rel="stylesheet"> that were successfully inlined
    var links = clone.querySelectorAll('link[rel="stylesheet"]');
    for (var k = 0; k < links.length; k++) {
      if (inlinedIndices.indexOf(k) !== -1) {
        links[k].remove();
      }
    }

    // Add <base> tag for relative URLs (images, etc.)
    var base = document.createElement("base");
    base.href = window.location.origin;
    head.insertBefore(base, head.firstChild);

    // Undo padding we added for the learn overlay border
    var htmlEl = clone;
    htmlEl.style.removeProperty("padding");
    htmlEl.style.removeProperty("box-sizing");
    var body = clone.querySelector("body");
    if (body) {
      body.style.removeProperty("padding");
      body.style.removeProperty("box-sizing");
      body.style.removeProperty("margin");
    }

    return "<!DOCTYPE html>" + clone.outerHTML;
  }

  /**
   * Capture the current page as PDF via the background script and upload it.
   * Calls back with true on success, false on failure.
   */
  function captureAndUploadPageAsPdf(callback) {
    var html = capturePageHtml();
    chrome.runtime.sendMessage(
      {
        type: "TS_CAPTURE_PAGE_AS_PDF",
        html: html,
        pageUrl: window.location.href,
        pageTitle: document.title,
        runId: learnRunId || replayRunId || currentRunId,
      },
      function (response) {
        if (response && response.ok) {
          learnPdfCount++;
          updateLearnOverlayStatus();
          if (callback) callback(true);
        } else {
          if (callback) callback(false);
        }
      }
    );
  }

  function recordLearnAction(actionType, extra) {
    if (!learnMode) return;
    var action = {
      step: learnActions.length + 1,
      actionType: actionType,
      url: window.location.href,
      relativeTimeMs: Date.now() - learnSessionStart,
    };
    if (extra) {
      for (var key in extra) {
        if (extra.hasOwnProperty(key)) {
          action[key] = extra[key];
        }
      }
    }
    learnActions.push(action);

    // Send to app tab in real-time
    chrome.runtime.sendMessage({
      type: "TS_LEARN_ACTION",
      action: action,
    });

    updateLearnOverlayStatus();
  }

  function ensureLearnOverlay() {
    if (document.getElementById(LEARN_OVERLAY_ID)) return;

    // Save original styles so we can restore later
    if (!window.__tsOriginalPadding) {
      window.__tsOriginalPadding = document.documentElement.style.padding || "";
      window.__tsOriginalBoxSizing = document.documentElement.style.boxSizing || "";
      window.__tsOriginalBodyPadding = document.body.style.padding || "";
      window.__tsOriginalBodyBoxSizing = document.body.style.boxSizing || "";
      window.__tsOriginalBodyMargin = document.body.style.margin || "";
    }
    // Push page content inward so it's not hidden behind the 16px border
    document.documentElement.style.setProperty('padding', '16px', 'important');
    document.documentElement.style.setProperty('box-sizing', 'border-box', 'important');
    document.body.style.setProperty('padding', '16px', 'important');
    document.body.style.setProperty('box-sizing', 'border-box', 'important');
    document.body.style.setProperty('margin', '0', 'important');

    // Reuse the same rainbow gradient border as pull mode
    var styleId = "ts-learn-overlay-styles";
    if (!document.getElementById(styleId)) {
      var style = document.createElement("style");
      style.id = styleId;
      style.textContent =
        "@keyframes ts-learn-gradient { " +
          "0% { background-position: 0% 50%; } " +
          "50% { background-position: 100% 50%; } " +
          "100% { background-position: 0% 50%; } " +
        "} " +
        "@keyframes ts-learn-hue-shift { " +
          "0% { filter: hue-rotate(0deg); } " +
          "100% { filter: hue-rotate(360deg); } " +
        "} " +
        "@keyframes ts-learn-glow-breathe { " +
          "0%, 100% { opacity: 0.35; filter: blur(12px) hue-rotate(0deg); } " +
          "50% { opacity: 0.6; filter: blur(16px) hue-rotate(180deg); } " +
        "} " +
        "@keyframes ts-learn-pulse { " +
          "0%, 100% { opacity: 0.8; } " +
          "50% { opacity: 1; } " +
        "} " +
        "#" + LEARN_OVERLAY_ID + "-glow { " +
          "position: fixed !important; " +
          "inset: -20px !important; " +
          "background: linear-gradient(90deg, #10b981, #06b6d4, #8b5cf6, #ec4899, #f59e0b, #10b981) !important; " +
          "background-size: 300% 300% !important; " +
          "animation: ts-learn-gradient 3s ease infinite, ts-learn-glow-breathe 6s ease-in-out infinite !important; " +
          "pointer-events: none !important; " +
          "z-index: 2147483645 !important; " +
          "-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "-webkit-mask-composite: xor !important; " +
          "mask-composite: exclude !important; " +
          "padding: 24px !important; " +
          "transition: transform 0.8s ease-out !important; " +
        "} " +
        "#" + LEARN_OVERLAY_ID + "-border { " +
          "position: fixed !important; " +
          "inset: 0 !important; " +
          "background: linear-gradient(90deg, #10b981, #06b6d4, #8b5cf6, #ec4899, #f59e0b, #10b981) !important; " +
          "background-size: 300% 300% !important; " +
          "animation: ts-learn-gradient 3s ease infinite, ts-learn-hue-shift 12s linear infinite !important; " +
          "pointer-events: none !important; " +
          "z-index: 2147483646 !important; " +
          "-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "-webkit-mask-composite: xor !important; " +
          "mask-composite: exclude !important; " +
          "padding: 16px !important; " +
          "transition: transform 0.8s ease-out !important; " +
        "}";
      (document.head || document.documentElement).appendChild(style);
    }

    // Glow layer (behind border, with breathing)
    var glowEl = document.createElement("div");
    glowEl.id = LEARN_OVERLAY_ID + "-glow";
    document.body.appendChild(glowEl);

    // Animated gradient border
    var borderEl = document.createElement("div");
    borderEl.id = LEARN_OVERLAY_ID + "-border";
    document.body.appendChild(borderEl);

    // Subtle organic drift (same as pull mode)
    var moveX = 0, moveY = 0, targetX = 0, targetY = 0;
    setInterval(function () {
      targetX = (Math.random() - 0.5) * 3;
      targetY = (Math.random() - 0.5) * 3;
    }, 2000);
    function animateMove() {
      moveX += (targetX - moveX) * 0.02;
      moveY += (targetY - moveY) * 0.02;
      var transform = "translate(" + moveX + "px, " + moveY + "px)";
      var b = document.getElementById(LEARN_OVERLAY_ID + "-border");
      var g = document.getElementById(LEARN_OVERLAY_ID + "-glow");
      if (b) b.style.transform = transform;
      if (g) g.style.transform = transform;
      if (b || g) requestAnimationFrame(animateMove);
    }
    animateMove();

    // Panel
    var panel = document.createElement("div");
    panel.id = LEARN_OVERLAY_ID;
    panel.style.position = "fixed";
    panel.style.right = "12px";
    panel.style.bottom = "12px";
    panel.style.width = "340px";
    panel.style.maxHeight = "50vh";
    panel.style.overflow = "auto";
    panel.style.borderRadius = "14px";
    panel.style.background = "rgba(30, 20, 0, 0.94)";
    panel.style.backdropFilter = "blur(8px)";
    panel.style.color = "#fef3c7";
    panel.style.font = "500 12px/1.4 'Inter', sans-serif";
    panel.style.boxShadow = "0 12px 30px rgba(30, 20, 0, 0.5)";
    panel.style.zIndex = "2147483647";

    // Header
    var header = document.createElement("div");
    header.style.padding = "12px 14px";
    header.style.borderBottom = "1px solid rgba(245, 158, 11, 0.3)";
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";

    var titleCol = document.createElement("div");

    var title = document.createElement("div");
    title.style.fontWeight = "700";
    title.style.fontSize = "13px";
    title.style.color = "#fbbf24";
    title.style.animation = "ts-learn-pulse 2s ease-in-out infinite";
    title.textContent = "FiBuKI Learn Mode";

    var subtitle = document.createElement("div");
    subtitle.style.fontSize = "10px";
    subtitle.style.opacity = "0.7";
    subtitle.style.marginTop = "2px";
    subtitle.textContent = learnPartnerName || "Recording...";

    titleCol.appendChild(title);
    titleCol.appendChild(subtitle);

    // Rec dot
    var recDot = document.createElement("span");
    recDot.style.width = "8px";
    recDot.style.height = "8px";
    recDot.style.borderRadius = "50%";
    recDot.style.background = "#ef4444";
    recDot.style.animation = "ts-learn-pulse 1s ease-in-out infinite";
    recDot.style.marginRight = "6px";
    recDot.style.display = "inline-block";

    var recLabel = document.createElement("span");
    recLabel.style.fontSize = "10px";
    recLabel.style.color = "#fca5a5";
    recLabel.textContent = "REC";

    var recWrap = document.createElement("div");
    recWrap.style.display = "flex";
    recWrap.style.alignItems = "center";
    recWrap.appendChild(recDot);
    recWrap.appendChild(recLabel);

    header.appendChild(titleCol);
    header.appendChild(recWrap);

    // Status area
    var statusArea = document.createElement("div");
    statusArea.id = LEARN_OVERLAY_ID + "-status";
    statusArea.style.padding = "10px 14px";
    statusArea.style.fontSize = "11px";
    statusArea.style.color = "#fde68a";
    statusArea.textContent = "Navigate to the invoice page. Click buttons as you normally would.";

    // Breadcrumbs
    var breadcrumbs = document.createElement("div");
    breadcrumbs.id = LEARN_OVERLAY_ID + "-breadcrumbs";
    breadcrumbs.style.padding = "0 14px 8px";
    breadcrumbs.style.fontSize = "10px";
    breadcrumbs.style.color = "rgba(254, 243, 199, 0.6)";

    // Counter + buttons row
    var footer = document.createElement("div");
    footer.style.padding = "10px 14px";
    footer.style.borderTop = "1px solid rgba(245, 158, 11, 0.2)";
    footer.style.display = "flex";
    footer.style.gap = "8px";
    footer.style.alignItems = "center";
    footer.style.justifyContent = "space-between";

    var counterEl = document.createElement("span");
    counterEl.id = LEARN_OVERLAY_ID + "-counter";
    counterEl.style.fontSize = "11px";
    counterEl.style.opacity = "0.7";
    counterEl.textContent = "0 steps · 0 files";

    var btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "6px";

    // "Mark invoice list" button
    var markBtn = document.createElement("button");
    markBtn.textContent = "Mark invoice list";
    markBtn.style.padding = "5px 12px";
    markBtn.style.borderRadius = "6px";
    markBtn.style.border = "1px solid rgba(245, 158, 11, 0.4)";
    markBtn.style.background = "rgba(245, 158, 11, 0.15)";
    markBtn.style.color = "#fbbf24";
    markBtn.style.font = "600 11px/1 sans-serif";
    markBtn.style.cursor = "pointer";
    markBtn.addEventListener("click", function () {
      // Capture the invoice list URL
      learnInvoiceListUrl = window.location.href;

      // Extract structured list data from the page
      var invoiceRows = [];
      var containerSelector = null;
      if (window.__tsReplayEngine) {
        var rows = window.__tsReplayEngine.extractInvoiceLikeRows();
        if (rows && rows.length > 0) {
          invoiceRows = rows.map(function (r) {
            return { text: r.description || "", date: r.date || undefined, amount: r.amount || undefined };
          });
        }
        var tableData = window.__tsReplayEngine.parseInvoiceTable(null);
        if (tableData && tableData.tableElement) {
          containerSelector = buildUniqueSelector(tableData.tableElement);
        }
      }

      // Determine selectionType from data
      var hasDates = invoiceRows.some(function (r) { return r.date; });
      var hasAmounts = invoiceRows.some(function (r) { return r.amount; });
      var selectionType = "month";
      if (hasAmounts && hasDates) selectionType = "amount_and_date";
      else if (hasAmounts) selectionType = "amount";
      else if (hasDates) selectionType = "exact_date";

      recordLearnAction("mark_invoice_page", {
        pageContext: {
          title: document.title,
          surroundingText: (document.body.innerText || "").slice(0, 500),
        },
        invoiceListSnapshot: {
          items: invoiceRows.slice(0, 10),
          containerSelector: containerSelector,
          selectionType: selectionType,
        },
      });

      learnExpectingInvoiceSelect = true;

      // Update status text
      var status = document.getElementById(LEARN_OVERLAY_ID + "-status");
      if (status) {
        status.textContent = "Now click one invoice and download it.";
        status.style.color = "#67e8f9";
      }

      // Disable the button
      markBtn.textContent = "Marked!";
      markBtn.style.background = "rgba(34, 197, 94, 0.2)";
      markBtn.style.color = "#86efac";
      markBtn.disabled = true;
      markBtn.style.cursor = "default";
      markBtn.style.opacity = "0.6";
    });

    // "Done" button
    var doneBtn = document.createElement("button");
    doneBtn.textContent = "Done";
    doneBtn.style.padding = "5px 16px";
    doneBtn.style.borderRadius = "6px";
    doneBtn.style.border = "none";
    doneBtn.style.background = "linear-gradient(135deg, #f59e0b, #ef4444)";
    doneBtn.style.color = "#fff";
    doneBtn.style.font = "700 11px/1 sans-serif";
    doneBtn.style.cursor = "pointer";
    doneBtn.addEventListener("click", function () {
      if (learnPdfCount > 0) {
        finishLearnMode();
        return;
      }
      // No file was captured — show checkpoint prompt
      showNoFileCheckpoint(doneBtn);
    });

    btnRow.appendChild(markBtn);
    btnRow.appendChild(doneBtn);
    footer.appendChild(counterEl);
    footer.appendChild(btnRow);

    panel.appendChild(header);
    panel.appendChild(statusArea);
    panel.appendChild(breadcrumbs);
    panel.appendChild(footer);
    document.body.appendChild(panel);

    // Make panel draggable by header, snaps to nearest corner
    if (window.__tsReplayEngine && window.__tsReplayEngine.makeDraggable) {
      window.__tsReplayEngine.makeDraggable(panel, header);
    }
  }

  function updateLearnOverlayStatus() {
    var counter = document.getElementById(LEARN_OVERLAY_ID + "-counter");
    if (counter) {
      counter.textContent = learnActions.length + " steps · " + learnPdfCount + " files";
    }

    // Update breadcrumbs
    var bc = document.getElementById(LEARN_OVERLAY_ID + "-breadcrumbs");
    if (bc) {
      var visited = [];
      for (var i = 0; i < learnActions.length; i++) {
        var action = learnActions[i];
        if (action.actionType === "navigate" && action.targetUrl) {
          try {
            visited.push(new URL(action.targetUrl).pathname);
          } catch (e) {
            visited.push(action.targetUrl);
          }
        }
      }
      // Deduplicate
      var unique = [];
      for (var j = 0; j < visited.length; j++) {
        if (unique.indexOf(visited[j]) === -1) unique.push(visited[j]);
      }
      bc.textContent = unique.length > 0 ? unique.join(" → ") : "";
    }
  }

  function removeLearnOverlay() {
    var el = document.getElementById(LEARN_OVERLAY_ID);
    if (el) el.remove();
    var border = document.getElementById(LEARN_OVERLAY_ID + "-border");
    if (border) border.remove();
    var glow = document.getElementById(LEARN_OVERLAY_ID + "-glow");
    if (glow) glow.remove();
    var style = document.getElementById("ts-learn-overlay-styles");
    if (style) style.remove();

    // Restore original padding on documentElement and body
    if (window.__tsOriginalPadding !== undefined) {
      if (window.__tsOriginalPadding) {
        document.documentElement.style.padding = window.__tsOriginalPadding;
      } else {
        document.documentElement.style.removeProperty('padding');
      }
      if (window.__tsOriginalBoxSizing) {
        document.documentElement.style.boxSizing = window.__tsOriginalBoxSizing;
      } else {
        document.documentElement.style.removeProperty('box-sizing');
      }
      if (window.__tsOriginalBodyPadding) {
        document.body.style.padding = window.__tsOriginalBodyPadding;
      } else {
        document.body.style.removeProperty('padding');
      }
      if (window.__tsOriginalBodyBoxSizing) {
        document.body.style.boxSizing = window.__tsOriginalBodyBoxSizing;
      } else {
        document.body.style.removeProperty('box-sizing');
      }
      if (window.__tsOriginalBodyMargin) {
        document.body.style.margin = window.__tsOriginalBodyMargin;
      } else {
        document.body.style.removeProperty('margin');
      }
      delete window.__tsOriginalPadding;
      delete window.__tsOriginalBoxSizing;
      delete window.__tsOriginalBodyPadding;
      delete window.__tsOriginalBodyBoxSizing;
      delete window.__tsOriginalBodyMargin;
    }
  }

  function startLearnListeners() {
    // Track clicks
    document.addEventListener("click", learnClickHandler, true);
    // Track navigations
    learnLastUrl = window.location.href;
    window.addEventListener("popstate", learnNavHandler);
    window.addEventListener("hashchange", learnNavHandler);
    // URL polling for SPA navigations
    learnUrlPollId = setInterval(function () {
      if (!learnMode) return;
      var currentUrl = window.location.href;
      if (currentUrl !== learnLastUrl) {
        recordLearnAction("navigate", {
          targetUrl: currentUrl,
          pageContext: { title: document.title, surroundingText: "" },
        });
        learnLastUrl = currentUrl;
      }
    }, 500);
  }

  var learnUrlPollId = null;

  function stopLearnListeners() {
    document.removeEventListener("click", learnClickHandler, true);
    window.removeEventListener("popstate", learnNavHandler);
    window.removeEventListener("hashchange", learnNavHandler);
    if (learnUrlPollId) {
      clearInterval(learnUrlPollId);
      learnUrlPollId = null;
    }
  }

  function learnClickHandler(event) {
    if (!learnMode) return;
    var target = event.target;
    if (!target) return;
    // Walk up to find the closest interactive element
    var el = target;
    for (var i = 0; i < 5 && el; i++) {
      var tag = (el.tagName || "").toLowerCase();
      if (tag === "a" || tag === "button" || tag === "input" ||
          tag === "select" || el.getAttribute("role") === "button" ||
          el.getAttribute("role") === "link" || el.onclick) {
        break;
      }
      el = el.parentElement;
    }
    if (!el) el = target;
    // Skip clicks on the learn overlay itself
    var overlayEl = document.getElementById(LEARN_OVERLAY_ID);
    if (overlayEl && overlayEl.contains(target)) return;

    var clickTarget = buildClickTarget(el);
    if (learnExpectingInvoiceSelect) {
      learnExpectingInvoiceSelect = false;
      recordLearnAction("selectInvoice", { clickTarget: clickTarget });
      // Update status
      var statusEl = document.getElementById(LEARN_OVERLAY_ID + "-status");
      if (statusEl) {
        statusEl.textContent = "Invoice selected! Continue to download, then click Done.";
        statusEl.style.color = "#86efac";
      }
    } else {
      recordLearnAction("click", { clickTarget: clickTarget });
    }
  }

  function learnNavHandler() {
    if (!learnMode) return;
    var currentUrl = window.location.href;
    if (currentUrl !== learnLastUrl) {
      recordLearnAction("navigate", {
        targetUrl: currentUrl,
        pageContext: { title: document.title, surroundingText: "" },
      });
      learnLastUrl = currentUrl;
    }
  }

  /**
   * Show a checkpoint prompt when the user clicks Done but no file was captured.
   * Offers "Save this page as PDF" or "Skip — no file needed".
   */
  function showNoFileCheckpoint(doneBtn) {
    var status = document.getElementById(LEARN_OVERLAY_ID + "-status");
    if (status) {
      status.textContent = "No file was downloaded. How should we get the invoice?";
      status.style.color = "#fbbf24";
    }

    // Replace the footer buttons with checkpoint options
    var footer = doneBtn.parentElement && doneBtn.parentElement.parentElement;
    if (!footer) {
      finishLearnMode();
      return;
    }
    var btnRow = doneBtn.parentElement;
    if (!btnRow) {
      finishLearnMode();
      return;
    }

    // Clear existing buttons
    btnRow.innerHTML = "";

    // "Save this page as PDF" button
    var saveBtn = document.createElement("button");
    saveBtn.textContent = "Save page as PDF";
    saveBtn.style.padding = "5px 14px";
    saveBtn.style.borderRadius = "6px";
    saveBtn.style.border = "none";
    saveBtn.style.background = "linear-gradient(135deg, #10b981, #06b6d4)";
    saveBtn.style.color = "#fff";
    saveBtn.style.font = "700 11px/1 sans-serif";
    saveBtn.style.cursor = "pointer";
    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true;
      saveBtn.textContent = "Converting...";
      saveBtn.style.opacity = "0.6";
      saveBtn.style.cursor = "default";

      captureAndUploadPageAsPdf(function (success) {
        if (success) {
          recordLearnAction("capture_page_as_pdf", {
            pageContext: {
              title: document.title,
              surroundingText: (document.body.innerText || "").slice(0, 500),
            },
          });
          if (status) {
            status.textContent = "Page captured as PDF!";
            status.style.color = "#86efac";
          }
          setTimeout(function () {
            finishLearnMode();
          }, 500);
        } else {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save page as PDF";
          saveBtn.style.opacity = "1";
          saveBtn.style.cursor = "pointer";
          if (status) {
            status.textContent = "Conversion failed. Try again or skip.";
            status.style.color = "#fca5a5";
          }
        }
      });
    });

    // "Skip" button
    var skipBtn = document.createElement("button");
    skipBtn.textContent = "Skip";
    skipBtn.style.padding = "5px 14px";
    skipBtn.style.borderRadius = "6px";
    skipBtn.style.border = "1px solid rgba(245, 158, 11, 0.4)";
    skipBtn.style.background = "rgba(245, 158, 11, 0.15)";
    skipBtn.style.color = "#fbbf24";
    skipBtn.style.font = "600 11px/1 sans-serif";
    skipBtn.style.cursor = "pointer";
    skipBtn.addEventListener("click", function () {
      finishLearnMode();
    });

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(skipBtn);
  }

  function finishLearnMode() {
    if (!learnMode) return;
    learnMode = false;
    stopLearnListeners();

    chrome.runtime.sendMessage({
      type: "TS_LEARN_COMPLETE",
      actions: learnActions,
      pdfCount: learnPdfCount,
      invoiceListUrl: learnInvoiceListUrl,
    });

    removeLearnOverlay();

    // Reset state
    learnActions = [];
    learnPdfCount = 0;
    learnPartnerName = "";
    learnTransactionId = null;
    learnRunId = null;
    learnSessionStart = 0;
    learnInvoiceListUrl = null;
    learnExpectingInvoiceSelect = false;
  }

  // Forward learn events from background to window (app tab receives these)
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message) return;
    if (message.type === "TS_LEARN_STARTED") {
      window.postMessage({
        type: "TAXSTUDIO_LEARN_STARTED",
        runId: message.runId,
        partnerId: message.partnerId,
      }, "*");
    }
    if (message.type === "TS_LEARN_ACTION") {
      window.postMessage({
        type: "TAXSTUDIO_LEARN_ACTION",
        runId: message.runId,
        action: message.action,
      }, "*");
    }
    if (message.type === "TS_LEARN_PDF") {
      window.postMessage({
        type: "TAXSTUDIO_LEARN_PDF",
        runId: message.runId,
        sourceUrl: message.sourceUrl,
      }, "*");
    }
    if (message.type === "TS_LEARN_COMPLETE") {
      window.postMessage({
        type: "TAXSTUDIO_LEARN_COMPLETE",
        runId: message.runId,
        partnerId: message.partnerId,
        transactionId: message.transactionId,
        actions: message.actions,
        pdfCount: message.pdfCount,
        tabClosed: message.tabClosed || false,
        invoiceListUrl: message.invoiceListUrl || null,
      }, "*");
    }
  });

  // Handle TS_START_LEARN_TAB from background (in the opened target tab)
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_START_LEARN_TAB") return;
    if (learnMode) return; // Already in learn mode

    // Clean up any active pull mode state to prevent overlay conflicts
    if (currentRunId) {
      currentRunId = null;
      stopLoginCheck();
      pausedForLogin = false;
    }
    removePullOverlay();

    console.log("[FiBuKI] Starting learn mode in tab:", message.partnerName, "runId:", message.runId);
    learnMode = true;
    learnRunId = message.runId || null;
    learnSessionStart = Date.now();
    learnPartnerName = message.partnerName || "";
    learnTransactionId = message.transactionId || null;
    learnActions = [];
    learnPdfCount = 0;
    learnInvoiceListUrl = null;
    learnExpectingInvoiceSelect = false;
    learnLastUrl = window.location.href;
    if (isTopFrame) {
      ensureLearnOverlay();
    }
    startLearnListeners();
    // Record the initial navigation
    recordLearnAction("navigate", {
      targetUrl: window.location.href,
      pageContext: { title: document.title, surroundingText: "" },
    });
  });

  // Handle PDF detected during learn mode
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_LEARN_PDF_DETECTED") return;
    if (!learnMode) return;
    learnPdfCount++;
    recordLearnAction("pdf_detected", {
      pageContext: { title: document.title, surroundingText: "" },
    });
    updateLearnOverlayStatus();
    var status = document.getElementById(LEARN_OVERLAY_ID + "-status");
    if (status) {
      status.textContent = "PDF detected and uploaded! (" + learnPdfCount + " file" + (learnPdfCount > 1 ? "s" : "") + ")";
      status.style.color = "#86efac";
    }
  });

  // ============================================================================
  // REPLAY MODE — Automated invoice download using recorded recipes
  // ============================================================================

  var replayMode = false;
  var replayStateMachine = null;
  var replayRunId = null;

  // Forward replay events from background to window (app tab receives these)
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message) return;
    if (message.type === "TS_REPLAY_STARTED") {
      window.postMessage({
        type: "TAXSTUDIO_REPLAY_STARTED",
        runId: message.runId,
        partnerId: message.partnerId,
      }, "*");
    }
    if (message.type === "TS_REPLAY_PROGRESS") {
      window.postMessage({
        type: "TAXSTUDIO_REPLAY_PROGRESS",
        runId: message.runId,
        step: message.step,
        total: message.total,
        message: message.message,
      }, "*");
    }
    if (message.type === "TS_REPLAY_SUCCESS") {
      window.postMessage({
        type: "TAXSTUDIO_REPLAY_SUCCESS",
        runId: message.runId,
        result: message.result,
      }, "*");
    }
    if (message.type === "TS_REPLAY_FAILED") {
      // Stop the replay state machine if it's running in this tab
      if (replayMode && replayStateMachine) {
        replayStateMachine.cancel();
        replayMode = false;
        replayStateMachine = null;
        if (isTopFrame && window.__tsReplayEngine) {
          window.__tsReplayEngine.updateReplayOverlay(0, 0, "Replay failed: " + ((message.result && message.result.status) || "timeout"));
          setTimeout(function () { window.__tsReplayEngine.removeReplayOverlay(); }, 5000);
        }
      }
      window.postMessage({
        type: "TAXSTUDIO_REPLAY_FAILED",
        runId: message.runId,
        result: message.result,
      }, "*");
    }
    if (message.type === "TS_REPLAY_AUTH_REQUIRED") {
      window.postMessage({
        type: "TAXSTUDIO_REPLAY_AUTH_REQUIRED",
        runId: message.runId,
      }, "*");
    }
    if (message.type === "TS_REPLAY_PDF_DOWNLOADED") {
      window.postMessage({
        type: "TAXSTUDIO_REPLAY_PDF_DOWNLOADED",
        runId: message.runId,
        sourceUrl: message.sourceUrl,
      }, "*");
    }
    if (message.type === "TS_REPLAY_TIER2_NEEDED") {
      window.postMessage({
        type: "TAXSTUDIO_REPLAY_TIER2_NEEDED",
        runId: message.runId,
        failedAtStep: message.failedAtStep,
        snapshot: message.snapshot,
        transactionId: message.transactionId,
        transactionAmount: message.transactionAmount,
        transactionDate: message.transactionDate,
        transactionCurrency: message.transactionCurrency,
        partnerName: message.partnerName,
        recipe: message.recipe,
      }, "*");
    }
  });

  // Handle TS_START_REPLAY_TAB from background (in the opened target tab)
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_START_REPLAY_TAB") return;
    if (replayMode) return; // Already in replay mode
    if (!window.__tsReplayEngine) {
      console.warn("[FiBuKI] Replay engine not loaded");
      return;
    }

    // Clean up any active pull mode state to prevent overlay conflicts
    if (currentRunId) {
      currentRunId = null;
      stopLoginCheck();
      pausedForLogin = false;
    }
    removePullOverlay();

    var resumeFromStep = message.resumeFromStep || 0;
    console.log("[FiBuKI] Starting replay mode in tab:", message.partnerName, "resumeFromStep:", resumeFromStep);
    replayMode = true;
    replayRunId = message.runId;

    var engine = window.__tsReplayEngine;

    if (isTopFrame) {
      engine.ensureReplayOverlay(message.partnerName || "");
    }

    // Parse transaction date if provided as string
    var txDate = null;
    if (message.transactionDate) {
      txDate = new Date(message.transactionDate);
      if (isNaN(txDate.getTime())) txDate = null;
    }

    replayStateMachine = new engine.ReplayStateMachine({
      recipe: message.recipe,
      transactionAmount: message.transactionAmount || 0,
      transactionDate: txDate,
      transactionId: message.transactionId || "",
      transactionCurrency: message.transactionCurrency || "EUR",
      initialAgentIterations: message.agentIterations || 0,

      onProgress: function (step, total, msg) {
        if (isTopFrame) {
          engine.updateReplayOverlay(step, total, msg);
        }
        chrome.runtime.sendMessage({
          type: "TS_REPLAY_PROGRESS",
          step: step,
          total: total,
          message: msg,
        });
      },

      onSuccess: function (result) {
        console.log("[FiBuKI] Replay SUCCESS:", result);
        replayMode = false;
        if (isTopFrame) {
          engine.updateReplayOverlay(result.tier === 2 ? "Agent" : "Done", "", "Invoice downloaded!");
          setTimeout(function () { engine.removeReplayOverlay(); }, 3000);
        }
        chrome.runtime.sendMessage({
          type: "TS_REPLAY_SUCCESS",
          result: result,
        });
        replayStateMachine = null;
      },

      onFailed: function (result) {
        console.log("[FiBuKI] Replay FAILED:", result);
        replayMode = false;
        if (isTopFrame) {
          engine.updateReplayOverlay(0, 0, "Replay failed: " + result.status);
          setTimeout(function () { engine.removeReplayOverlay(); }, 5000);
        }
        chrome.runtime.sendMessage({
          type: "TS_REPLAY_FAILED",
          result: result,
        });
        replayStateMachine = null;
      },

      onAuthRequired: function () {
        console.log("[FiBuKI] Replay: Auth required");
        if (isTopFrame) {
          engine.updateReplayOverlay(0, 0, "Login required — please sign in");
        }
        chrome.runtime.sendMessage({
          type: "TS_REPLAY_AUTH_REQUIRED",
          url: window.location.href,
        });
      },

      onTier2Needed: function (failedAtStep, snapshot) {
        console.log("[FiBuKI] Replay: Tier 2 needed at step", failedAtStep);
        if (isTopFrame) {
          engine.updateReplayOverlay(failedAtStep, replayStateMachine._totalSteps, "Calling AI agent...");
        }
        // Send snapshot to app for Tier 2 processing
        // The app tab will call the replay-agent API and send commands back
        chrome.runtime.sendMessage({
          type: "TS_REPLAY_TIER2_NEEDED",
          failedAtStep: failedAtStep,
          snapshot: snapshot,
          transactionId: message.transactionId,
          transactionAmount: message.transactionAmount,
          transactionDate: message.transactionDate,
          transactionCurrency: message.transactionCurrency,
          partnerName: message.partnerName,
          recipe: message.recipe,
        });
      },
    });

    // Start the replay (resume from step if navigating back)
    replayStateMachine.start(resumeFromStep);
  });

  // Handle Tier 2 commands from app tab (via background)
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_REPLAY_TIER2_COMMANDS") return;
    if (!replayStateMachine || !replayMode) return;

    var commands = message.commands || [];
    console.log("[FiBuKI] Executing Tier 2 commands:", commands.length);

    replayStateMachine.executeTier2Commands(commands, function (success) {
      if (success) {
        // After agent commands, try to find invoice again
        replayStateMachine.findAndDownloadInvoice();
      }
    });
  });

  // Handle PDF downloaded during replay
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_REPLAY_PDF_DOWNLOADED") return;
    if (!replayMode || !replayStateMachine) return;

    console.log("[FiBuKI] Replay: PDF downloaded", message.sourceUrl);
    // The download was intercepted and uploaded by background.js
    // Trigger success
    if (replayStateMachine.state !== "success") {
      var engine = window.__tsReplayEngine;
      replayStateMachine.state = engine.STATES.SUCCESS;
      replayMode = false;
      if (isTopFrame) {
        engine.updateReplayOverlay(0, 0, "Invoice downloaded!");
        setTimeout(function () { engine.removeReplayOverlay(); }, 3000);
      }
      chrome.runtime.sendMessage({
        type: "TS_REPLAY_SUCCESS",
        result: {
          status: "success",
          tier: replayStateMachine.tier,
          durationMs: Date.now() - replayStateMachine.startTime,
          transactionId: replayStateMachine.config.transactionId,
          agentIterations: replayStateMachine.agentIterations,
        },
      });
      replayStateMachine = null;
    }
  });

  // Handle TS_REPLAY_CAPTURE_PAGE from replay-engine (via postMessage)
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data || {};
    if (data.type !== "TS_REPLAY_CAPTURE_PAGE") return;

    console.log("[FiBuKI] Replay: capturing page as PDF");
    captureAndUploadPageAsPdf(function (success) {
      console.log("[FiBuKI] Replay: page capture " + (success ? "succeeded" : "failed"));
    });
  });

  // Network hook is injected via background (MAIN world) to avoid page CSP.

  window.postMessage(
    {
      type: EXTENSION_PONG,
      source: EXTENSION_SOURCE,
      version: VERSION,
    },
    "*"
  );
})();
