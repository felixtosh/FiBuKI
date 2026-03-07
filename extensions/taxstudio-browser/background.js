(function () {
  var runs = {};
  var COLLECTOR_ID = "basic";
  var seenDownloadUrls = {};
  var injectedTabs = {};
  var activeTabRuns = {};
  var pdfHistory = {};
  var appBaseUrl = "https://fibuki.com";

  function setAppBaseUrl(origin) {
    if (!origin || typeof origin !== "string") return;
    // Validate it looks like a URL origin
    if (origin.indexOf("http") !== 0) return;
    appBaseUrl = origin;
    try {
      chrome.storage.local.set({ ts_app_base_url: origin });
    } catch (e) {}
  }

  function getApiUrl(path) {
    return appBaseUrl + path;
  }

  var DEBUG_LOG_URL = null; // computed dynamically via getApiUrl

  // Learn mode state
  var learnRuns = {}; // { runId: { tabId, appTabId, partnerId, partnerName, transactionId, pdfCount, childTabIds } }

  // Replay mode state
  var replayRuns = {}; // { runId: { tabId, appTabId, transactionId, partnerId, partnerName, recipe, childTabIds, status } }

  console.log("[FiBuKI] Background service worker loaded");

  // Track URLs we've already started processing
  var processingUrls = {};
  var PULL_CLEANUP_DELAY_MS = 15000;
  var MANUAL_CAPTURE_MENU_ID = "ts_activate_invoice_downloads";

  function isPullRun(run) {
    return !!(run && !run.isLearnRun && !run.isReplayRun);
  }

  function isRunActiveForIntercept(run) {
    return !!(run && !run.pausedForLogin && !run.completedAt);
  }

  function maybeCleanupPullRun(runId, reason) {
    if (!runId || !runs[runId]) return;
    var run = runs[runId];
    if (!isPullRun(run)) return;
    if (run.pausedForLogin) return;
    if ((run.pendingDownloads || 0) > 0) return;
    if ((run.inflightUploads || 0) > 0) return;
    if (run.cleanupTimer) {
      clearTimeout(run.cleanupTimer);
      run.cleanupTimer = null;
    }
    console.log("[FiBuKI] Cleaning up pull run:", runId, reason || "ready");
    cleanupRunRegistration(runId);
  }

  function markPullRunCompleted(runId, reason) {
    if (!runId || !runs[runId]) return;
    var run = runs[runId];
    if (!isPullRun(run)) return;
    if (!run.completedAt) {
      run.completedAt = Date.now();
      run.completedReason = reason || "completed";
      if (run.cleanupTimer) {
        clearTimeout(run.cleanupTimer);
      }
      run.cleanupTimer = setTimeout(function () {
        if (!runs[runId]) return;
        runs[runId].cleanupTimer = null;
        maybeCleanupPullRun(runId, "delayed_cleanup");
      }, PULL_CLEANUP_DELAY_MS);
    }
    maybeCleanupPullRun(runId, reason || run.completedReason || "completed");
  }

  // Watch for new tabs being created with PDF URLs (fires earliest)
  if (chrome.webNavigation && chrome.webNavigation.onCreatedNavigationTarget) {
    chrome.webNavigation.onCreatedNavigationTarget.addListener(function(details) {
      var url = details.url || "";
      var lowerUrl = url.toLowerCase();

      var isPdfUrl = lowerUrl.indexOf("payments.google.com") !== -1 &&
                     (lowerUrl.indexOf("apis-secure/doc") !== -1 || lowerUrl.indexOf("?doc=") !== -1);

      if (!isPdfUrl) return;

      var activeRunIds = Object.keys(runs).filter(function(rid) {
        return isRunActiveForIntercept(runs[rid]);
      });

      if (activeRunIds.length === 0) return;

      console.log("[FiBuKI] PDF new tab created, closing early:", details.tabId, url.slice(0, 80));

      // Close immediately before navigation completes
      try {
        chrome.tabs.remove(details.tabId);
      } catch (err) {}

      // Fetch and upload
      if (!processingUrls[url] && !seenDownloadUrls[url]) {
        processingUrls[url] = true;
        fetchAndUploadPdfDirect(activeRunIds[0], url);
      }
    });
  }

  // Watch for tabs about to navigate to PDF URLs (fires before navigation starts)
  if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
    chrome.webNavigation.onBeforeNavigate.addListener(function(details) {
      var url = details.url || "";
      var lowerUrl = url.toLowerCase();

      var isPdfUrl = lowerUrl.indexOf("payments.google.com") !== -1 &&
                     (lowerUrl.indexOf("apis-secure/doc") !== -1 || lowerUrl.indexOf("?doc=") !== -1);

      if (!isPdfUrl) return;
      if (details.frameId !== 0) return; // Only main frame

      var activeRunIds = Object.keys(runs).filter(function(rid) {
        return isRunActiveForIntercept(runs[rid]);
      });

      if (activeRunIds.length === 0) return;

      console.log("[FiBuKI] PDF navigation starting, closing tab:", details.tabId, url.slice(0, 80));

      try {
        chrome.tabs.remove(details.tabId);
      } catch (err) {}

      if (!processingUrls[url] && !seenDownloadUrls[url]) {
        processingUrls[url] = true;
        fetchAndUploadPdfDirect(activeRunIds[0], url);
      }
    });
  }

  // Watch for tabs navigating to PDF URLs and close them immediately (final backup)
  if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
    chrome.webNavigation.onCommitted.addListener(function(details) {
      var url = details.url || "";
      var lowerUrl = url.toLowerCase();

      // Check if this is a PDF download URL from Google Payments
      var isPdfUrl = lowerUrl.indexOf("payments.google.com") !== -1 &&
                     (lowerUrl.indexOf("apis-secure/doc") !== -1 || lowerUrl.indexOf("?doc=") !== -1);

      if (!isPdfUrl) return;

      // Check for active run
      var activeRunIds = Object.keys(runs).filter(function(rid) {
        return isRunActiveForIntercept(runs[rid]);
      });

      if (activeRunIds.length === 0) return;

      console.log("[FiBuKI] PDF tab detected, closing:", details.tabId, url.slice(0, 80));

      // Close the tab immediately to prevent download dialog
      try {
        chrome.tabs.remove(details.tabId);
      } catch (err) {
        console.warn("[FiBuKI] Failed to close PDF tab:", err);
      }

      // Fetch and upload if not already processing
      if (!processingUrls[url] && !seenDownloadUrls[url]) {
        processingUrls[url] = true;
        var runId = activeRunIds[0];
        fetchAndUploadPdfDirect(runId, url);
      }
    });
    console.log("[FiBuKI] webNavigation listener registered for PDF tab detection");
  }

  function fetchAndUploadPdfDirect(runId, url, transactionId) {
    if (seenDownloadUrls[url]) {
      console.log("[FiBuKI] Already processed URL, skipping:", url.slice(0, 80));
      return;
    }
    seenDownloadUrls[url] = true;

    console.log("[FiBuKI] fetchAndUploadPdfDirect:", url.slice(0, 100));
    fetch(url, { credentials: "include", redirect: "follow" })
      .then(function(resp) {
        if (!resp.ok) throw new Error("Fetch failed: " + resp.status);
        var mime = resp.headers.get("content-type") || "";
        var disposition = resp.headers.get("content-disposition") || "";
        console.log("[FiBuKI] fetchAndUploadPdfDirect response:", resp.status, mime);

        var isPdf = mime.toLowerCase().indexOf("pdf") !== -1;
        var hasPdfName = disposition.toLowerCase().indexOf(".pdf") !== -1;
        if (!isPdf && !hasPdfName) {
          throw new Error("Not a PDF: " + mime);
        }

        return resp.arrayBuffer().then(function(buf) {
          var filename = guessFilenameFromDisposition(disposition) || "invoice.pdf";
          uploadBuffer(runId, buf, filename, mime || "application/pdf", url, transactionId);
        });
      })
      .catch(function(err) {
        console.warn("[FiBuKI] fetchAndUploadPdfDirect failed:", err);
        delete processingUrls[url];
      });
  }

  function guessFilenameFromDisposition(disposition) {
    if (!disposition) return null;
    var match = disposition.match(/filename="([^"]+)"/i);
    if (match && match[1]) return match[1];
    match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (match && match[1]) return decodeURIComponent(match[1]);
    return null;
  }

  function sendDebugLog(runId, data) {
    if (!runId) return;
    fetch(getApiUrl("/api/browser/log"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: runId,
        type: data.type || "background_debug",
        ...data,
      }),
    }).catch(function (err) {
      console.warn("[FiBuKI] Debug log failed:", err);
    });
  }

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(
      ["ts_pdf_history", "ts_dev_extractor_url", "ts_dev_extractor_enabled", "ts_app_base_url"],
      function (result) {
      if (result && result.ts_pdf_history) {
        pdfHistory = result.ts_pdf_history;
      }
      if (result && result.ts_app_base_url) {
        appBaseUrl = result.ts_app_base_url;
      }
      if (!result || typeof result.ts_dev_extractor_enabled !== "boolean") {
        chrome.storage.local.set({
          ts_dev_extractor_enabled: true,
          ts_dev_extractor_url: getApiUrl("/api/browser/extractor"),
        });
      }
    }
    );
  }

  function sendToTab(tabId, payload) {
    if (!tabId) return;
    try {
      var result = chrome.tabs.sendMessage(tabId, payload);
      if (result && typeof result.catch === "function") {
        result.catch(function () {});
      }
    } catch (err) {
      // Ignore messaging errors
    }
  }

  function createPullRun(runId, appTabId, authToken, options) {
    var opts = options || {};
    runs[runId] = {
      tabId: opts.tabId || null,
      downloadTabIds: [],
      attemptedUrls: {},
      openedDownloadUrls: {},
      appTabId: appTabId || null,
      foundCount: 0,
      downloadedCount: 0,
      urls: [],
      overlaySent: false,
      authToken: authToken || null,
      manualMode: !!opts.manualMode,
    };
  }

  function startManualCaptureForTab(tabId, appTabId, reason) {
    if (typeof tabId !== "number" || tabId < 0) return null;

    var mappedRunId = activeTabRuns[tabId];
    if (mappedRunId && runs[mappedRunId]) {
      if (isRunActiveForIntercept(runs[mappedRunId]) || runs[mappedRunId].pausedForLogin) {
        sendToTab(tabId, {
          type: "TS_SHOW_OVERLAY",
          runId: mappedRunId,
          manual: true,
          reason: reason || "manual_start",
        });
        return mappedRunId;
      }
      cleanupRunRegistration(mappedRunId);
    }

    var runId = "manual_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    createPullRun(runId, appTabId || tabId, null, {
      tabId: tabId,
      manualMode: true,
    });
    activeTabRuns[tabId] = runId;

    sendToTab(tabId, {
      type: "TS_SHOW_OVERLAY",
      runId: runId,
      manual: true,
      reason: reason || "manual_start",
    });
    sendToTab(runs[runId].appTabId, {
      type: "TS_PULL_EVENT",
      runId: runId,
      status: "running",
      manual: true,
    });
    return runId;
  }

  function ensureManualCaptureMenu() {
    if (!chrome.contextMenus) return;
    function createMenu() {
      try {
        chrome.contextMenus.create(
          {
            id: MANUAL_CAPTURE_MENU_ID,
            title: "Activate invoice downloads",
            contexts: ["action"],
          },
          function () {
            var createErr = chrome.runtime && chrome.runtime.lastError;
            if (!createErr) return;
            var createMsg = String(createErr.message || "");
            if (createMsg.toLowerCase().indexOf("duplicate") !== -1) return;
            console.warn("[FiBuKI] contextMenus.create failed:", createMsg);
          }
        );
      } catch (err) {}
    }
    try {
      chrome.contextMenus.remove(MANUAL_CAPTURE_MENU_ID, function () {
        var removeErr = chrome.runtime && chrome.runtime.lastError;
        if (removeErr) {
          var removeMsg = String(removeErr.message || "");
          if (removeMsg.indexOf("Cannot find menu item") === -1) {
            console.warn("[FiBuKI] contextMenus.remove warning:", removeMsg);
          }
        }
        createMenu();
      });
    } catch (err) {
      createMenu();
    }
  }

  if (chrome.action && chrome.action.onClicked) {
    chrome.action.onClicked.addListener(function (tab) {
      if (!tab || typeof tab.id !== "number") return;
      startManualCaptureForTab(tab.id, tab.id, "action_click");
    });
  }

  if (chrome.contextMenus) {
    ensureManualCaptureMenu();
    if (chrome.runtime && chrome.runtime.onInstalled) {
      chrome.runtime.onInstalled.addListener(function () {
        ensureManualCaptureMenu();
      });
    }
    if (chrome.runtime && chrome.runtime.onStartup) {
      chrome.runtime.onStartup.addListener(function () {
        ensureManualCaptureMenu();
      });
    }
    chrome.contextMenus.onClicked.addListener(function (info, tab) {
      if (!info || info.menuItemId !== MANUAL_CAPTURE_MENU_ID) return;
      if (!tab || typeof tab.id !== "number") return;
      startManualCaptureForTab(tab.id, tab.id, "context_menu");
    });
  }

  function queueDownloadUrls(runId, urls, pageOrigin) {
    if (!runId || !runs[runId]) return;
    if (runs[runId].pausedForLogin) return;
    if (!urls || !urls.length) return;
    var preferredUrls = preferKnownPdfUrls(urls);
    if (preferredUrls.length) {
      console.log("[FiBuKI] Using previously successful endpoints:", preferredUrls.length);
      urls = preferredUrls;
    }
    // Filter out CSV files - we only want PDFs
    var pdfOnlyUrls = urls.filter(function (url) {
      var lowerUrl = url.toLowerCase();
      // Exclude CSV downloads
      if (lowerUrl.indexOf(".csv") !== -1) return false;
      if (lowerUrl.indexOf("format=csv") !== -1) return false;
      if (lowerUrl.indexOf("type=csv") !== -1) return false;
      if (lowerUrl.indexOf("export=csv") !== -1) return false;
      if (lowerUrl.indexOf("account_activities") !== -1) return false; // Google's CSV activity export
      return true;
    });
    console.log("[FiBuKI] PDF-only URLs", pdfOnlyUrls.length, "of", urls.length, "total");
    if (!pdfOnlyUrls.length) return;
    var safeUrls = pdfOnlyUrls.filter(function (url) {
      if (!pageOrigin) return true;
      try {
        return new URL(url).origin === pageOrigin;
      } catch (err) {
        return false;
      }
    });
    console.log("[FiBuKI] Safe URLs", safeUrls.length, "origin", pageOrigin);
    if (!safeUrls.length) return;
    var downloadUrls = safeUrls.slice(0, 5);
    runs[runId].pendingDownloads = downloadUrls.length;
    if (runs[runId].pendingDownloads === 0) return;
    var finalize = function () {
      runs[runId].pendingDownloads = Math.max(0, (runs[runId].pendingDownloads || 1) - 1);
      if (runs[runId].pendingDownloads === 0) {
        if (runs[runId].appTabId) {
          sendToTab(runs[runId].appTabId, {
            type: "TS_PULL_EVENT",
            runId: runId,
            status: "completed",
          });
        }
      }
    };
    downloadUrls.forEach(function (url) {
      var finished = false;
      var finish = function () {
        if (finished) return;
        finished = true;
        finalize();
      };
      var attemptFetch = function (targetUrl, attempt) {
        if (!registerAttempt(runId, targetUrl)) {
          return;
        }
        fetch(targetUrl, { credentials: "include" })
          .then(function (resp) {
            if (!resp.ok) {
              throw new Error("Download failed");
            }
            var mime = resp.headers.get("content-type") || "";
            var disposition = resp.headers.get("content-disposition") || "";
            var lowerUrl = String(targetUrl).toLowerCase();
            var isPdf = mime.toLowerCase().indexOf("pdf") !== -1;
            var hasPdfName = disposition.toLowerCase().indexOf(".pdf") !== -1;
            var urlPdfHint = lowerUrl.indexOf(".pdf") !== -1 || lowerUrl.indexOf("format=pdf") !== -1;
            var isCsv = mime.toLowerCase().indexOf("text/csv") !== -1 || lowerUrl.indexOf(".csv") !== -1;
            var isImage = mime.toLowerCase().indexOf("image/") !== -1;
            var shouldRetry = attempt === 0 && lowerUrl.indexOf("doc=") !== -1 && lowerUrl.indexOf("format=pdf") === -1;
            if (isImage || isCsv) {
              throw new Error("Not a PDF");
            }
            return resp.arrayBuffer().then(function (buf) {
              var bytes = new Uint8Array(buf.slice(0, 16));
              var magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
              var isPdfMagic = magic === "%PDF";
              var prefix = Array.prototype.slice.call(bytes, 0, 10)
                .map(function (b) {
                  return b.toString(16).padStart(2, "0");
                })
                .join(" ");
              if (!isPdf && !hasPdfName && !urlPdfHint && !isPdfMagic) {
                var bodyPreview = "";
                try {
                  bodyPreview = new TextDecoder("utf-8").decode(buf.slice(0, 500));
                } catch (e) {}
                console.log("[FiBuKI] Not PDF response", {
                  url: targetUrl,
                  contentType: mime || "",
                  disposition: disposition || "",
                  magic: magic,
                  bytes: prefix,
                  size: buf.byteLength,
                });
                // Send debug log with full details
                sendDebugLog(runId, {
                  type: "fetch_not_pdf",
                  url: targetUrl,
                  fetchAttempts: [{
                    url: targetUrl,
                    status: resp.status,
                    contentType: mime,
                    disposition: disposition,
                    magic: magic,
                    bytes: prefix,
                    size: buf.byteLength,
                    bodyPreview: bodyPreview,
                  }],
                });
                if (shouldRetry) {
                  var retryUrl = targetUrl + (targetUrl.indexOf("?") === -1 ? "?" : "&") + "format=pdf";
                  console.log("[FiBuKI] Retrying as PDF:", retryUrl);
                  attemptFetch(retryUrl, attempt + 1);
                  return;
                }
                if (attempt < 2) {
                  var htmlUrls = extractDownloadUrlsFromBuffer(buf, targetUrl);
                  if (htmlUrls.length) {
                    htmlUrls.forEach(function (nextUrl) {
                      attemptFetch(nextUrl, attempt + 1);
                    });
                    return;
                  }
                }
                throw new Error("Not a PDF");
              }
              var filename = guessFilename(targetUrl, disposition);
              uploadBuffer(runId, buf, filename, "application/pdf", targetUrl);
            });
          })
          .catch(function (err) {
            if (err && err.message === "Not a PDF") {
              console.warn("[FiBuKI] Download skipped (not PDF):", targetUrl);
            } else {
              console.warn("[FiBuKI] Download skipped:", targetUrl, err);
              // Log fetch errors (not "Not a PDF" which is already logged above)
              sendDebugLog(runId, {
                type: "fetch_error",
                url: targetUrl,
                fetchAttempts: [{
                  url: targetUrl,
                  error: err && err.message ? err.message : String(err),
                }],
              });
            }
            if (err && err.message === "Not a PDF") {
              openFallbackTab(runId, targetUrl);
            }
          })
          .finally(function () {
            if (attempt === 0 || finished) {
              finish();
            }
          });
      };
      attemptFetch(url, 0);
    });
  }

  function shouldTrackRequest(url) {
    if (!url) return false;
    var lowerUrl = String(url).toLowerCase();
    if (lowerUrl.indexOf("payments.google.com") === -1) return false;
    if (lowerUrl.indexOf("/payments/apis-secure/doc/") !== -1) return true;
    if (lowerUrl.indexOf("doc=") !== -1) return true;
    return false;
  }

  function isLoginChallenge(url) {
    if (!url) return false;
    var lowerUrl = String(url).toLowerCase();
    return lowerUrl.indexOf("https://accounts.google.com/v3/signin/challenge") === 0;
  }

  // ============ Chrome Notifications for Login Issues ============

  /**
   * Extract domain from a URL for display
   */
  function extractDomainForNotification(url) {
    try {
      var parsed = new URL(url);
      return parsed.hostname;
    } catch (err) {
      return "the website";
    }
  }

  /**
   * Show a Chrome notification for login required.
   * Uses chrome.notifications API for native OS notifications.
   */
  function showLoginNotification(runId, url) {
    if (!chrome.notifications) {
      console.warn("[FiBuKI] chrome.notifications API not available");
      return;
    }

    var domain = extractDomainForNotification(url);
    var notificationId = "ts_login_" + runId;

    chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "FiBuKI: Login Required",
      message: "Please log in to " + domain + " to continue invoice collection.",
      buttons: [
        { title: "Open Page" },
        { title: "Dismiss" }
      ],
      priority: 2,
      requireInteraction: true
    }, function(createdId) {
      if (chrome.runtime.lastError) {
        console.warn("[FiBuKI] Failed to create notification:", chrome.runtime.lastError.message);
      } else {
        console.log("[FiBuKI] Login notification created:", createdId);
      }
    });
  }

  /**
   * Handle notification button clicks
   */
  if (chrome.notifications && chrome.notifications.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener(function(notificationId, buttonIndex) {
      if (!notificationId || notificationId.indexOf("ts_login_") !== 0) return;

      var runId = notificationId.replace("ts_login_", "");
      console.log("[FiBuKI] Notification button clicked:", notificationId, buttonIndex);

      if (buttonIndex === 0) {
        // "Open Page" clicked - focus the tab
        if (runs[runId] && runs[runId].tabId) {
          chrome.tabs.update(runs[runId].tabId, { active: true }, function() {
            if (chrome.runtime.lastError) {
              console.warn("[FiBuKI] Failed to focus tab:", chrome.runtime.lastError.message);
            }
          });
          if (runs[runId].windowId) {
            chrome.windows.update(runs[runId].windowId, { focused: true }, function() {
              if (chrome.runtime.lastError) {
                console.warn("[FiBuKI] Failed to focus window:", chrome.runtime.lastError.message);
              }
            });
          }
        }
      }

      // Clear the notification
      chrome.notifications.clear(notificationId, function() {
        if (chrome.runtime.lastError) {
          console.warn("[FiBuKI] Failed to clear notification:", chrome.runtime.lastError.message);
        }
      });
    });
    console.log("[FiBuKI] Notification button click listener registered");
  }

  /**
   * Handle notification closed (dismissed by user)
   */
  if (chrome.notifications && chrome.notifications.onClosed) {
    chrome.notifications.onClosed.addListener(function(notificationId, byUser) {
      if (!notificationId || notificationId.indexOf("ts_login_") !== 0) return;
      console.log("[FiBuKI] Login notification closed:", notificationId, byUser ? "by user" : "programmatically");
    });
  }

  // ============ End Chrome Notifications ============

  function pauseForLogin(runId, url) {
    if (!runId || !runs[runId]) return;
    if (runs[runId].pausedForLogin) return;
    runs[runId].pausedForLogin = true;
    runs[runId].pendingDownloads = 0;

    // Show native Chrome notification for login
    showLoginNotification(runId, url);

    if (runs[runId].appTabId) {
      sendToTab(runs[runId].appTabId, {
        type: "TS_PULL_EVENT",
        runId: runId,
        status: "login_required",
      });
      sendToTab(runs[runId].appTabId, {
        type: "TS_PAUSE_FOR_LOGIN",
        runId: runId,
        url: url,
      });
    }
    if (runs[runId].tabId) {
      sendToTab(runs[runId].tabId, {
        type: "TS_PAUSE_FOR_LOGIN",
        runId: runId,
        url: url,
      });
    }
  }

  function getHeader(headers, name) {
    if (!headers) return "";
    var target = String(name || "").toLowerCase();
    for (var i = 0; i < headers.length; i += 1) {
      var header = headers[i];
      if (header && header.name && header.name.toLowerCase() === target) {
        return header.value || "";
      }
    }
    return "";
  }

  function onTabUpdated(tabId, changeInfo) {
    if (changeInfo.status !== "complete") return;
    Object.keys(runs).forEach(function (runId) {
      var run = runs[runId];
      if (!run || run.tabId !== tabId) return;
      // Don't send pull overlay for replay/learn runs — they have their own overlays
      if (run.isReplayRun || run.isLearnRun) return;
      sendToTab(run.tabId, { type: "TS_SHOW_OVERLAY", runId: runId });
      sendToTab(run.appTabId, { type: "TS_PULL_EVENT", runId: runId, status: "completed" });
    });
  }

  chrome.tabs.onUpdated.addListener(onTabUpdated);

  if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
    chrome.webRequest.onHeadersReceived.addListener(
      function (details) {
        if (!details || typeof details.tabId !== "number" || details.tabId < 0) return;
        var runId = activeTabRuns[details.tabId];
        if (!runId || !runs[runId]) return;
        var url = details.url || "";
        if (!shouldTrackRequest(url)) return;
        var contentType = getHeader(details.responseHeaders, "content-type");
        var disposition = getHeader(details.responseHeaders, "content-disposition");
        var lowerUrl = url.toLowerCase();
        var hasPdfHint =
          lowerUrl.indexOf("format=pdf") !== -1 ||
          (contentType && contentType.toLowerCase().indexOf("pdf") !== -1) ||
          (disposition && disposition.toLowerCase().indexOf(".pdf") !== -1);
        if (!hasPdfHint && lowerUrl.indexOf("doc=") === -1) return;
        try {
          queueDownloadUrls(runId, [url], new URL(url).origin);
        } catch (err) {
          // ignore
        }
      },
      { urls: ["<all_urls>"] },
      ["responseHeaders"]
    );
  }

  if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
    chrome.webRequest.onBeforeRequest.addListener(
      function (details) {
        if (!details || typeof details.tabId !== "number" || details.tabId < 0) return;
        if (!isLoginChallenge(details.url)) return;
        var runId = activeTabRuns[details.tabId];
        if (!runId || !runs[runId]) return;
        pauseForLogin(runId, details.url);
      },
      { urls: ["<all_urls>"] }
    );
  }

  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_START_PULL") return;
    if (message.appOrigin) setAppBaseUrl(message.appOrigin);
    console.log("[FiBuKI] TS_START_PULL", message.runId, message.url);
    var runId = message.runId;
    var url = message.url;
    if (!runId || !url) return;
    createPullRun(runId, sender.tab ? sender.tab.id : null, message.authToken || null, {});
    setTimeout(function () {
      if (!runs[runId] || runs[runId].tabId) return;
      var openUrl = url;
      try {
        var parsed = new URL(url);
        parsed.hash = "ts_run=" + runId;
        openUrl = parsed.toString();
      } catch (err) {
        openUrl = url;
      }
      chrome.tabs.create({ url: openUrl, active: true }, function (tab) {
        if (!tab || typeof tab.id !== "number") return;
        runs[runId].tabId = tab.id;
        activeTabRuns[tab.id] = runId;
        sendToTab(runs[runId].tabId, { type: "TS_SHOW_OVERLAY", runId: runId });
        sendToTab(runs[runId].appTabId, { type: "TS_PULL_EVENT", runId: runId, status: "running" });
      });
    }, 1500);
  });

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "TS_START_MANUAL_CAPTURE") return false;
    if (message.appOrigin) setAppBaseUrl(message.appOrigin);
    if (!sender.tab || typeof sender.tab.id !== "number") {
      sendResponse({ ok: false, error: "No sender tab" });
      return false;
    }
    var manualRunId = startManualCaptureForTab(
      sender.tab.id,
      sender.tab.id,
      message.source || "content_click"
    );
    sendResponse({ ok: !!manualRunId, runId: manualRunId });
    return false;
  });

  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_INJECT_HOOK") return;
    if (!sender.tab || typeof sender.tab.id !== "number") return;
    if (injectedTabs[sender.tab.id]) return;
    injectedTabs[sender.tab.id] = true;
    console.log("[FiBuKI] Injecting network hook into tab", sender.tab.id);
    var result = chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, allFrames: true },
      world: "MAIN",
      func: function () {
        if (window.__taxstudioHooked) return;
        window.__taxstudioHooked = true;
        function isPdf(headers) {
          var ct = (headers["content-type"] || "").toLowerCase();
          return ct.indexOf("pdf") !== -1;
        }
        var origFetch = window.fetch;
        window.fetch = function () {
          return origFetch.apply(this, arguments).then(function (resp) {
            try {
              var headers = {};
              resp.headers.forEach(function (value, key) {
                headers[key.toLowerCase()] = value;
              });
              if (isPdf(headers) || resp.url.toLowerCase().indexOf(".pdf") !== -1) {
                window.postMessage(
                  { type: "TS_NETWORK_PDF", url: resp.url, headers: headers },
                  "*"
                );
              }
            } catch (e) {}
            return resp;
          });
        };
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function () {
          this.__tsUrl = arguments[1];
          return origOpen.apply(this, arguments);
        };
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () {
          this.addEventListener("load", function () {
            try {
              var ct = this.getResponseHeader("content-type") || "";
              var headers = { "content-type": ct };
              var url = this.responseURL || this.__tsUrl || "";
              if (isPdf(headers) || String(url).toLowerCase().indexOf(".pdf") !== -1) {
                window.postMessage(
                  {
                    type: "TS_NETWORK_PDF",
                    url: url,
                    headers: headers,
                  },
                  "*"
                );
              }
            } catch (e) {}
          });
          return origSend.apply(this, arguments);
        };
        // Wrap URL.createObjectURL to capture blob PDFs
        var origCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function (obj) {
          var blobUrl = origCreateObjectURL.call(URL, obj);
          try {
            if (obj instanceof Blob && obj.size > 100) {
              var blobType = (obj.type || "").toLowerCase();
              // Skip types that are definitely NOT PDFs
              var isNotPdf = blobType.indexOf("image/") === 0 ||
                             blobType.indexOf("video/") === 0 ||
                             blobType.indexOf("audio/") === 0 ||
                             blobType.indexOf("font/") === 0 ||
                             blobType.indexOf("text/css") === 0 ||
                             blobType.indexOf("text/javascript") === 0 ||
                             blobType.indexOf("text/html") === 0;
              if (!isNotPdf) {
                // Read first bytes to check for PDF magic (%PDF)
                var sliceForCheck = obj.slice(0, 5);
                var magicReader = new FileReader();
                magicReader.onload = function () {
                  try {
                    var header = new Uint8Array(magicReader.result);
                    if (header.length >= 4 && header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) {
                      console.log("[FiBuKI-MAIN] PDF blob detected via createObjectURL, type:", blobType, "size:", obj.size);
                      // It's a PDF — read the full blob
                      var fullReader = new FileReader();
                      fullReader.onload = function () {
                        try {
                          var bytes = new Uint8Array(fullReader.result);
                          var binary = "";
                          for (var i = 0; i < bytes.length; i++) {
                            binary += String.fromCharCode(bytes[i]);
                          }
                          var base64 = btoa(binary);
                          window.postMessage({ type: "TS_BLOB_PDF", base64: base64, blobUrl: blobUrl }, "*");
                        } catch (e) {
                          console.warn("[FiBuKI-MAIN] TS_BLOB_PDF encode error:", e);
                        }
                      };
                      fullReader.readAsArrayBuffer(obj);
                    }
                  } catch (e) {}
                };
                magicReader.readAsArrayBuffer(sliceForCheck);
              }
            }
          } catch (e) {}
          return blobUrl;
        };
        // Wrap HTMLAnchorElement.prototype.click to capture anchor downloads
        var origAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          try {
            var downloadAttr = this.getAttribute("download");
            var href = this.href || "";
            if (downloadAttr !== null && (href.indexOf("blob:") === 0 || href.indexOf("data:") === 0)) {
              window.postMessage({
                type: "TS_ANCHOR_DOWNLOAD",
                href: href,
                filename: downloadAttr || "download.pdf",
              }, "*");
            }
          } catch (e) {}
          return origAnchorClick.apply(this, arguments);
        };
      },
    });
    if (result && typeof result.catch === "function") {
      result.catch(function () {});
    }
  });

  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_ATTACH_PULL") return;
    console.log("[FiBuKI] TS_ATTACH_PULL", message.runId);
    var runId = message.runId;
    if (!runId || !runs[runId]) return;
    if (!sender.tab || typeof sender.tab.id !== "number") return;
    if (!runs[runId].tabId) {
      runs[runId].tabId = sender.tab.id;
      activeTabRuns[sender.tab.id] = runId;
    } else if (runs[runId].tabId !== sender.tab.id) {
      if (!runs[runId].downloadTabIds) runs[runId].downloadTabIds = [];
      if (runs[runId].downloadTabIds.indexOf(sender.tab.id) === -1) {
        runs[runId].downloadTabIds.push(sender.tab.id);
        activeTabRuns[sender.tab.id] = runId;
      }
    }
    console.log("[FiBuKI] Attaching overlay to tab", sender.tab.id);
    sendToTab(sender.tab.id, { type: "TS_SHOW_OVERLAY", runId: runId });
    if (!runs[runId].overlaySent) {
      runs[runId].overlaySent = true;
      sendToTab(runs[runId].appTabId, { type: "TS_PULL_EVENT", runId: runId, status: "running" });
    }
  });

  // Allow iframes to check if there's an active run for their tab (for self-starting after reload)
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "TS_CHECK_ACTIVE_RUN") return false;
    if (!sender.tab || typeof sender.tab.id !== "number") {
      sendResponse({ runId: null, manual: false });
      return false;
    }
    var runId = activeTabRuns[sender.tab.id] || null;
    console.log("[FiBuKI] TS_CHECK_ACTIVE_RUN tab", sender.tab.id, "->", runId);
    sendResponse({ runId: runId, manual: !!(runId && runs[runId] && runs[runId].manualMode) });
    return false; // synchronous response
  });

  // Handle pause/resume toggle from UI
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_TOGGLE_PAUSE") return;
    var runId = message.runId;
    var paused = message.paused;
    if (!runId || !runs[runId]) return;
    runs[runId].pausedForLogin = paused;
    console.log("[FiBuKI] Run", runId, "paused:", paused);
    // Broadcast to all tabs associated with this run
    var tabIds = [runs[runId].tabId, runs[runId].appTabId].concat(runs[runId].downloadTabIds || []);
    tabIds.forEach(function(tabId) {
      if (tabId) {
        sendToTab(tabId, {
          type: "TS_SET_PAUSED",
          runId: runId,
          paused: paused,
        });
      }
    });
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_PULL_RESULTS") return;
    console.log("[FiBuKI] TS_PULL_RESULTS", message.runId, (message.urls || []).length);
    var runId = message.runId;
    var urls = message.urls || [];
    if (!runId || !runs[runId]) return;
    runs[runId].urls = urls;
    runs[runId].foundCount = urls.length;
    sendToTab(runs[runId].appTabId, {
      type: "TS_PULL_RESULTS",
      runId: runId,
      urls: urls,
      foundCount: urls.length,
      downloadedCount: runs[runId].downloadedCount || 0,
    });
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_UPLOAD_FILE") return;
    console.log("[FiBuKI] TS_UPLOAD_FILE", message.runId, message.filename || "");
    var runId = message.runId;
    if (!runId) return;
    // Auto-create runs entry for learn/replay mode if not yet created
    if (!runs[runId]) {
      if (learnRuns[runId]) {
        runs[runId] = { tabId: learnRuns[runId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: learnRuns[runId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false, isLearnRun: true };
      } else if (replayRuns[runId]) {
        runs[runId] = { tabId: replayRuns[runId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: replayRuns[runId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false, isReplayRun: true };
      } else {
        return;
      }
    }
    var buffer = message.buffer;
    var filename = message.filename || "invoice.pdf";
    var mimeType = message.mimeType || "application/pdf";
    var sourceUrl = message.sourceUrl || "";
    if (!buffer) return;
    uploadBuffer(runId, buffer, filename, mimeType, sourceUrl);
  });

  // TS_CAPTURE_PAGE_AS_PDF: Convert HTML page to PDF server-side, then upload
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "TS_CAPTURE_PAGE_AS_PDF") return false;
    var runId = message.runId;
    var html = message.html;
    var pageUrl = message.pageUrl || "";
    var pageTitle = message.pageTitle || "page";

    console.log("[FiBuKI] TS_CAPTURE_PAGE_AS_PDF", runId, pageUrl.slice(0, 80));

    // Get auth token from learnRuns, replayRuns, or runs
    var token = null;
    if (runId && learnRuns[runId] && learnRuns[runId].authToken) {
      token = learnRuns[runId].authToken;
    } else if (runId && replayRuns[runId] && replayRuns[runId].authToken) {
      token = replayRuns[runId].authToken;
    } else if (runId && runs[runId] && runs[runId].authToken) {
      token = runs[runId].authToken;
    }

    if (!token) {
      console.warn("[FiBuKI] TS_CAPTURE_PAGE_AS_PDF: no auth token for run", runId);
      sendResponse({ ok: false, error: "No auth token" });
      return false;
    }

    // Ensure runs entry exists for uploadBuffer
    if (runId && !runs[runId]) {
      if (learnRuns[runId]) {
        runs[runId] = { tabId: learnRuns[runId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: learnRuns[runId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false, isLearnRun: true, authToken: token };
      } else if (replayRuns[runId]) {
        runs[runId] = { tabId: replayRuns[runId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: replayRuns[runId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false, isReplayRun: true, authToken: token };
      }
    }

    var transactionId = null;
    if (runId && learnRuns[runId]) transactionId = learnRuns[runId].transactionId;
    else if (runId && replayRuns[runId]) transactionId = replayRuns[runId].transactionId;

    fetch(getApiUrl("/api/browser/convert-html"), {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        html: html,
        pageUrl: pageUrl,
        pageTitle: pageTitle,
      }),
    })
    .then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) { throw new Error("Convert failed: " + resp.status + " " + t); });
      }
      return resp.arrayBuffer();
    })
    .then(function (pdfBuffer) {
      var filename = (pageTitle || "page").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 60) + ".pdf";
      uploadBuffer(runId, new Uint8Array(pdfBuffer), filename, "application/pdf", pageUrl, transactionId);
      sendResponse({ ok: true });
    })
    .catch(function (err) {
      console.warn("[FiBuKI] TS_CAPTURE_PAGE_AS_PDF failed:", err);
      sendResponse({ ok: false, error: err.message });
    });

    return true; // Keep channel open for async sendResponse
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_DOWNLOAD_URLS") return;
    console.log("[FiBuKI] TS_DOWNLOAD_URLS", message.runId, (message.urls || []).length);
    var runId = message.runId;
    var urls = message.urls || [];
    var pageOrigin = message.pageOrigin || "";
    if (!runId) return;
    // Auto-create runs entry for learn/replay mode if not yet created
    if (!runs[runId]) {
      if (learnRuns[runId]) {
        runs[runId] = { tabId: learnRuns[runId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: learnRuns[runId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false, isLearnRun: true };
      } else if (replayRuns[runId]) {
        runs[runId] = { tabId: replayRuns[runId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: replayRuns[runId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false, isReplayRun: true };
      } else {
        return;
      }
    }
    if (!urls.length) {
      if (runs[runId].appTabId) {
        sendToTab(runs[runId].appTabId, {
          type: "TS_PULL_EVENT",
          runId: runId,
          status: "completed",
        });
      }
      if (!runs[runId].manualMode) {
        markPullRunCompleted(runId, "no_urls");
      }
      return;
    }
    queueDownloadUrls(runId, urls, pageOrigin);
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_FRAME_CANDIDATES") return;
    var runId = message.runId;
    var urls = message.urls || [];
    var origin = message.origin || "";
    if (!runId || !runs[runId] || !urls.length) return;
    sendToTab(runs[runId].tabId, {
      type: "TS_FRAME_CANDIDATES",
      runId: runId,
      urls: urls,
      origin: origin,
    });
  });

  // Fetch extractor script (background can bypass CORS)
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "TS_FETCH_EXTRACTOR") return false;
    var url = message.url || getApiUrl("/api/browser/extractor");
    var targetUrl = url + (url.indexOf("?") === -1 ? "?" : "&") + "ts=" + Date.now();
    fetch(targetUrl, { cache: "no-store" })
      .then(function (resp) {
        if (!resp.ok) throw new Error("Fetch failed");
        return resp.text();
      })
      .then(function (script) {
        sendResponse({ script: script });
      })
      .catch(function (err) {
        console.warn("[FiBuKI] Extractor fetch failed:", err);
        sendResponse({ script: null, error: err.message });
      });
    return true; // Keep channel open for async response
  });

  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_DEV_LOG") return;
    var runId = message.runId;
    var level = message.level || "log";
    var payload = message.payload || "";
    if (!runId || !runs[runId]) return;
    var appTabId = runs[runId].appTabId || (sender.tab ? sender.tab.id : null);
    if (!appTabId) return;
    sendToTab(appTabId, {
      type: "TS_DEV_LOG",
      runId: runId,
      level: level,
      payload: payload,
    });
  });

  chrome.downloads.onCreated.addListener(function (item) {
    var url = item.finalUrl || item.url;
    console.log("[FiBuKI] Download detected:", url, "tabId:", item.tabId, "filename:", item.filename);

    // Check if this download is from a learn mode tab (direct or child tab)
    var learnRunId = null;
    var learnTransactionId = null;
    if (item && typeof item.tabId === "number" && item.tabId > 0) {
      learnRunId = findLearnRunByTab(item.tabId);
      if (learnRunId && learnRuns[learnRunId]) {
        learnTransactionId = learnRuns[learnRunId].transactionId;
        // Track this tab as a child if it's not already known
        var run = learnRuns[learnRunId];
        if (run.tabId !== item.tabId && run.childTabIds.indexOf(item.tabId) === -1) {
          run.childTabIds.push(item.tabId);
        }
      }
    }
    // Fallback: check if the download tab was opened BY a learn tab (openerTabId)
    if (!learnRunId && item && typeof item.tabId === "number" && item.tabId > 0) {
      try {
        chrome.tabs.get(item.tabId, function (tab) {
          if (chrome.runtime.lastError || !tab || !tab.openerTabId) return;
          var openerRunId = findLearnRunByTab(tab.openerTabId);
          if (openerRunId && learnRuns[openerRunId]) {
            console.log("[FiBuKI] Download tab opened by learn tab (via openerTabId):", tab.openerTabId);
            learnRuns[openerRunId].childTabIds.push(item.tabId);
          }
        });
      } catch (e) {}
    }
    // Fallback: if tabId is invalid (-1, 0) but there's an active learn run, use it
    if (!learnRunId) {
      var activeLearnIds = Object.keys(learnRuns);
      if (activeLearnIds.length > 0) {
        learnRunId = activeLearnIds[0];
        learnTransactionId = learnRuns[learnRunId].transactionId;
        console.log("[FiBuKI] Download matched to active learn run (no tabId match):", learnRunId);
      }
    }

    // Check if this download is from a replay mode tab
    var replayRunId = null;
    var replayTransactionId = null;
    if (item && typeof item.tabId === "number" && item.tabId > 0) {
      replayRunId = findReplayRunByTab(item.tabId);
      if (replayRunId && replayRuns[replayRunId]) {
        replayTransactionId = replayRuns[replayRunId].transactionId;
        if (!learnTransactionId) {
          learnTransactionId = replayTransactionId;
        }
      }
    }
    // Fallback: if tabId is invalid but there's an active replay run, use it
    if (!replayRunId) {
      var activeReplayIds = Object.keys(replayRuns);
      if (activeReplayIds.length > 0) {
        replayRunId = activeReplayIds[0];
        replayTransactionId = replayRuns[replayRunId].transactionId;
        if (!learnTransactionId) {
          learnTransactionId = replayTransactionId;
        }
        console.log("[FiBuKI] Download matched to active replay run (no tabId match):", replayRunId);
      }
    }

    // Try to find run by tab ID first
    var runId = null;
    if (item && typeof item.tabId === "number" && item.tabId > 0) {
      runId = findRunIdByTab(item.tabId);
    }

    // If no run found by tab, check if there's ANY active run
    if (!runId) {
      var allRunIds = Object.keys(runs);
      var activeRunIds = allRunIds.filter(function(rid) {
        return isRunActiveForIntercept(runs[rid]);
      });
      console.log("[FiBuKI] Looking for active run. All runs:", allRunIds.length, "Active:", activeRunIds.length, activeRunIds);
      if (activeRunIds.length > 0) {
        var lowerUrl = (url || "").toLowerCase();
        var lowerFilename = (item.filename || "").toLowerCase();
        // Check if this looks like a document download (not a web page)
        var isDocLike = lowerUrl.indexOf(".pdf") !== -1 ||
                        lowerUrl.indexOf("format=pdf") !== -1 ||
                        lowerFilename.indexOf(".pdf") !== -1 ||
                        lowerUrl.indexOf("/doc/") !== -1 ||
                        lowerUrl.indexOf("/document") !== -1 ||
                        lowerUrl.indexOf("apis-secure/doc") !== -1 ||  // Google Payments PDF
                        lowerUrl.indexOf("/download") !== -1 ||
                        lowerUrl.indexOf("?doc=") !== -1;
        // Also capture if it's from payments.google.com during a pull
        var isPaymentsDownload = lowerUrl.indexOf("payments.google.com") !== -1;
        if (isDocLike || isPaymentsDownload) {
          runId = activeRunIds[0]; // Use first active run
          console.log("[FiBuKI] Download matched to active run:", runId, "isDoc:", isDocLike, "isPayments:", isPaymentsDownload);
        }
      }
    }

    if (!runId) {
      // Check if this is from a learn mode tab
      if (learnRunId && learnRuns[learnRunId]) {
        console.log("[FiBuKI] Download from learn mode tab:", learnRunId);
        runId = learnRunId;
        if (!runs[runId]) {
          runs[runId] = { tabId: learnRuns[learnRunId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: learnRuns[learnRunId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false, isLearnRun: true };
        }
      } else if (replayRunId && replayRuns[replayRunId]) {
        console.log("[FiBuKI] Download from replay mode tab:", replayRunId);
        runId = replayRunId;
        if (!runs[runId]) {
          runs[runId] = { tabId: replayRuns[replayRunId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: replayRuns[replayRunId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false, isReplayRun: true };
        }
      } else {
        console.log("[FiBuKI] Download not captured - no active run");
        return;
      }
    }
    if (!url) return;
    // Blob URLs can't be fetched from background service worker.
    // Inject a MAIN world script to fetch the blob and relay PDF content.
    if (url.indexOf("blob:") === 0) {
      var isLearnBlob = learnRunId && learnRuns[learnRunId];
      var isReplayBlob = replayRunId && replayRuns[replayRunId];
      var blobRunId = learnRunId || replayRunId || runId;
      var blobTabId = isLearnBlob ? learnRuns[learnRunId].tabId :
                      isReplayBlob ? replayRuns[replayRunId].tabId : null;
      console.log("[FiBuKI] Blob download detected for run:", blobRunId, "tabId:", blobTabId, "isLearn:", !!isLearnBlob);

      // Cancel download during replay/pull (learn mode: let user see the file)
      if (!isLearnBlob) {
        try {
          chrome.downloads.cancel(item.id, function () {
            chrome.downloads.erase({ id: item.id }, function () {});
          });
        } catch (err) {}
      }

      // Inject MAIN world script to fetch the blob URL and relay content
      if (blobTabId && blobRunId) {
        var blobUrl = url;
        console.log("[FiBuKI] Injecting blob fetch into tab:", blobTabId, "url:", blobUrl.slice(0, 60));
        try {
          chrome.scripting.executeScript({
            target: { tabId: blobTabId },
            world: "MAIN",
            args: [blobUrl],
            func: function (blobUrl) {
              try {
                fetch(blobUrl)
                  .then(function (r) { return r.arrayBuffer(); })
                  .then(function (buf) {
                    var bytes = new Uint8Array(buf);
                    // Check PDF magic bytes
                    if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
                      var binary = "";
                      for (var i = 0; i < bytes.length; i++) {
                        binary += String.fromCharCode(bytes[i]);
                      }
                      var base64 = btoa(binary);
                      console.log("[FiBuKI-MAIN] Blob fetch success, PDF size:", bytes.length);
                      window.postMessage({ type: "TS_BLOB_PDF", base64: base64, blobUrl: blobUrl }, "*");
                    } else {
                      console.log("[FiBuKI-MAIN] Blob is not a PDF, magic:", bytes[0], bytes[1], bytes[2], bytes[3]);
                    }
                  })
                  .catch(function (e) {
                    console.warn("[FiBuKI-MAIN] Blob fetch failed:", e);
                  });
              } catch (e) {
                console.warn("[FiBuKI-MAIN] Blob fetch error:", e);
              }
            },
          });
        } catch (err) {
          console.warn("[FiBuKI] Blob fetch injection failed:", err);
        }
      }
      return;
    }
    if (url.indexOf("http") !== 0) return;
    if (seenDownloadUrls[url]) return;
    seenDownloadUrls[url] = true;
    console.log("[FiBuKI] Intercepting download for run:", runId, url);
    try {
      chrome.downloads.cancel(item.id, function () {
        chrome.downloads.erase({ id: item.id }, function () {});
      });
    } catch (err) {
      console.warn("[FiBuKI] Cancel download failed:", err);
    }
    console.log("[FiBuKI] Fetching URL from background:", url.slice(0, 100));
    fetch(url, { credentials: "include", redirect: "follow" })
      .then(function (resp) {
        console.log("[FiBuKI] Fetch response:", resp.status, resp.statusText, "type:", resp.type);
        if (!resp.ok) {
          throw new Error("Download fetch failed: " + resp.status + " " + resp.statusText);
        }
        var mime = resp.headers.get("content-type") || "";
        var disposition = resp.headers.get("content-disposition") || "";
        console.log("[FiBuKI] Fetch headers - mime:", mime, "disposition:", disposition);
        var lowerUrl = String(url).toLowerCase();
        var isPdf = mime.toLowerCase().indexOf("pdf") !== -1;
        var hasPdfName = disposition.toLowerCase().indexOf(".pdf") !== -1;
        var urlPdfHint = lowerUrl.indexOf(".pdf") !== -1 ||
                         lowerUrl.indexOf("format=pdf") !== -1 ||
                         lowerUrl.indexOf("apis-secure/doc") !== -1 ||  // Google Payments PDF
                         lowerUrl.indexOf("?doc=") !== -1;
        var isCsv = mime.toLowerCase().indexOf("text/csv") !== -1 || lowerUrl.indexOf(".csv") !== -1;
        var isImage = mime.toLowerCase().indexOf("image/") !== -1;
        // Log what we're checking
        console.log("[FiBuKI] Checking download:", {mime: mime, isPdf: isPdf, hasPdfName: hasPdfName, urlPdfHint: urlPdfHint, isCsv: isCsv, isImage: isImage});
        if (isImage || isCsv || (!isPdf && !hasPdfName && !urlPdfHint)) {
          throw new Error("Not a PDF: mime=" + mime + " disposition=" + disposition);
        }
        return resp.arrayBuffer().then(function (buf) {
          var filename = guessFilename(url, disposition) || item.filename || "invoice.pdf";
          // uploadBuffer now handles learn/replay notifications internally
          uploadBuffer(runId, buf, filename, mime || "application/pdf", url, learnTransactionId);
        });
      })
      .catch(function (err) {
        console.warn("[FiBuKI] Download capture failed:", err);
      });
  });

  function guessFilename(url, contentDisposition) {
    if (contentDisposition) {
      var match = contentDisposition.match(/filename="([^"]+)"/i);
      if (match && match[1]) {
        return match[1];
      }
    }
    try {
      var parsed = new URL(url);
      var last = parsed.pathname.split("/").pop();
      if (last && last.length > 0) return last;
    } catch (err) {
      // ignore
    }
    return "invoice.pdf";
  }

  function findRunIdByTab(tabId) {
    var keys = Object.keys(runs);
    for (var i = 0; i < keys.length; i += 1) {
      var runId = keys[i];
      if (runs[runId] && runs[runId].tabId === tabId) {
        return runId;
      }
      if (runs[runId] && Array.isArray(runs[runId].downloadTabIds)) {
        if (runs[runId].downloadTabIds.indexOf(tabId) !== -1) {
          return runId;
        }
      }
    }
    return null;
  }

  function registerAttempt(runId, url) {
    if (!runId || !runs[runId]) return false;
    var attempted = runs[runId].attemptedUrls || {};
    var key = normalizeUrl(url) || url;
    if (attempted[key]) return false;
    attempted[key] = true;
    runs[runId].attemptedUrls = attempted;
    return true;
  }

  function extractDownloadUrlsFromBuffer(buffer, baseUrl) {
    try {
      var text = new TextDecoder("utf-8").decode(buffer);
      return extractDownloadUrlsFromHtml(text, baseUrl);
    } catch (err) {
      return [];
    }
  }

  function extractDownloadUrlsFromHtml(html, baseUrl) {
    if (!html) return [];
    var urls = [];
    var seen = {};
    var patterns = [
      /data-download-url=["']([^"']+)["']/gi,
      /href=["']([^"']+)["']/gi,
      /"(\/payments\/apis-secure\/doc\/[^"']+)"/gi,
    ];
    patterns.forEach(function (re) {
      var match;
      while ((match = re.exec(html))) {
        var value = match[1];
        if (!value) continue;
        var decoded = value.replace(/&amp;/g, "&");
        var absolute = "";
        try {
          absolute = new URL(decoded, baseUrl).toString();
        } catch (err) {
          continue;
        }
        if (seen[absolute]) continue;
        if (!looksLikeDownload(absolute)) continue;
        seen[absolute] = true;
        urls.push(absolute);
      }
    });
    return urls.slice(0, 5);
  }

  function openFallbackTab(runId, url) {
    if (!runId || !runs[runId] || !url) return;
    var lowerUrl = String(url).toLowerCase();
    if (lowerUrl.indexOf("doc=") === -1 && lowerUrl.indexOf("payments.google.com") === -1) {
      return;
    }
    var opened = runs[runId].openedDownloadUrls || {};
    var key = normalizeUrl(url) || url;
    if (opened[key]) return;
    opened[key] = true;
    runs[runId].openedDownloadUrls = opened;
    var openUrl = url;
    try {
      var parsed = new URL(url);
      parsed.hash = "ts_run=" + runId;
      openUrl = parsed.toString();
    } catch (err) {
      openUrl = url;
    }
    chrome.tabs.create({ url: openUrl, active: false }, function (tab) {
      if (!tab || typeof tab.id !== "number") return;
      if (!runs[runId].downloadTabIds) runs[runId].downloadTabIds = [];
      if (runs[runId].downloadTabIds.indexOf(tab.id) === -1) {
        runs[runId].downloadTabIds.push(tab.id);
      }
    });
  }

  function uploadBuffer(runId, buffer, filename, mimeType, sourceUrl, transactionId) {
    var countedUpload = false;
    // Convert plain Array to Uint8Array (message passing serializes ArrayBuffer to Array)
    var binaryData;
    if (buffer instanceof ArrayBuffer) {
      binaryData = new Uint8Array(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
      binaryData = buffer;
    } else if (Array.isArray(buffer)) {
      binaryData = new Uint8Array(buffer);
    } else {
      binaryData = buffer;
    }
    console.log("[FiBuKI] uploadBuffer called:", {runId: runId, filename: filename, mimeType: mimeType, bufferSize: binaryData.byteLength || binaryData.length, sourceUrl: sourceUrl.slice(0, 100)});
    try {
      var blob = new Blob([binaryData], { type: mimeType });
      var form = new FormData();
      form.append("file", blob, filename);
      form.append("sourceUrl", sourceUrl);
      form.append("sourceRunId", runId);
      form.append("sourceCollectorId", COLLECTOR_ID);
      if (transactionId) {
        form.append("transactionId", transactionId);
      }

      // Get auth token from learnRuns, replayRuns, or runs
      var token = null;
      if (learnRuns[runId] && learnRuns[runId].authToken) {
        token = learnRuns[runId].authToken;
      } else if (replayRuns[runId] && replayRuns[runId].authToken) {
        token = replayRuns[runId].authToken;
      } else if (runs[runId] && runs[runId].authToken) {
        token = runs[runId].authToken;
      }

      var headers = {};
      if (token) {
        headers["Authorization"] = "Bearer " + token;
      }
      if (runs[runId]) {
        runs[runId].inflightUploads = (runs[runId].inflightUploads || 0) + 1;
        countedUpload = true;
      }

      console.log("[FiBuKI] Uploading to " + appBaseUrl + "/api/browser/upload..." + (token ? " (with auth)" : " (NO auth)"));
      fetch(getApiUrl("/api/browser/upload"), {
        method: "POST",
        headers: headers,
        body: form,
      })
        .then(function (resp) {
          console.log("[FiBuKI] Upload response status:", resp.status);
          if (!resp.ok) {
            return resp.text().then(function(t) { throw new Error("Upload failed: " + resp.status + " " + t); });
          }
          return resp.json();
        })
        .then(function (data) {
          console.log("[FiBuKI] Upload SUCCESS:", filename, data);
          recordPdfSource(sourceUrl);
          if (!runs[runId]) {
            console.warn("[FiBuKI] Run no longer exists:", runId);
            return;
          }
          runs[runId].downloadedCount = (runs[runId].downloadedCount || 0) + 1;
          sendToTab(runs[runId].appTabId, {
            type: "TS_PULL_RESULTS",
            runId: runId,
            urls: runs[runId].urls || [],
            foundCount: runs[runId].foundCount || 0,
            downloadedCount: runs[runId].downloadedCount || 0,
          });
          sendToTab(runs[runId].appTabId, {
            type: "TS_FILE_UPLOADED",
            runId: runId,
            filename: filename,
            sourceUrl: sourceUrl,
          });
          sendToTab(runs[runId].tabId, {
            type: "TS_FILE_UPLOADED",
            runId: runId,
            filename: filename,
            sourceUrl: sourceUrl,
          });
          // Notify learn mode if this upload belongs to an active learn run
          if (learnRuns[runId]) {
            learnRuns[runId].pdfCount = (learnRuns[runId].pdfCount || 0) + 1;
            sendToTab(learnRuns[runId].tabId, { type: "TS_LEARN_PDF_DETECTED", runId: runId, sourceUrl: sourceUrl });
            if (learnRuns[runId].appTabId) {
              sendToTab(learnRuns[runId].appTabId, { type: "TS_LEARN_PDF", runId: runId, sourceUrl: sourceUrl });
            }
          }
          // Notify replay mode if this upload belongs to an active replay run
          if (replayRuns[runId]) {
            sendToTab(replayRuns[runId].tabId, { type: "TS_REPLAY_PDF_DOWNLOADED", runId: runId, sourceUrl: sourceUrl });
            if (replayRuns[runId].appTabId) {
              sendToTab(replayRuns[runId].appTabId, { type: "TS_REPLAY_PDF_DOWNLOADED", runId: runId, sourceUrl: sourceUrl });
            }
          }
        })
        .catch(function (err) {
          console.warn("[FiBuKI] Upload error:", err);
        })
        .finally(function () {
          if (countedUpload && runs[runId]) {
            runs[runId].inflightUploads = Math.max(0, (runs[runId].inflightUploads || 1) - 1);
          }
          maybeCleanupPullRun(runId, "upload_complete");
        });
    } catch (err) {
      console.warn("[FiBuKI] Upload error:", err);
      if (countedUpload && runs[runId]) {
        runs[runId].inflightUploads = Math.max(0, (runs[runId].inflightUploads || 1) - 1);
      }
      maybeCleanupPullRun(runId, "upload_error");
    }
  }

  function normalizeUrl(url) {
    try {
      var parsed = new URL(url);
      return parsed.origin + parsed.pathname;
    } catch (err) {
      return null;
    }
  }

  function recordPdfSource(url) {
    var normalized = normalizeUrl(url);
    if (!normalized) return;
    var origin = normalized.split("/").slice(0, 3).join("/");
    if (!pdfHistory[origin]) {
      pdfHistory[origin] = [];
    }
    if (pdfHistory[origin].indexOf(normalized) === -1) {
      pdfHistory[origin].push(normalized);
      if (pdfHistory[origin].length > 50) {
        pdfHistory[origin] = pdfHistory[origin].slice(-50);
      }
      chrome.storage.local.set({ ts_pdf_history: pdfHistory });
    }
  }

  function preferKnownPdfUrls(urls) {
    var matches = [];
    urls.forEach(function (url) {
      var normalized = normalizeUrl(url);
      if (!normalized) return;
      var origin = normalized.split("/").slice(0, 3).join("/");
      var list = pdfHistory[origin] || [];
      if (list.indexOf(normalized) !== -1) {
        matches.push(url);
      }
    });
    return matches;
  }

  // Clean up runs[]/activeTabRuns[] entries for a replay or learn runId
  function cleanupRunRegistration(runId) {
    if (!runs[runId]) return;
    if (runs[runId].cleanupTimer) {
      clearTimeout(runs[runId].cleanupTimer);
      runs[runId].cleanupTimer = null;
    }
    if (runs[runId].tabId) delete activeTabRuns[runs[runId].tabId];
    (runs[runId].downloadTabIds || []).forEach(function(tid) { delete activeTabRuns[tid]; });
    delete runs[runId];
  }

  // Clean up pull runs when their tabs close, so stale run state can't keep interception active.
  chrome.tabs.onRemoved.addListener(function (tabId) {
    var runId = findRunIdByTab(tabId);
    if (!runId || !runs[runId]) return;
    var run = runs[runId];
    if (!isPullRun(run)) return;

    if (run.tabId === tabId) {
      delete activeTabRuns[tabId];
      run.tabId = null;
      if (Array.isArray(run.downloadTabIds)) {
        run.downloadTabIds = run.downloadTabIds.filter(function (tid) {
          return tid !== tabId;
        });
      }
      markPullRunCompleted(runId, "tab_closed");
      maybeCleanupPullRun(runId, "tab_closed");
      return;
    }

    if (Array.isArray(run.downloadTabIds) && run.downloadTabIds.indexOf(tabId) !== -1) {
      run.downloadTabIds = run.downloadTabIds.filter(function (tid) {
        return tid !== tabId;
      });
      delete activeTabRuns[tabId];
      maybeCleanupPullRun(runId, "child_tab_closed");
    }
  });

  // ============================================================================
  // LEARN MODE handlers
  // ============================================================================

  function findLearnRunByTab(tabId) {
    var ids = Object.keys(learnRuns);
    for (var i = 0; i < ids.length; i++) {
      var run = learnRuns[ids[i]];
      if (run.tabId === tabId) return ids[i];
      // Also check child tabs (opened from the learn tab for downloads)
      if (run.childTabIds && run.childTabIds.indexOf(tabId) !== -1) return ids[i];
    }
    return null;
  }

  // TS_START_LEARN: App tab asks to start learn mode
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "TS_START_LEARN") return;
    if (message.appOrigin) setAppBaseUrl(message.appOrigin);
    var partnerId = message.partnerId;
    var partnerName = message.partnerName || "";
    var transactionId = message.transactionId || null;
    var startUrl = message.startUrl || null;
    var authToken = message.authToken || null;
    if (!partnerId) return;

    var runId = "learn_" + Date.now();
    var appTabId = sender.tab ? sender.tab.id : null;

    learnRuns[runId] = {
      tabId: null,
      appTabId: appTabId,
      partnerId: partnerId,
      partnerName: partnerName,
      transactionId: transactionId,
      pdfCount: 0,
      childTabIds: [],
      authToken: authToken,
    };

    console.log("[FiBuKI] TS_START_LEARN", runId, partnerId, partnerName);

    // Acknowledge receipt so content script knows background is alive
    sendResponse({ ok: true, runId: runId });

    // Open a new tab for the user to navigate
    var openUrl = startUrl || "about:blank";
    chrome.tabs.create({ url: openUrl, active: true }, function (tab) {
      if (!tab || typeof tab.id !== "number") return;
      learnRuns[runId].tabId = tab.id;

      // Register in runs[] so findRunIdByTab() and download attribution work
      runs[runId] = {
        tabId: tab.id, downloadTabIds: [], attemptedUrls: {},
        openedDownloadUrls: {}, appTabId: appTabId,
        foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false,
        isLearnRun: true,
      };
      activeTabRuns[tab.id] = runId;

      // Notify the app tab that learn mode started
      if (appTabId) {
        sendToTab(appTabId, {
          type: "TS_LEARN_STARTED",
          runId: runId,
          partnerId: partnerId,
        });
      }

      // Wait for the tab to load, then tell it to enter learn mode
      setTimeout(function () {
        sendToTab(tab.id, {
          type: "TS_START_LEARN_TAB",
          runId: runId,
          partnerId: partnerId,
          partnerName: partnerName,
          transactionId: transactionId,
        });
      }, 1500);
    });
  });

  // TS_LEARN_ACTION: Content script reports a recorded action
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_LEARN_ACTION") return;
    // Forward to app tab
    var tabId = sender.tab ? sender.tab.id : null;
    var runId = tabId ? findLearnRunByTab(tabId) : null;
    if (!runId || !learnRuns[runId]) return;

    if (learnRuns[runId].appTabId) {
      sendToTab(learnRuns[runId].appTabId, {
        type: "TS_LEARN_ACTION",
        runId: runId,
        action: message.action,
      });
    }
  });

  // TS_LEARN_COMPLETE: Content script reports learn mode finished
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_LEARN_COMPLETE") return;
    var tabId = sender.tab ? sender.tab.id : null;
    var runId = tabId ? findLearnRunByTab(tabId) : null;
    if (!runId || !learnRuns[runId]) return;

    console.log("[FiBuKI] TS_LEARN_COMPLETE", runId, (message.actions || []).length, "actions", message.pdfCount, "PDFs");

    // Forward to app tab
    if (learnRuns[runId].appTabId) {
      sendToTab(learnRuns[runId].appTabId, {
        type: "TS_LEARN_COMPLETE",
        runId: runId,
        partnerId: learnRuns[runId].partnerId,
        transactionId: learnRuns[runId].transactionId,
        actions: message.actions || [],
        pdfCount: message.pdfCount || 0,
        invoiceListUrl: message.invoiceListUrl || null,
      });
    }

    // Auto-close the learn tab
    var learnTabId = learnRuns[runId].tabId;
    setTimeout(function () {
      try { chrome.tabs.remove(learnTabId); } catch (e) {}
    }, 500);

    // Clean up
    cleanupRunRegistration(runId);
    delete learnRuns[runId];
  });

  // Track child tabs opened from learn tabs (e.g. PDF download in new tab)
  chrome.webNavigation.onCreatedNavigationTarget.addListener(function (details) {
    var sourceTabId = details.sourceTabId;
    var newTabId = details.tabId;
    var learnRunId = findLearnRunByTab(sourceTabId);
    if (!learnRunId || !learnRuns[learnRunId]) return;
    console.log("[FiBuKI] Learn child tab opened:", newTabId, "from:", sourceTabId, "url:", details.url);
    learnRuns[learnRunId].childTabIds.push(newTabId);
    activeTabRuns[newTabId] = learnRunId;
    if (runs[learnRunId]) {
      if (!runs[learnRunId].downloadTabIds) runs[learnRunId].downloadTabIds = [];
      runs[learnRunId].downloadTabIds.push(newTabId);
    }
  });

  // Detect learn tab or child tab closed
  chrome.tabs.onRemoved.addListener(function (tabId) {
    var runId = findLearnRunByTab(tabId);
    if (!runId || !learnRuns[runId]) return;

    // If it's a child tab closing, just remove it from the list (not the main learn tab)
    var childIdx = learnRuns[runId].childTabIds.indexOf(tabId);
    if (childIdx !== -1) {
      learnRuns[runId].childTabIds.splice(childIdx, 1);
      console.log("[FiBuKI] Learn child tab closed:", tabId);
      return;
    }

    // Main learn tab closed — notify app and clean up
    console.log("[FiBuKI] Learn tab closed:", runId);
    if (learnRuns[runId].appTabId) {
      sendToTab(learnRuns[runId].appTabId, {
        type: "TS_LEARN_COMPLETE",
        runId: runId,
        partnerId: learnRuns[runId].partnerId,
        transactionId: learnRuns[runId].transactionId,
        actions: [],
        pdfCount: 0,
        tabClosed: true,
      });
    }
    cleanupRunRegistration(runId);
    delete learnRuns[runId];
  });

  // ============================================================================
  // REPLAY MODE handlers
  // ============================================================================

  function findReplayRunByTab(tabId) {
    var ids = Object.keys(replayRuns);
    for (var i = 0; i < ids.length; i++) {
      var run = replayRuns[ids[i]];
      if (run.tabId === tabId) return ids[i];
      if (run.childTabIds && run.childTabIds.indexOf(tabId) !== -1) return ids[i];
    }
    return null;
  }

  // TS_START_REPLAY: App tab asks to start replay mode
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "TS_START_REPLAY") return;
    if (message.appOrigin) setAppBaseUrl(message.appOrigin);
    var partnerId = message.partnerId;
    var partnerName = message.partnerName || "";
    var transactionId = message.transactionId || null;
    var recipe = message.recipe || null;
    var transactionAmount = message.transactionAmount || 0;
    var transactionDate = message.transactionDate || null;
    var transactionCurrency = message.transactionCurrency || "EUR";
    var authToken = message.authToken || null;
    if (!partnerId || !recipe) return;

    var runId = "replay_" + Date.now();
    var appTabId = sender.tab ? sender.tab.id : null;

    replayRuns[runId] = {
      tabId: null,
      appTabId: appTabId,
      partnerId: partnerId,
      partnerName: partnerName,
      transactionId: transactionId,
      recipe: recipe,
      transactionAmount: transactionAmount,
      transactionDate: transactionDate,
      transactionCurrency: transactionCurrency,
      childTabIds: [],
      status: "starting",
      authToken: authToken,
    };

    console.log("[FiBuKI] TS_START_REPLAY", runId, partnerId, partnerName);

    sendResponse({ ok: true, runId: runId });

    // Open a new tab at the recipe start URL
    var openUrl = recipe.startUrl || "about:blank";
    chrome.tabs.create({ url: openUrl, active: true }, function (tab) {
      if (!tab || typeof tab.id !== "number") return;
      replayRuns[runId].tabId = tab.id;

      // Register in runs[] so findRunIdByTab() and download attribution work
      runs[runId] = {
        tabId: tab.id, downloadTabIds: [], attemptedUrls: {},
        openedDownloadUrls: {}, appTabId: appTabId,
        foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false,
        isReplayRun: true,
      };
      activeTabRuns[tab.id] = runId;

      // Notify the app tab
      if (appTabId) {
        sendToTab(appTabId, {
          type: "TS_REPLAY_STARTED",
          runId: runId,
          partnerId: partnerId,
        });
      }

      // Wait for tab to load, then tell it to start replaying
      setTimeout(function () {
        sendToTab(tab.id, {
          type: "TS_START_REPLAY_TAB",
          runId: runId,
          partnerId: partnerId,
          partnerName: partnerName,
          transactionId: transactionId,
          recipe: recipe,
          transactionAmount: transactionAmount,
          transactionDate: transactionDate,
          transactionCurrency: transactionCurrency,
        });
      }, 2000);
    });
  });

  // TS_REPLAY_PROGRESS: Content script reports progress
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_REPLAY_PROGRESS") return;
    var tabId = sender.tab ? sender.tab.id : null;
    var runId = tabId ? findReplayRunByTab(tabId) : null;
    if (!runId || !replayRuns[runId]) return;

    // Track the current step for resume-after-navigation
    if (typeof message.step === "number") {
      replayRuns[runId].currentStep = message.step;
    }

    if (replayRuns[runId].appTabId) {
      sendToTab(replayRuns[runId].appTabId, {
        type: "TS_REPLAY_PROGRESS",
        runId: runId,
        step: message.step,
        total: message.total,
        message: message.message,
      });
    }
  });

  // TS_REPLAY_SUCCESS: Content script reports success
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_REPLAY_SUCCESS") return;
    var tabId = sender.tab ? sender.tab.id : null;
    var runId = tabId ? findReplayRunByTab(tabId) : null;
    if (!runId || !replayRuns[runId]) return;

    console.log("[FiBuKI] TS_REPLAY_SUCCESS", runId);
    replayRuns[runId].status = "success";

    if (replayRuns[runId].appTabId) {
      sendToTab(replayRuns[runId].appTabId, {
        type: "TS_REPLAY_SUCCESS",
        runId: runId,
        result: message.result || {},
      });
    }

    // Auto-close replay tab after success (3s delay)
    var replayTabId = replayRuns[runId].tabId;
    setTimeout(function () {
      try { chrome.tabs.remove(replayTabId); } catch (e) {}
    }, 3000);

    // Clean up after a delay (let download complete)
    setTimeout(function () {
      cleanupRunRegistration(runId);
      delete replayRuns[runId];
    }, 10000);
  });

  // TS_REPLAY_FAILED: Content script reports failure
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_REPLAY_FAILED") return;
    var tabId = sender.tab ? sender.tab.id : null;
    var runId = tabId ? findReplayRunByTab(tabId) : null;
    if (!runId || !replayRuns[runId]) return;

    console.log("[FiBuKI] TS_REPLAY_FAILED", runId, message.result);
    replayRuns[runId].status = "failed";

    if (replayRuns[runId].appTabId) {
      sendToTab(replayRuns[runId].appTabId, {
        type: "TS_REPLAY_FAILED",
        runId: runId,
        result: message.result || {},
      });
    }

    // Auto-close replay tab after failure (10s delay so user can inspect)
    var failedTabId = replayRuns[runId].tabId;
    setTimeout(function () {
      try { chrome.tabs.remove(failedTabId); } catch (e) {}
    }, 10000);

    cleanupRunRegistration(runId);
    delete replayRuns[runId];
  });

  // TS_REPLAY_AUTH_REQUIRED: Content script needs user to log in
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_REPLAY_AUTH_REQUIRED") return;
    var tabId = sender.tab ? sender.tab.id : null;
    var runId = tabId ? findReplayRunByTab(tabId) : null;
    if (!runId || !replayRuns[runId]) return;

    replayRuns[runId].status = "auth_required";
    showLoginNotification(runId, message.url || "");

    if (replayRuns[runId].appTabId) {
      sendToTab(replayRuns[runId].appTabId, {
        type: "TS_REPLAY_AUTH_REQUIRED",
        runId: runId,
      });
    }
  });

  // TS_REPLAY_TIER2_NEEDED: Content script in replay tab needs LLM agent help
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_REPLAY_TIER2_NEEDED") return;
    var tabId = sender.tab ? sender.tab.id : null;
    var runId = tabId ? findReplayRunByTab(tabId) : null;
    if (!runId || !replayRuns[runId]) return;

    // Track agent iterations centrally (survives page navigations that recreate the state machine)
    if (typeof replayRuns[runId].agentIterations !== "number") {
      replayRuns[runId].agentIterations = 0;
    }
    replayRuns[runId].agentIterations++;

    console.log("[FiBuKI] TS_REPLAY_TIER2_NEEDED", runId, "step:", message.failedAtStep, "iteration:", replayRuns[runId].agentIterations);

    // Hard cap: stop after 15 Tier 2 iterations across all navigations
    if (replayRuns[runId].agentIterations > 15) {
      console.log("[FiBuKI] Tier 2 iteration limit reached, failing replay:", runId);
      replayRuns[runId].status = "failed";
      if (replayRuns[runId].appTabId) {
        sendToTab(replayRuns[runId].appTabId, {
          type: "TS_REPLAY_FAILED",
          runId: runId,
          result: {
            status: "failed_timeout",
            tier: 2,
            durationMs: 0,
            transactionId: replayRuns[runId].transactionId,
            agentIterations: replayRuns[runId].agentIterations,
          },
        });
      }
      // Tell replay tab to stop
      if (replayRuns[runId].tabId) {
        sendToTab(replayRuns[runId].tabId, {
          type: "TS_REPLAY_FAILED",
          runId: runId,
          result: { status: "failed_timeout", tier: 2 },
        });
      }
      return;
    }

    replayRuns[runId].status = "tier2";

    // Forward to app tab so the frontend hook can call the replay-agent API
    if (replayRuns[runId].appTabId) {
      sendToTab(replayRuns[runId].appTabId, {
        type: "TS_REPLAY_TIER2_NEEDED",
        runId: runId,
        failedAtStep: message.failedAtStep,
        snapshot: message.snapshot,
        transactionId: message.transactionId,
        transactionAmount: message.transactionAmount,
        transactionDate: message.transactionDate,
        transactionCurrency: message.transactionCurrency,
        partnerName: message.partnerName,
        recipe: message.recipe,
      });
    }
  });

  // TS_REPLAY_TIER2_COMMANDS: App tab sends LLM agent commands to replay tab
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_REPLAY_TIER2_COMMANDS") return;
    var runId = message.runId;
    if (!runId || !replayRuns[runId]) return;

    console.log("[FiBuKI] TS_REPLAY_TIER2_COMMANDS", runId, (message.commands || []).length, "commands");

    // Forward commands to the replay tab
    if (replayRuns[runId].tabId) {
      sendToTab(replayRuns[runId].tabId, {
        type: "TS_REPLAY_TIER2_COMMANDS",
        commands: message.commands || [],
        isDone: message.isDone || false,
      });
    }
  });

  // TS_REPLAY_NO_MATCH: Content script reports no matching invoice found
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_REPLAY_NO_MATCH") return;
    var tabId = sender.tab ? sender.tab.id : null;
    var runId = tabId ? findReplayRunByTab(tabId) : null;

    var notifId = "ts_nomatch_" + (runId || Date.now());
    chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "FiBuKI: Invoice Not Found",
      message: "No matching invoice found for this transaction.",
      buttons: [{ title: "Show Page" }, { title: "Dismiss" }],
      priority: 2,
      requireInteraction: true,
    });
  });

  // Handle notification button clicks (both login and no-match)
  chrome.notifications.onButtonClicked.addListener(function (notifId, btnIndex) {
    if (notifId.indexOf("ts_nomatch_") === 0) {
      var noMatchRunId = notifId.replace("ts_nomatch_", "");
      if (btnIndex === 0 && replayRuns[noMatchRunId] && replayRuns[noMatchRunId].tabId) {
        // "Show Page" — focus the replay tab
        try { chrome.tabs.update(replayRuns[noMatchRunId].tabId, { active: true }); } catch (e) {}
      }
      chrome.notifications.clear(notifId);
    }
  });

  // Track child tabs opened from replay tabs
  chrome.webNavigation.onCreatedNavigationTarget.addListener(function (details) {
    var sourceTabId = details.sourceTabId;
    var newTabId = details.tabId;
    var replayRunId = findReplayRunByTab(sourceTabId);
    if (!replayRunId || !replayRuns[replayRunId]) return;
    console.log("[FiBuKI] Replay child tab opened:", newTabId, "from:", sourceTabId);
    replayRuns[replayRunId].childTabIds.push(newTabId);
    activeTabRuns[newTabId] = replayRunId;
    if (runs[replayRunId]) {
      if (!runs[replayRunId].downloadTabIds) runs[replayRunId].downloadTabIds = [];
      runs[replayRunId].downloadTabIds.push(newTabId);
    }
  });

  // Detect replay tab closed
  chrome.tabs.onRemoved.addListener(function (tabId) {
    var runId = findReplayRunByTab(tabId);
    if (!runId || !replayRuns[runId]) return;

    // Child tab closing
    var childIdx = replayRuns[runId].childTabIds.indexOf(tabId);
    if (childIdx !== -1) {
      replayRuns[runId].childTabIds.splice(childIdx, 1);
      return;
    }

    // Main replay tab closed
    console.log("[FiBuKI] Replay tab closed:", runId);
    if (replayRuns[runId].appTabId) {
      sendToTab(replayRuns[runId].appTabId, {
        type: "TS_REPLAY_FAILED",
        runId: runId,
        result: { status: "failed_timeout", tier: 1, durationMs: 0, transactionId: replayRuns[runId].transactionId, tabClosed: true },
      });
    }
    cleanupRunRegistration(runId);
    delete replayRuns[runId];
  });

  // Re-send replay config when replay tab navigates
  chrome.webNavigation.onCompleted.addListener(function (details) {
    if (details.frameId !== 0) return;
    var tabId = details.tabId;
    var replayRunId = findReplayRunByTab(tabId);
    if (!replayRunId || !replayRuns[replayRunId]) return;
    if (replayRuns[replayRunId].tabId !== tabId) return;

    // Only re-send if status is not already done
    if (replayRuns[replayRunId].status === "success" || replayRuns[replayRunId].status === "failed") return;

    // Calculate resumeFromStep: navigation means the current step's click succeeded
    var resumeFromStep = 0;
    if (typeof replayRuns[replayRunId].currentStep === "number") {
      resumeFromStep = replayRuns[replayRunId].currentStep + 1;
    }

    sendToTab(tabId, {
      type: "TS_START_REPLAY_TAB",
      runId: replayRunId,
      partnerId: replayRuns[replayRunId].partnerId,
      partnerName: replayRuns[replayRunId].partnerName,
      transactionId: replayRuns[replayRunId].transactionId,
      recipe: replayRuns[replayRunId].recipe,
      transactionAmount: replayRuns[replayRunId].transactionAmount,
      transactionDate: replayRuns[replayRunId].transactionDate,
      transactionCurrency: replayRuns[replayRunId].transactionCurrency,
      resumeFromStep: resumeFromStep,
      agentIterations: replayRuns[replayRunId].agentIterations || 0,
    });
  });

  // Intercept downloads during replay — upload with transactionId
  // (Piggyback on existing download listener: check learnRunId first, then replayRunId)

  // Network-level PDF detection for learn/replay mode (catches inline PDF responses before download)
  chrome.webRequest.onHeadersReceived.addListener(
    function (details) {
      if (details.type !== "main_frame" && details.type !== "sub_frame") return;
      var tabId = details.tabId;
      if (tabId < 0) return;

      var learnRunId = findLearnRunByTab(tabId);
      var replayRunId = findReplayRunByTab(tabId);
      if ((!learnRunId || !learnRuns[learnRunId]) && (!replayRunId || !replayRuns[replayRunId])) return;

      // Check Content-Type for PDF
      var headers = details.responseHeaders || [];
      var isPdf = false;
      for (var i = 0; i < headers.length; i++) {
        if (headers[i].name.toLowerCase() === "content-type") {
          isPdf = (headers[i].value || "").toLowerCase().indexOf("pdf") !== -1;
          break;
        }
      }
      if (!isPdf) return;

      var url = details.url;
      if (seenDownloadUrls[url]) return;

      // For learn tabs: proactively fetch and upload the PDF
      if (learnRunId && learnRuns[learnRunId]) {
        console.log("[FiBuKI] Network PDF detected in learn tab:", url.slice(0, 100));
        var learnTxId = learnRuns[learnRunId].transactionId;

        // Create a temp runs entry so uploadBuffer works (fallback if not already registered)
        if (!runs[learnRunId]) {
          runs[learnRunId] = {
            tabId: learnRuns[learnRunId].tabId,
            downloadTabIds: [],
            attemptedUrls: {},
            openedDownloadUrls: {},
            appTabId: learnRuns[learnRunId].appTabId,
            foundCount: 0,
            downloadedCount: 0,
            urls: [],
            overlaySent: false,
            isLearnRun: true,
          };
        }

        fetchAndUploadPdfDirect(learnRunId, url, learnTxId);
      }

      // For replay tabs: proactively fetch and upload the PDF
      if (replayRunId && replayRuns[replayRunId]) {
        console.log("[FiBuKI] Network PDF detected in replay tab:", url.slice(0, 100));
        var transactionId = replayRuns[replayRunId].transactionId;
        fetchAndUploadPdfDirect(replayRunId, url, transactionId);

        // Also create a temp runs entry so uploadBuffer works (fallback if not already registered)
        if (!runs[replayRunId]) {
          runs[replayRunId] = {
            tabId: replayRuns[replayRunId].tabId,
            downloadTabIds: [],
            attemptedUrls: {},
            openedDownloadUrls: {},
            appTabId: replayRuns[replayRunId].appTabId,
            foundCount: 0,
            downloadedCount: 0,
            urls: [],
            overlaySent: false,
            isReplayRun: true,
          };
        }
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  // Intercept downloads during learn mode — upload with transactionId
  // Piggyback on existing download listener by checking if the tab belongs to a learn run
  var origDownloadHandler = chrome.downloads.onCreated._listeners;

  // Add learn-mode-aware PDF upload for downloads from learn tabs
  chrome.webNavigation.onCompleted.addListener(function (details) {
    if (details.frameId !== 0) return;
    var tabId = details.tabId;
    var learnRunId = findLearnRunByTab(tabId);
    if (!learnRunId || !learnRuns[learnRunId]) return;

    // Re-send learn mode setup when tab navigates (SPA soft navs handled by content script)
    sendToTab(tabId, {
      type: "TS_START_LEARN_TAB",
      runId: learnRunId,
      partnerId: learnRuns[learnRunId].partnerId,
      partnerName: learnRuns[learnRunId].partnerName,
      transactionId: learnRuns[learnRunId].transactionId,
    });
  });
})();
