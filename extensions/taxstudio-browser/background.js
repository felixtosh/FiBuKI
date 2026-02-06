(function () {
  var runs = {};
  var COLLECTOR_ID = "basic";
  var seenDownloadUrls = {};
  var injectedTabs = {};
  var activeTabRuns = {};
  var pdfHistory = {};
  var DEBUG_LOG_URL = "http://localhost:3000/api/browser/log";

  // Learn mode state
  var learnRuns = {}; // { runId: { tabId, appTabId, partnerId, partnerName, transactionId, pdfCount } }
  console.log("[FiBuKI] Background service worker loaded");

  // Track URLs we've already started processing
  var processingUrls = {};

  // Watch for new tabs being created with PDF URLs (fires earliest)
  if (chrome.webNavigation && chrome.webNavigation.onCreatedNavigationTarget) {
    chrome.webNavigation.onCreatedNavigationTarget.addListener(function(details) {
      var url = details.url || "";
      var lowerUrl = url.toLowerCase();

      var isPdfUrl = lowerUrl.indexOf("payments.google.com") !== -1 &&
                     (lowerUrl.indexOf("apis-secure/doc") !== -1 || lowerUrl.indexOf("?doc=") !== -1);

      if (!isPdfUrl) return;

      var activeRunIds = Object.keys(runs).filter(function(rid) {
        return runs[rid] && !runs[rid].pausedForLogin;
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
        return runs[rid] && !runs[rid].pausedForLogin;
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
        return runs[rid] && !runs[rid].pausedForLogin;
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
    fetch(DEBUG_LOG_URL, {
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
      ["ts_pdf_history", "ts_dev_extractor_url", "ts_dev_extractor_enabled"],
      function (result) {
      if (result && result.ts_pdf_history) {
        pdfHistory = result.ts_pdf_history;
      }
      if (!result || typeof result.ts_dev_extractor_enabled !== "boolean") {
        chrome.storage.local.set({
          ts_dev_extractor_enabled: true,
          ts_dev_extractor_url: "http://localhost:3000/api/browser/extractor",
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
      iconUrl: "icons/icon48.png",
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
    console.log("[FiBuKI] TS_START_PULL", message.runId, message.url);
    var runId = message.runId;
    var url = message.url;
    if (!runId || !url) return;
    runs[runId] = {
      tabId: null,
      downloadTabIds: [],
      attemptedUrls: {},
      openedDownloadUrls: {},
      appTabId: sender.tab ? sender.tab.id : null,
      foundCount: 0,
      downloadedCount: 0,
      urls: [],
      overlaySent: false,
    };
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
      sendResponse({ runId: null });
      return false;
    }
    var runId = activeTabRuns[sender.tab.id] || null;
    console.log("[FiBuKI] TS_CHECK_ACTIVE_RUN tab", sender.tab.id, "->", runId);
    sendResponse({ runId: runId });
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
    if (!runId || !runs[runId]) return;
    var buffer = message.buffer;
    var filename = message.filename || "invoice.pdf";
    var mimeType = message.mimeType || "application/pdf";
    var sourceUrl = message.sourceUrl || "";
    if (!buffer) return;
    uploadBuffer(runId, buffer, filename, mimeType, sourceUrl);
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "TS_DOWNLOAD_URLS") return;
    console.log("[FiBuKI] TS_DOWNLOAD_URLS", message.runId, (message.urls || []).length);
    var runId = message.runId;
    var urls = message.urls || [];
    var pageOrigin = message.pageOrigin || "";
    if (!runId || !runs[runId]) return;
    if (!urls.length) {
      if (runs[runId].appTabId) {
        sendToTab(runs[runId].appTabId, {
          type: "TS_PULL_EVENT",
          runId: runId,
          status: "completed",
        });
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
    var url = message.url || "http://localhost:3000/api/browser/extractor";
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

    // Check if this download is from a learn mode tab first
    var learnRunId = null;
    var learnTransactionId = null;
    if (item && typeof item.tabId === "number" && item.tabId > 0) {
      learnRunId = findLearnRunByTab(item.tabId);
      if (learnRunId && learnRuns[learnRunId]) {
        learnTransactionId = learnRuns[learnRunId].transactionId;
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
        return runs[rid] && !runs[rid].pausedForLogin;
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
        console.log("[FiBuKI] Download from learn mode tab, creating temp run:", learnRunId);
        runId = learnRunId;
        runs[runId] = { tabId: learnRuns[learnRunId].tabId, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: learnRuns[learnRunId].appTabId, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false };
      } else {
        // Even without an active run, if it's a document from a billing site, try to capture it
        var lowerUrl2 = (url || "").toLowerCase();
        var isBillingDocument = (lowerUrl2.indexOf("payments.google.com") !== -1 ||
                                 lowerUrl2.indexOf("admin.google.com") !== -1) &&
                                (lowerUrl2.indexOf("/doc") !== -1 || lowerUrl2.indexOf("?doc=") !== -1);
        if (isBillingDocument) {
          console.log("[FiBuKI] No active run but capturing billing document anyway:", url.slice(0, 100));
          runId = "orphan-" + Date.now();
          runs[runId] = { tabId: null, downloadTabIds: [], attemptedUrls: {}, openedDownloadUrls: {}, appTabId: null, foundCount: 0, downloadedCount: 0, urls: [], overlaySent: false };
        } else {
          console.log("[FiBuKI] Download not captured - no active run and not a billing document");
          return;
        }
      }
    }
    if (!url || url.indexOf("http") !== 0) return;
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
          uploadBuffer(runId, buf, filename, mime || "application/pdf", url, learnTransactionId);
          // If this was a learn mode download, notify the content tab
          if (learnRunId && learnRuns[learnRunId]) {
            learnRuns[learnRunId].pdfCount = (learnRuns[learnRunId].pdfCount || 0) + 1;
            sendToTab(learnRuns[learnRunId].tabId, { type: "TS_LEARN_PDF_DETECTED", runId: learnRunId, sourceUrl: url });
            if (learnRuns[learnRunId].appTabId) {
              sendToTab(learnRuns[learnRunId].appTabId, { type: "TS_LEARN_PDF", runId: learnRunId, sourceUrl: url });
            }
          }
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
    console.log("[FiBuKI] uploadBuffer called:", {runId: runId, filename: filename, mimeType: mimeType, bufferSize: buffer.byteLength, sourceUrl: sourceUrl.slice(0, 100)});
    try {
      var blob = new Blob([buffer], { type: mimeType });
      var form = new FormData();
      form.append("file", blob, filename);
      form.append("sourceUrl", sourceUrl);
      form.append("sourceRunId", runId);
      form.append("sourceCollectorId", COLLECTOR_ID);
      if (transactionId) {
        form.append("transactionId", transactionId);
      }

      console.log("[FiBuKI] Uploading to localhost:3000/api/browser/upload...");
      fetch("http://localhost:3000/api/browser/upload", {
        method: "POST",
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
        })
        .catch(function (err) {
          console.warn("[FiBuKI] Upload error:", err);
        });
    } catch (err) {
      console.warn("[FiBuKI] Upload error:", err);
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

  // ============================================================================
  // LEARN MODE handlers
  // ============================================================================

  function findLearnRunByTab(tabId) {
    var ids = Object.keys(learnRuns);
    for (var i = 0; i < ids.length; i++) {
      if (learnRuns[ids[i]].tabId === tabId) return ids[i];
    }
    return null;
  }

  // TS_START_LEARN: App tab asks to start learn mode
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== "TS_START_LEARN") return;
    var partnerId = message.partnerId;
    var partnerName = message.partnerName || "";
    var transactionId = message.transactionId || null;
    var startUrl = message.startUrl || null;
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
    };

    console.log("[FiBuKI] TS_START_LEARN", runId, partnerId, partnerName);

    // Open a new tab for the user to navigate
    var openUrl = startUrl || "about:blank";
    chrome.tabs.create({ url: openUrl, active: true }, function (tab) {
      if (!tab || typeof tab.id !== "number") return;
      learnRuns[runId].tabId = tab.id;

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
      });
    }

    // Clean up
    delete learnRuns[runId];
  });

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
