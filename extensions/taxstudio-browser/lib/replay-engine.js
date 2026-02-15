/**
 * Browser Replay Engine — Tier 1 deterministic replay of recorded browser recipes.
 * Tier 2 LLM fallback is triggered from content.js when Tier 1 fails.
 *
 * This engine replays recorded actions (clicks, navigates, types) to navigate
 * a billing portal and download an invoice matching a specific transaction.
 */
(function () {
  "use strict";

  var REPLAY_OVERLAY_ID = "taxstudio-replay-overlay";
  var AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  // ============================================================================
  // Element Finder — resilient element matching using multiple strategies
  // ============================================================================

  /**
   * Find an element on the page matching a clickTarget descriptor.
   * Priority: text > ariaLabel > href > contextText+tag > selector
   * Returns the best matching DOM element, or null.
   */
  function findElement(clickTarget) {
    if (!clickTarget) return null;

    // Strategy 1: Exact text match
    if (clickTarget.text) {
      var byText = findByText(clickTarget.text, clickTarget.tagName);
      if (byText) return byText;
    }

    // Strategy 2: Aria label
    if (clickTarget.ariaLabel) {
      var byAria = findByAriaLabel(clickTarget.ariaLabel);
      if (byAria) return byAria;
    }

    // Strategy 3: Href (for links)
    if (clickTarget.href) {
      var byHref = findByHref(clickTarget.href);
      if (byHref) return byHref;
    }

    // Strategy 4: Context text + tag (find heading, then look for element nearby)
    if (clickTarget.contextText && clickTarget.tagName) {
      var byContext = findByContext(clickTarget.contextText, clickTarget.tagName, clickTarget.text);
      if (byContext) return byContext;
    }

    // Strategy 5: CSS selector (brittle fallback)
    if (clickTarget.selector) {
      try {
        var bySelector = document.querySelector(clickTarget.selector);
        if (bySelector && isVisible(bySelector)) return bySelector;
      } catch (e) {
        // Invalid selector
      }
    }

    // Strategy 6: Fuzzy text match (partial)
    if (clickTarget.text && clickTarget.text.length > 3) {
      var byFuzzy = findByFuzzyText(clickTarget.text, clickTarget.tagName);
      if (byFuzzy) return byFuzzy;
    }

    return null;
  }

  function findByText(text, tagName) {
    var normalizedTarget = normalizeText(text);
    if (!normalizedTarget) return null;

    // Try specific tag first, then broader
    var selectors = tagName
      ? [tagName, "a, button, [role='button'], [role='link'], input[type='submit']"]
      : ["a, button, [role='button'], [role='link'], input[type='submit']"];

    for (var si = 0; si < selectors.length; si++) {
      var candidates = document.querySelectorAll(selectors[si]);
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!isVisible(el)) continue;
        var elText = normalizeText((el.textContent || "").trim());
        if (elText === normalizedTarget) return el;
      }
    }
    return null;
  }

  function findByFuzzyText(text, tagName) {
    var normalizedTarget = normalizeText(text);
    if (!normalizedTarget || normalizedTarget.length < 4) return null;

    var selector = tagName || "a, button, [role='button'], [role='link']";
    var candidates = document.querySelectorAll(selector);
    var bestMatch = null;
    var bestScore = 0;

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isVisible(el)) continue;
      var elText = normalizeText((el.textContent || "").trim());
      if (!elText) continue;

      // Check if one contains the other
      if (elText.indexOf(normalizedTarget) !== -1 || normalizedTarget.indexOf(elText) !== -1) {
        var score = Math.min(normalizedTarget.length, elText.length) / Math.max(normalizedTarget.length, elText.length);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = el;
        }
      }
    }

    return bestScore > 0.5 ? bestMatch : null;
  }

  function findByAriaLabel(label) {
    var candidates = document.querySelectorAll("[aria-label]");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isVisible(el)) continue;
      if (normalizeText(el.getAttribute("aria-label")) === normalizeText(label)) {
        return el;
      }
    }
    return null;
  }

  function findByHref(href) {
    if (!href) return null;
    // Try exact match first
    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      if (!isVisible(el)) continue;
      var elHref = el.getAttribute("href") || "";
      if (elHref === href) return el;
    }
    // Try partial match (path only)
    try {
      var targetPath = new URL(href, window.location.origin).pathname;
      for (var j = 0; j < links.length; j++) {
        var el2 = links[j];
        if (!isVisible(el2)) continue;
        var elHref2 = el2.getAttribute("href") || "";
        try {
          if (new URL(elHref2, window.location.origin).pathname === targetPath) return el2;
        } catch (e) {
          // skip
        }
      }
    } catch (e) {
      // skip
    }
    return null;
  }

  function findByContext(contextText, tagName, targetText) {
    // Find the context heading
    var headings = document.querySelectorAll("h1, h2, h3, h4, [role='heading']");
    var normalizedContext = normalizeText(contextText);
    if (!normalizedContext) return null;

    for (var i = 0; i < headings.length; i++) {
      var heading = headings[i];
      if (normalizeText(heading.textContent) !== normalizedContext) continue;

      // Found the context heading — look for the target element nearby
      var parent = heading.parentElement;
      for (var depth = 0; depth < 5 && parent; depth++) {
        var candidates = parent.querySelectorAll(tagName || "a, button, [role='button']");
        for (var j = 0; j < candidates.length; j++) {
          var el = candidates[j];
          if (!isVisible(el)) continue;
          if (targetText && normalizeText(el.textContent) === normalizeText(targetText)) {
            return el;
          }
          // If no targetText, return first visible interactive element
          if (!targetText) return el;
        }
        parent = parent.parentElement;
      }
    }
    return null;
  }

  function normalizeText(text) {
    if (!text) return "";
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    return true;
  }

  // ============================================================================
  // Invoice Table Parser — find and parse invoice tables on the page
  // ============================================================================

  /**
   * Parse an invoice table from the DOM.
   * Uses heuristics: looks for <table> or repeating <div> structures,
   * classifies columns by content patterns (amount, date, download).
   */
  function parseInvoiceTable(containerHint) {
    var table = null;

    // If we have a container hint, try it first
    if (containerHint) {
      try {
        table = document.querySelector(containerHint);
      } catch (e) {
        // invalid selector
      }
    }

    // Fall back to finding tables
    if (!table) {
      var tables = document.querySelectorAll("table");
      if (tables.length === 1) {
        table = tables[0];
      } else if (tables.length > 1) {
        // Pick the table with the most rows
        var maxRows = 0;
        for (var t = 0; t < tables.length; t++) {
          var rowCount = tables[t].querySelectorAll("tr").length;
          if (rowCount > maxRows) {
            maxRows = rowCount;
            table = tables[t];
          }
        }
      }
    }

    if (!table) {
      // Try repeating div pattern (common in modern billing portals)
      return parseRepeatingDivs();
    }

    return parseHtmlTable(table);
  }

  function parseHtmlTable(tableEl) {
    var rows = tableEl.querySelectorAll("tr");
    if (rows.length < 2) return null; // Need at least header + 1 data row

    var headerRow = rows[0];
    var headerCells = headerRow.querySelectorAll("th, td");

    // Classify columns by header text and data content
    var columns = [];
    for (var c = 0; c < headerCells.length; c++) {
      var headerText = (headerCells[c].textContent || "").trim().toLowerCase();
      var semantic = classifyColumn(headerText, rows, c);
      columns.push({
        index: c,
        semantic: semantic,
        headerText: headerText,
      });
    }

    // Extract data rows
    var dataRows = [];
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll("td");
      var rowData = {};
      for (var ci = 0; ci < columns.length && ci < cells.length; ci++) {
        var col = columns[ci];
        var cellText = (cells[ci].textContent || "").trim();
        rowData[col.semantic] = cellText;

        // Check for download links/buttons in this cell
        if (col.semantic === "downloadAction" || col.semantic === "unknown") {
          var downloadEl = cells[ci].querySelector("a[href], button, [role='button']");
          if (downloadEl) {
            rowData._downloadElement = downloadEl;
            rowData._downloadHref = downloadEl.getAttribute("href") || "";
          }
        }
      }
      rowData._rowElement = rows[r];
      rowData._rowIndex = r;
      dataRows.push(rowData);
    }

    return {
      columns: columns,
      rows: dataRows,
      tableElement: tableEl,
      type: "table",
    };
  }

  function parseRepeatingDivs() {
    // Look for repeating card/row patterns that contain amounts and dates
    // Common patterns: [role="listitem"], divs with same class structure
    var listItems = document.querySelectorAll("[role='listitem'], [role='row']");
    if (listItems.length < 2) {
      // Try finding repeated class patterns
      // Look for parent containers with many similar children
      return null;
    }

    var dataRows = [];
    for (var i = 0; i < listItems.length; i++) {
      var item = listItems[i];
      var text = (item.textContent || "").trim();
      var rowData = {};

      // Try to extract amount from the text
      if (window.__tsAmountParser) {
        var amountCents = window.__tsAmountParser.parseAmount(text);
        if (amountCents !== null) {
          rowData.amount = text;
          rowData._amountCents = amountCents;
        }
      }

      // Try to extract date
      if (window.__tsDateParser) {
        // Find date-like substrings
        var datePatterns = text.match(/\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{2}-\d{2}|[A-Za-z]+ \d{1,2},? \d{4}/g);
        if (datePatterns) {
          for (var dp = 0; dp < datePatterns.length; dp++) {
            var parsed = window.__tsDateParser.parseInvoiceDate(datePatterns[dp]);
            if (parsed) {
              rowData.date = datePatterns[dp];
              rowData._parsedDate = parsed;
              break;
            }
          }
        }
      }

      // Find download links/buttons
      var downloadEl = item.querySelector(
        'a[href*="download"], a[href*="pdf"], a[href*="invoice"], ' +
        'button[aria-label*="download" i], button[aria-label*="pdf" i], ' +
        '[data-action*="download"], [role="button"]'
      );
      if (downloadEl) {
        rowData._downloadElement = downloadEl;
        rowData._downloadHref = downloadEl.getAttribute("href") || "";
      }

      rowData._rowElement = item;
      rowData._rowIndex = i;

      if (Object.keys(rowData).length > 2) { // More than just _rowElement and _rowIndex
        dataRows.push(rowData);
      }
    }

    if (dataRows.length < 1) return null;

    return {
      columns: [],
      rows: dataRows,
      tableElement: null,
      type: "divs",
    };
  }

  function classifyColumn(headerText, allRows, colIndex) {
    var header = headerText.toLowerCase();

    // Check header text
    if (/amount|betrag|summe|total|price|preis|value|wert/i.test(header)) return "amount";
    if (/date|datum|invoiced|issued|created|erstellt/i.test(header)) return "date";
    if (/description|beschreibung|details|memo|subject|betreff/i.test(header)) return "description";
    if (/download|pdf|document|dokument|action|aktion/i.test(header)) return "downloadAction";
    if (/status|state|zustand/i.test(header)) return "status";

    // If header didn't match, sample data content
    if (allRows.length > 1) {
      var sampleCells = [];
      for (var r = 1; r < Math.min(allRows.length, 4); r++) {
        var cells = allRows[r].querySelectorAll("td");
        if (cells[colIndex]) {
          sampleCells.push((cells[colIndex].textContent || "").trim());
        }
      }

      // Check if cells look like amounts
      var amountPattern = /^[€$£]?\s*-?\d{1,3}([.,]\d{3})*([.,]\d{2})?\s*(EUR|USD|GBP)?$/;
      if (sampleCells.length > 0 && sampleCells.every(function (c) { return amountPattern.test(c); })) {
        return "amount";
      }

      // Check if cells look like dates
      var datePattern = /^\d{1,2}[./]\d{1,2}[./]\d{4}$|^\d{4}-\d{2}-\d{2}$|^[A-Za-z]+ \d{1,2},? \d{4}$/;
      if (sampleCells.length > 0 && sampleCells.every(function (c) { return datePattern.test(c); })) {
        return "date";
      }

      // Check if cells contain download elements
      for (var s = 1; s < Math.min(allRows.length, 4); s++) {
        var cells2 = allRows[s].querySelectorAll("td");
        if (cells2[colIndex]) {
          var hasLink = cells2[colIndex].querySelector("a[href], button, [role='button']");
          if (hasLink) return "downloadAction";
        }
      }
    }

    return "unknown";
  }

  // ============================================================================
  // Page-Level Invoice Scan — detect invoice lists and match the right one
  // ============================================================================

  /**
   * Scan the current page for an invoice list (table or repeating dated items).
   * If found, match the best item by transaction date and amount.
   * Returns a match object with _rowElement, or null.
   */
  function scanPageForInvoiceMatch(amountCents, transactionDate) {
    if (!transactionDate) return null;

    var dateParser = window.__tsDateParser;
    var amountParser = window.__tsAmountParser;
    if (!dateParser) return null;

    // Strategy 1: Formal table parsing
    var tableData = parseInvoiceTable(null);
    if (tableData && tableData.rows && tableData.rows.length >= 2) {
      var tableMatch = matchInvoiceRow(tableData, amountCents, transactionDate, 200);
      if (tableMatch) return tableMatch;
    }

    // Strategy 2: Scan clickable elements for dated items (card/list layouts)
    var clickables = document.querySelectorAll(
      "a[href], button, [role='button'], [role='link'], [role='listitem'], [role='row']"
    );
    var candidates = [];

    for (var i = 0; i < clickables.length; i++) {
      var el = clickables[i];
      if (!isVisible(el)) continue;

      var text = (el.textContent || "").trim();
      if (!text || text.length > 300 || text.length < 3) continue;

      // Also check parent for context (invoice cards often wrap clickable items)
      var contextText = text;
      if (el.parentElement) {
        var parentText = (el.parentElement.textContent || "").trim();
        if (parentText.length <= 500) contextText = parentText;
      }

      // Try to extract a date
      var date = dateParser.parseInvoiceDate(text) || dateParser.parseInvoiceDate(contextText);
      if (!date) continue;

      // Try to extract an amount
      var amount = amountParser ? amountParser.parseAmount(contextText) : null;

      // Find the best clickable: prefer <a> with href, then the element itself
      var clickableEl = el;
      if (el.tagName !== "A" && el.tagName !== "BUTTON") {
        var innerLink = el.querySelector("a[href], button, [role='button']");
        if (innerLink && isVisible(innerLink)) clickableEl = innerLink;
      }

      candidates.push({
        element: clickableEl,
        text: text.slice(0, 100),
        date: date,
        amountCents: amount,
      });
    }

    // Need at least 2 dated items for a list
    if (candidates.length < 2) return null;

    // Score each candidate
    var bestCandidate = null;
    var bestScore = -1;
    var txTime = transactionDate.getTime();

    for (var j = 0; j < candidates.length; j++) {
      var cand = candidates[j];
      var score = 0;

      // Date proximity score (0-50)
      var daysDiff = Math.abs(cand.date.getTime() - txTime) / 86400000;
      if (daysDiff <= 5) score += 50;
      else if (daysDiff <= 15) score += 45;
      else if (daysDiff <= 31) score += 40;
      else if (daysDiff <= 45) score += 30;
      else if (daysDiff <= 90) score += 15;
      else if (daysDiff <= 180) score += 5;

      // Amount match score (0-40)
      if (cand.amountCents !== null && amountParser) {
        if (amountParser.amountsMatch(cand.amountCents, amountCents, 2)) {
          score += 40;
        } else if (amountParser.amountsMatch(cand.amountCents, amountCents, 200)) {
          score += 25;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = cand;
      }
    }

    // Need at least a reasonable date match (within ~45 days)
    if (bestScore < 15 || !bestCandidate) return null;

    console.log(
      "[FiBuKI Replay] Invoice list detected: " + candidates.length +
      " items, best match: \"" + bestCandidate.text +
      "\" (score " + bestScore + ")"
    );

    return {
      _rowElement: bestCandidate.element,
      _downloadElement: bestCandidate.element.tagName === "A" ? bestCandidate.element : null,
      _score: bestScore,
      _text: bestCandidate.text,
    };
  }

  // ============================================================================
  // Invoice Row Matching — find the row matching a transaction
  // ============================================================================

  /**
   * Find the invoice row best matching the given amount and date.
   * Returns the matched row data object or null.
   */
  function matchInvoiceRow(tableData, amountCents, transactionDate, toleranceCents) {
    if (!tableData || !tableData.rows || tableData.rows.length === 0) return null;
    if (typeof toleranceCents !== "number") toleranceCents = 200; // 2 EUR default

    var amountParser = window.__tsAmountParser;
    var dateParser = window.__tsDateParser;
    if (!amountParser || !dateParser) return null;

    var bestMatch = null;
    var bestScore = 0;

    for (var i = 0; i < tableData.rows.length; i++) {
      var row = tableData.rows[i];
      var score = 0;

      // Score amount match
      var rowAmountText = row.amount || "";
      if (!rowAmountText) {
        // Try to find amount in row text
        var rowText = row._rowElement ? (row._rowElement.textContent || "") : "";
        var rowAmount = amountParser.parseAmount(rowText);
        if (rowAmount !== null) rowAmountText = String(rowAmount);
      }

      var rowCents = row._amountCents != null ? row._amountCents : amountParser.parseAmount(rowAmountText);
      if (rowCents !== null && amountParser.amountsMatch(rowCents, amountCents, toleranceCents)) {
        score += 50; // Amount match is strongest signal
        // Bonus for exact match
        if (amountParser.amountsMatch(rowCents, amountCents, 2)) {
          score += 20;
        }
      }

      // Score date match
      var rowDateText = row.date || "";
      var rowDate = row._parsedDate || dateParser.parseInvoiceDate(rowDateText);
      if (rowDate && transactionDate && dateParser.datesMatch(rowDate, transactionDate, 30)) {
        score += 20;
        // Bonus for close date match
        if (dateParser.datesMatch(rowDate, transactionDate, 7)) {
          score += 10;
        }
      }

      // Bonus for having a download element
      if (row._downloadElement || row._downloadHref) {
        score += 5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = row;
      }
    }

    // Minimum score threshold — need at least an amount match
    return bestScore >= 50 ? bestMatch : null;
  }

  // ============================================================================
  // Replay State Machine
  // ============================================================================

  var STATES = {
    IDLE: "idle",
    NAVIGATING: "navigating",
    REPLAYING: "replaying",
    FINDING_INVOICE: "finding_invoice",
    DOWNLOADING: "downloading",
    AUTH_WAITING: "auth_waiting",
    TIER2_AGENT: "tier2_agent",
    SUCCESS: "success",
    FAILED: "failed",
  };

  /**
   * ReplayStateMachine manages the replay lifecycle.
   * @param {Object} config
   *   - recipe: BrowserRecipe
   *   - transactionAmount: number (cents)
   *   - transactionDate: Date
   *   - transactionId: string
   *   - transactionCurrency: string
   *   - onProgress: function(step, total, message)
   *   - onSuccess: function(result)
   *   - onFailed: function(result)
   *   - onAuthRequired: function()
   *   - onTier2Needed: function(failedAtStep, snapshot)
   */
  function ReplayStateMachine(config) {
    this.config = config;
    this.state = STATES.IDLE;
    this.currentStep = 0;
    this.startTime = 0;
    this.authWaitStart = 0;
    this.tier = 1;
    this.agentIterations = config.initialAgentIterations || 0;
    this._authCheckInterval = null;
    this._navCheckInterval = null;
    this._cancelled = false;
  }

  ReplayStateMachine.prototype.start = function (resumeFromStep) {
    if (this.state !== STATES.IDLE) return;
    this._cancelled = false;
    this.startTime = Date.now();
    this.state = STATES.NAVIGATING;

    var recipe = this.config.recipe;
    var actions = recipe.recordedActions || [];
    // Also include agent-learned actions if available
    if (recipe.agentActions && recipe.agentActions.length > 0) {
      actions = actions.concat(recipe.agentActions);
    }
    this._actions = actions;
    this._totalSteps = actions.length;
    this._invoiceMatchAttempted = false;

    // Check for login page immediately on start
    if (isAuthPage(window.location.href)) {
      this.handleAuth();
      return;
    }

    // === Direct navigation mode ===
    // If recipe has invoiceListUrl, skip pre-list navigation and find the invoice directly.
    if (recipe.invoiceListUrl) {
      var self = this;

      // Build post-select actions (actions after the selectInvoice step)
      var selectIdx = -1;
      for (var si = 0; si < actions.length; si++) {
        if (actions[si].actionType === "selectInvoice") {
          selectIdx = si;
          break;
        }
      }
      this._postSelectActions = selectIdx >= 0 ? actions.slice(selectIdx + 1) : [];

      // If already on the invoice list URL, find the matching invoice
      if (samePageUrl(window.location.href, recipe.invoiceListUrl)) {
        console.log("[FiBuKI Replay] On invoice list URL, finding invoice...");
        self.reportProgress("On invoice list, finding matching invoice...");
        setTimeout(function () { self.findAndSelectInvoice(); }, 1000);
        return;
      }

      // Not on the invoice list yet — navigate there (first start only)
      if (!resumeFromStep || resumeFromStep === 0) {
        console.log("[FiBuKI Replay] Direct navigation to invoice list:", recipe.invoiceListUrl);
        self.reportProgress("Navigating to invoice list...");
        self._postAuthTarget = recipe.invoiceListUrl;
        window.location.href = recipe.invoiceListUrl;
        // The page will reload; background.js onCompleted will re-send TS_START_REPLAY_TAB
        return;
      }
      // Resuming after navigation but not on invoiceListUrl (auth redirect?) — fall through to normal replay
    }

    // Resume from a specific step (after page navigation)
    var startAt = (typeof resumeFromStep === "number" && resumeFromStep > 0) ? resumeFromStep : 0;
    this.currentStep = Math.min(startAt, this._actions.length);

    if (startAt > 0) {
      console.log("[FiBuKI Replay] Resuming from step " + startAt);
      this.reportProgress("Resuming from step " + (startAt + 1) + "...");
    } else {
      this.reportProgress("Starting replay...");
    }

    // If we've already passed all actions, go straight to invoice finding
    if (this.currentStep >= this._actions.length) {
      var self3 = this;
      self3.state = STATES.FINDING_INVOICE;
      self3.reportProgress("Looking for invoice table...");
      setTimeout(function () { self3.findAndDownloadInvoice(); }, 1000);
      return;
    }

    // Begin replaying actions
    this.replayNextAction();
  };

  ReplayStateMachine.prototype.cancel = function () {
    this._cancelled = true;
    this.state = STATES.FAILED;
    if (this._authCheckInterval) {
      clearInterval(this._authCheckInterval);
      this._authCheckInterval = null;
    }
    if (this._authGraceInterval) {
      clearInterval(this._authGraceInterval);
      this._authGraceInterval = null;
    }
    if (this._navCheckInterval) {
      clearInterval(this._navCheckInterval);
      this._navCheckInterval = null;
    }
    this._authGraceStart = null;
    hideAuthSkipButton();
  };

  ReplayStateMachine.prototype.reportProgress = function (message) {
    if (this.config.onProgress) {
      this.config.onProgress(this.currentStep, this._totalSteps, message);
    }
  };

  ReplayStateMachine.prototype.replayNextAction = function () {
    var self = this;
    if (self._cancelled) return;

    if (self.currentStep >= self._actions.length) {
      // All actions replayed — now try to find and download the invoice
      self.state = STATES.FINDING_INVOICE;
      self.reportProgress("Looking for invoice table...");
      setTimeout(function () { self.findAndDownloadInvoice(); }, 1000);
      return;
    }

    var action = self._actions[self.currentStep];
    self.state = STATES.REPLAYING;

    // Check for login page before attempting any action
    if (isAuthPage(window.location.href)) {
      self.handleAuth();
      return;
    }

    self.reportProgress("Step " + (self.currentStep + 1) + "/" + self._totalSteps + ": " + action.actionType);

    // Before click actions, try to detect and match the right invoice on the page.
    // This handles the case where the recorded recipe clicked a specific invoice
    // (e.g., "Jänner 2026") but during replay we need a different one (e.g., "September 2024").
    if (action.actionType === "click" && !self._invoiceMatchAttempted) {
      var invoiceMatch = scanPageForInvoiceMatch(
        self.config.transactionAmount,
        self.config.transactionDate
      );
      if (invoiceMatch && invoiceMatch._rowElement) {
        self._invoiceMatchAttempted = true;

        // Check if the match is different from the recorded target
        var recordedEl = action.clickTarget ? findElement(action.clickTarget) : null;
        if (!recordedEl || recordedEl !== invoiceMatch._rowElement) {
          console.log("[FiBuKI Replay] Clicking matched invoice instead of recorded target");
          self.reportProgress("Found matching invoice, selecting...");
          dispatchClick(invoiceMatch._rowElement);
          self.currentStep++;

          // Wait for navigation (clicking an invoice usually navigates to detail page)
          var navDelay = 2000;
          setTimeout(function () { self.replayNextAction(); }, navDelay);
          return;
        }
      }
    }

    self.executeAction(action, function (success) {
      if (self._cancelled) return;

      if (!success) {
        // Action failed — check if we can fall back to invoice scan
        console.log("[FiBuKI Replay] Action failed at step " + self.currentStep + ":", action.actionType);

        // Try invoice scan as fallback for failed click actions
        if (action.actionType === "click" && !self._invoiceMatchAttempted) {
          var fallbackMatch = scanPageForInvoiceMatch(
            self.config.transactionAmount,
            self.config.transactionDate
          );
          if (fallbackMatch && fallbackMatch._rowElement) {
            self._invoiceMatchAttempted = true;
            console.log("[FiBuKI Replay] Using invoice match as fallback for failed click");
            dispatchClick(fallbackMatch._rowElement);
            self.currentStep++;
            setTimeout(function () { self.replayNextAction(); }, 2000);
            return;
          }
        }

        // Collect page snapshot for Tier 2
        var snapshot = collectReplaySnapshot();
        self.state = STATES.FAILED;

        if (self.config.onTier2Needed && self.agentIterations < 10) {
          self.config.onTier2Needed(self.currentStep, snapshot);
        } else if (self.config.onFailed) {
          self.config.onFailed({
            status: "failed_element",
            tier: 1,
            failedAtStep: self.currentStep,
            durationMs: Date.now() - self.startTime,
            transactionId: self.config.transactionId,
          });
        }
        return;
      }

      self.currentStep++;

      // Wait for page to settle after action (navigation, AJAX, etc.)
      var delay = action.actionType === "navigate" ? 2000 : 800;
      setTimeout(function () { self.replayNextAction(); }, delay);
    });
  };

  ReplayStateMachine.prototype.executeAction = function (action, callback) {
    var self = this;

    switch (action.actionType) {
      case "navigate":
        if (action.targetUrl) {
          // Check if already on the target URL
          if (samePageUrl(window.location.href, action.targetUrl)) {
            callback(true);
            return;
          }
          // Navigate and wait
          self.navigateAndWait(action.targetUrl, function (success) {
            callback(success);
          });
        } else {
          callback(true);
        }
        break;

      case "click":
        if (action.clickTarget) {
          var el = findElement(action.clickTarget);
          if (el) {
            dispatchClick(el);
            callback(true);
          } else {
            console.log("[FiBuKI Replay] Element not found:", JSON.stringify(action.clickTarget).slice(0, 200));
            callback(false);
          }
        } else {
          callback(false);
        }
        break;

      case "type":
        if (action.clickTarget && action.inputValue != null) {
          var inputEl = findElement(action.clickTarget);
          if (inputEl) {
            var value = resolveTemplatePlaceholders(action.inputValue, self.config);
            inputEl.focus();
            inputEl.value = value;
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
            inputEl.dispatchEvent(new Event("change", { bubbles: true }));
            callback(true);
          } else {
            callback(false);
          }
        } else {
          callback(false);
        }
        break;

      case "scroll":
        window.scrollBy(0, 300);
        callback(true);
        break;

      case "selectInvoice":
        // For sequential replay (no invoiceListUrl), try smart matching first
        var invoiceMatch = scanPageForInvoiceMatch(
          self.config.transactionAmount,
          self.config.transactionDate
        );
        if (invoiceMatch && invoiceMatch._rowElement) {
          console.log("[FiBuKI Replay] Smart-matching invoice instead of recorded click");
          dispatchClick(invoiceMatch._rowElement);
          callback(true);
        } else if (action.clickTarget) {
          // Fall back to recorded click target
          var selectEl = findElement(action.clickTarget);
          if (selectEl) {
            dispatchClick(selectEl);
            callback(true);
          } else {
            callback(false);
          }
        } else {
          callback(false);
        }
        break;

      case "capture_page_as_pdf":
        self.reportProgress("Capturing page as PDF...");
        // Ask content script to capture and upload
        window.postMessage({ type: "TS_REPLAY_CAPTURE_PAGE", runId: self.config.runId }, "*");
        // Wait for TS_REPLAY_PDF_DOWNLOADED signal (same as download wait)
        var captureTimeout = setTimeout(function () {
          if (self.state !== STATES.SUCCESS) {
            console.log("[FiBuKI Replay] Page capture timeout");
            callback(false);
          }
        }, 30000); // 30s for conversion
        self._captureTimeout = captureTimeout;
        return; // Don't call callback — wait for PDF downloaded signal

      case "pdf_detected":
      case "mark_invoice_page":
        // These are informational — skip
        callback(true);
        break;

      default:
        console.log("[FiBuKI Replay] Unknown action type:", action.actionType);
        callback(true);
        break;
    }
  };

  ReplayStateMachine.prototype.navigateAndWait = function (url, callback) {
    var self = this;
    var startUrl = window.location.href;

    // Set up navigation detection
    var resolved = false;
    var resolve = function (success) {
      if (resolved) return;
      resolved = true;
      if (self._navCheckInterval) {
        clearInterval(self._navCheckInterval);
        self._navCheckInterval = null;
      }
      callback(success);
    };

    // Navigate
    window.location.href = url;

    // Poll for URL change or page load
    var attempts = 0;
    self._navCheckInterval = setInterval(function () {
      attempts++;
      if (window.location.href !== startUrl || attempts > 20) {
        resolve(true);
      }
      if (attempts > 30) {
        resolve(false);
      }
    }, 200);
  };

  ReplayStateMachine.prototype.findAndDownloadInvoice = function () {
    var self = this;
    if (self._cancelled) return;

    // Check for login page before trying to find invoices
    if (isAuthPage(window.location.href)) {
      self.handleAuth();
      return;
    }

    // Try to parse an invoice table
    var containerHint = self.config.recipe.invoiceTableMeta
      ? self.config.recipe.invoiceTableMeta.containerSelector
      : null;
    var tableData = parseInvoiceTable(containerHint);

    // Also try the page-level scan (handles card/list layouts)
    if (!tableData || !tableData.rows || tableData.rows.length === 0) {
      var pageScan = scanPageForInvoiceMatch(
        self.config.transactionAmount,
        self.config.transactionDate
      );
      if (pageScan && pageScan._downloadElement) {
        // Found a downloadable invoice via page scan
        self.state = STATES.DOWNLOADING;
        self.reportProgress("Found invoice, downloading...");
        dispatchClick(pageScan._downloadElement);
        // Fallback timeout — if TS_REPLAY_PDF_DOWNLOADED fires first, state will be SUCCESS and this is a no-op
        setTimeout(function () {
          if (self.state === STATES.DOWNLOADING) {
            if (self.config.onFailed) {
              self.config.onFailed({
                status: "failed_download",
                tier: self.tier,
                durationMs: Date.now() - self.startTime,
                transactionId: self.config.transactionId,
                agentIterations: self.agentIterations,
              });
            }
          }
        }, 15000);
        return;
      }
    }

    if (!tableData || !tableData.rows || tableData.rows.length === 0) {
      // No table found — might need Tier 2
      console.log("[FiBuKI Replay] No invoice table found on page");
      self.reportProgress("No invoice table found, trying fallback...");

      var snapshot = collectReplaySnapshot();
      if (self.config.onTier2Needed && self.agentIterations < 10) {
        self.config.onTier2Needed(self.currentStep, snapshot);
      } else {
        self.config.onFailed({
          status: "failed_match",
          tier: 1,
          durationMs: Date.now() - self.startTime,
          transactionId: self.config.transactionId,
        });
      }
      return;
    }

    // Find the matching row
    var match = matchInvoiceRow(
      tableData,
      self.config.transactionAmount,
      self.config.transactionDate,
      200 // 2 EUR tolerance
    );

    if (!match) {
      console.log("[FiBuKI Replay] No matching invoice row found");
      self.reportProgress("No matching invoice found");

      var snapshot2 = collectReplaySnapshot();
      if (self.config.onTier2Needed && self.agentIterations < 10) {
        self.config.onTier2Needed(self.currentStep, snapshot2);
      } else {
        self.config.onFailed({
          status: "failed_match",
          tier: 1,
          durationMs: Date.now() - self.startTime,
          transactionId: self.config.transactionId,
        });
      }
      return;
    }

    // Found a match — click the download button
    self.state = STATES.DOWNLOADING;
    self.reportProgress("Found matching invoice, downloading...");

    if (match._downloadElement) {
      dispatchClick(match._downloadElement);
    } else if (match._downloadHref) {
      // Navigate to the download URL
      window.location.href = match._downloadHref;
    } else if (match._rowElement) {
      // Try clicking the row itself
      dispatchClick(match._rowElement);
    } else {
      self.config.onFailed({
        status: "failed_match",
        tier: 1,
        durationMs: Date.now() - self.startTime,
        transactionId: self.config.transactionId,
      });
      return;
    }

    // Fallback timeout — if TS_REPLAY_PDF_DOWNLOADED fires first, state will be SUCCESS and this is a no-op
    setTimeout(function () {
      if (self.state === STATES.DOWNLOADING) {
        if (self.config.onFailed) {
          self.config.onFailed({
            status: "failed_download",
            tier: self.tier,
            durationMs: Date.now() - self.startTime,
            transactionId: self.config.transactionId,
            agentIterations: self.agentIterations,
          });
        }
      }
    }, 15000);
  };

  /**
   * Direct navigation mode: find the correct invoice on the list page and click it.
   * After clicking, replay the post-select actions (detail page → download).
   */
  ReplayStateMachine.prototype.findAndSelectInvoice = function () {
    var self = this;
    if (self._cancelled) return;

    // Check for auth redirect
    if (isAuthPage(window.location.href)) {
      self._postAuthTarget = self.config.recipe.invoiceListUrl;
      self.handleAuth();
      return;
    }

    self.state = STATES.FINDING_INVOICE;
    var match = scanPageForInvoiceMatch(
      self.config.transactionAmount,
      self.config.transactionDate
    );

    if (match && match._rowElement) {
      console.log("[FiBuKI Replay] Invoice match found: \"" + (match._text || "") + "\" (score " + (match._score || 0) + ")");
      self.reportProgress("Found matching invoice, selecting...");
      dispatchClick(match._rowElement);

      // After clicking, replay the post-select actions (navigate to detail, download)
      var postActions = self._postSelectActions || [];
      if (postActions.length > 0) {
        self._actions = postActions;
        self._totalSteps = postActions.length;
        self.currentStep = 0;
        self._invoiceMatchAttempted = true;
        setTimeout(function () { self.replayNextAction(); }, 2000);
      } else {
        // No post-select actions — go straight to findAndDownloadInvoice
        setTimeout(function () { self.findAndDownloadInvoice(); }, 2000);
      }
      return;
    }

    // No match — try pagination
    console.log("[FiBuKI Replay] No invoice match on current page, trying pagination...");
    self.tryPaginationThenEscalate();
  };

  /**
   * Try pagination to find the invoice on subsequent pages.
   * If no pagination or still no match, escalate.
   */
  ReplayStateMachine.prototype.tryPaginationThenEscalate = function () {
    var self = this;
    if (self._cancelled) return;

    var pagination = detectPagination();
    if (pagination.hasNext) {
      self.reportProgress("Checking next page...");

      // Find and click the next button
      var allElements = document.querySelectorAll("a, button, [role='button']");
      var nextBtn = null;
      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        if (!isVisible(el)) continue;
        var text = normalizeText(el.textContent || "");
        var ariaLabel = normalizeText(el.getAttribute("aria-label") || "");
        var combined = text + " " + ariaLabel;
        if (/\bnext\b|\bweiter\b|\bnächste\b|►|→|>>/i.test(combined)) {
          nextBtn = el;
          break;
        }
      }

      if (nextBtn) {
        dispatchClick(nextBtn);
        // Wait for page update, then retry findAndSelectInvoice
        setTimeout(function () { self.findAndSelectInvoice(); }, 2000);
        return;
      }
    }

    // No pagination or no next button — escalate
    self.escalateNoMatch();
  };

  /**
   * Escalate when no matching invoice found after exhausting pagination.
   * Sends notification and tries Tier 2 agent as fallback.
   */
  ReplayStateMachine.prototype.escalateNoMatch = function () {
    var self = this;

    console.log("[FiBuKI Replay] No matching invoice found, escalating...");
    self.reportProgress("No matching invoice found");

    // Send no-match message to background (triggers notification)
    chrome.runtime.sendMessage({
      type: "TS_REPLAY_NO_MATCH",
      transactionId: self.config.transactionId,
    });

    // Try Tier 2 agent as fallback
    var snapshot = collectReplaySnapshot();
    if (self.config.onTier2Needed && self.agentIterations < 10) {
      self.config.onTier2Needed(self.currentStep, snapshot);
    } else if (self.config.onFailed) {
      self.config.onFailed({
        status: "failed_match",
        tier: self.tier,
        durationMs: Date.now() - self.startTime,
        transactionId: self.config.transactionId,
        agentIterations: self.agentIterations,
      });
    }
  };

  // Grace period (ms) to wait before confirming an auth page.
  // SSO passthroughs (e.g., accounts.google.com during Google OAuth) redirect
  // automatically within ~2s. If the page leaves the auth URL within this window,
  // we treat it as a passthrough and resume replay.
  var AUTH_GRACE_MS = 3500;

  ReplayStateMachine.prototype.handleAuth = function () {
    var self = this;

    // If this is the first time we detect auth, start a grace period
    // to distinguish real login pages from SSO passthroughs
    if (!self._authGraceStart) {
      self._authGraceStart = Date.now();
      self.state = STATES.AUTH_WAITING;
      self.reportProgress("Checking login status...");

      self._authGraceInterval = setInterval(function () {
        if (self._cancelled) {
          clearInterval(self._authGraceInterval);
          self._authGraceInterval = null;
          return;
        }

        // SSO passthrough resolved — auth page disappeared within grace period
        if (!isAuthPage(window.location.href)) {
          clearInterval(self._authGraceInterval);
          self._authGraceInterval = null;
          self._authGraceStart = null;
          console.log("[FiBuKI Replay] SSO passthrough detected, resuming...");
          self._resumeAfterAuth();
          return;
        }

        // Grace period expired — this is a real auth page
        if (Date.now() - self._authGraceStart > AUTH_GRACE_MS) {
          clearInterval(self._authGraceInterval);
          self._authGraceInterval = null;
          self._authGraceStart = null;
          self._enterAuthWait();
          return;
        }
      }, 500);
      return;
    }

    // Already past grace period — enter auth wait directly
    self._authGraceStart = null;
    self._enterAuthWait();
  };

  /**
   * Called when auth page is confirmed (grace period expired).
   * Shows "Login required" message with a Skip button and polls for completion.
   */
  ReplayStateMachine.prototype._enterAuthWait = function () {
    var self = this;
    self.state = STATES.AUTH_WAITING;
    self.authWaitStart = Date.now();
    self.reportProgress("Login required — please sign in");

    // Show a "Skip" button on the overlay
    showAuthSkipButton(function () {
      console.log("[FiBuKI Replay] Auth skipped by user");
      if (self._authCheckInterval) {
        clearInterval(self._authCheckInterval);
        self._authCheckInterval = null;
      }
      self._resumeAfterAuth();
    });

    if (self.config.onAuthRequired) {
      self.config.onAuthRequired();
    }

    // Poll for auth completion
    self._authCheckInterval = setInterval(function () {
      if (self._cancelled) {
        clearInterval(self._authCheckInterval);
        return;
      }

      // Check timeout
      if (Date.now() - self.authWaitStart > AUTH_TIMEOUT_MS) {
        clearInterval(self._authCheckInterval);
        self._authCheckInterval = null;
        self.state = STATES.FAILED;
        hideAuthSkipButton();
        if (self.config.onFailed) {
          self.config.onFailed({
            status: "failed_auth",
            tier: self.tier,
            durationMs: Date.now() - self.startTime,
            transactionId: self.config.transactionId,
          });
        }
        return;
      }

      // Check if we've left the auth page
      if (!isAuthPage(window.location.href)) {
        clearInterval(self._authCheckInterval);
        self._authCheckInterval = null;
        hideAuthSkipButton();
        self._resumeAfterAuth();
      }
    }, 1000);
  };

  /**
   * Resume replay after auth is complete (or skipped).
   */
  ReplayStateMachine.prototype._resumeAfterAuth = function () {
    var self = this;
    self.state = STATES.REPLAYING;
    self.reportProgress("Login complete, resuming...");

    // If we have a post-auth target (e.g., invoiceListUrl), navigate there
    if (self._postAuthTarget && !samePageUrl(window.location.href, self._postAuthTarget)) {
      var target = self._postAuthTarget;
      self._postAuthTarget = null;
      self.reportProgress("Navigating to invoice list...");
      window.location.href = target;
      // Background will re-send TS_START_REPLAY_TAB on navigation complete
      return;
    }
    self._postAuthTarget = null;

    // If direct nav mode and on invoice list, do smart matching
    if (self.config.recipe.invoiceListUrl && samePageUrl(window.location.href, self.config.recipe.invoiceListUrl)) {
      setTimeout(function () { self.findAndSelectInvoice(); }, 1500);
      return;
    }

    // Resume normal replay
    setTimeout(function () { self.replayNextAction(); }, 1500);
  };

  /**
   * Show a "Skip login" button on the replay overlay for false-positive auth detection.
   */
  function showAuthSkipButton(onSkip) {
    var panel = document.getElementById(REPLAY_OVERLAY_ID);
    if (!panel) return;
    // Remove existing skip button if any
    hideAuthSkipButton();

    var skipBtn = document.createElement("button");
    skipBtn.id = REPLAY_OVERLAY_ID + "-skip-auth";
    skipBtn.textContent = "Not a login? Skip";
    skipBtn.style.cssText = "display:block; margin:0 14px 10px; padding:6px 14px; border-radius:6px; " +
      "border:1px solid rgba(251,191,36,0.4); background:rgba(251,191,36,0.12); color:#fbbf24; " +
      "font:600 11px/1 sans-serif; cursor:pointer; width:calc(100% - 28px); text-align:center;";
    skipBtn.addEventListener("click", function () {
      hideAuthSkipButton();
      if (onSkip) onSkip();
    });
    panel.appendChild(skipBtn);
  }

  function hideAuthSkipButton() {
    var btn = document.getElementById(REPLAY_OVERLAY_ID + "-skip-auth");
    if (btn) btn.remove();
  }

  /**
   * Resume replay after Tier 2 agent sends commands.
   * Called from content.js when agent returns actions.
   */
  ReplayStateMachine.prototype.executeTier2Commands = function (commands, callback) {
    var self = this;
    self.tier = 2;
    self.agentIterations++;
    self.state = STATES.TIER2_AGENT;

    var index = 0;

    function next() {
      if (self._cancelled) { callback(false); return; }
      if (index >= commands.length) { callback(true); return; }

      var cmd = commands[index++];
      self.reportProgress("Agent: " + (cmd.action || cmd.type || "command"));
      self.executeTier2Command(cmd, function (ok) {
        if (!ok) { callback(false); return; }
        setTimeout(next, 500);
      });
    }

    next();
  };

  ReplayStateMachine.prototype.executeTier2Command = function (cmd, callback) {
    switch (cmd.action) {
      case "navigate":
        if (cmd.url) {
          window.location.href = cmd.url;
          setTimeout(function () { callback(true); }, 2000);
        } else {
          callback(false);
        }
        break;

      case "clickByText":
        var el = findByText(cmd.text, cmd.tagName);
        if (!el) el = findByFuzzyText(cmd.text, cmd.tagName);
        if (el) { dispatchClick(el); callback(true); }
        else { callback(false); }
        break;

      case "clickByAriaLabel":
        var el2 = findByAriaLabel(cmd.label);
        if (el2) { dispatchClick(el2); callback(true); }
        else { callback(false); }
        break;

      case "clickBySelector":
        try {
          var el3 = document.querySelector(cmd.selector);
          if (el3) { dispatchClick(el3); callback(true); }
          else { callback(false); }
        } catch (e) { callback(false); }
        break;

      case "type":
        var inputEl = cmd.selector ? document.querySelector(cmd.selector) : null;
        if (!inputEl && cmd.label) inputEl = findByAriaLabel(cmd.label);
        if (inputEl) {
          inputEl.focus();
          inputEl.value = cmd.value || "";
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          inputEl.dispatchEvent(new Event("change", { bubbles: true }));
          callback(true);
        } else {
          callback(false);
        }
        break;

      case "scrollTo":
        window.scrollTo(0, cmd.y || 0);
        callback(true);
        break;

      case "wait":
        setTimeout(function () { callback(true); }, cmd.ms || 1000);
        break;

      case "capturePageAsPdf":
        self.reportProgress("Agent: Capturing page as PDF...");
        window.postMessage({ type: "TS_REPLAY_CAPTURE_PAGE", runId: self.config.runId }, "*");
        // Async — PDF upload signals separately via TS_REPLAY_PDF_DOWNLOADED
        setTimeout(function () { callback(true); }, 1000);
        break;

      default:
        console.log("[FiBuKI Replay] Unknown Tier 2 command:", cmd.action);
        callback(false);
        break;
    }
  };

  // ============================================================================
  // Helpers
  // ============================================================================

  function samePageUrl(a, b) {
    try {
      var urlA = new URL(a);
      var urlB = new URL(b);
      return urlA.origin === urlB.origin && urlA.pathname === urlB.pathname;
    } catch (e) {
      return a === b;
    }
  }

  // Use [/\-_\.] prefix to catch hyphenated compounds like /mein-magenta-login/
  var AUTH_PATTERNS = [
    /[/\-_.]login/i, /[/\-_.]log-in/i,
    /[/\-_.]signin/i, /[/\-_.]sign-in/i,
    /[/\-_.]anmeld/i, /[/\-_.]einloggen/i,
    /\/auth\//i, /\/authenticate/i, /\/oauth\//i, /\/sso\//i,
    /accounts\.google\.com/i, /login\.microsoftonline\.com/i,
  ];

  function isAuthPage(url) {
    if (!url) return false;
    for (var i = 0; i < AUTH_PATTERNS.length; i++) {
      if (AUTH_PATTERNS[i].test(url)) return true;
    }
    return false;
  }

  function dispatchClick(el) {
    if (!el) return;
    // Scroll into view
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Dispatch mouse events
    var events = ["mouseenter", "mouseover", "mousedown", "mouseup", "click"];
    for (var i = 0; i < events.length; i++) {
      el.dispatchEvent(new MouseEvent(events[i], {
        bubbles: true, cancelable: true, view: window,
      }));
    }
  }

  function resolveTemplatePlaceholders(value, config) {
    if (!value || typeof value !== "string") return value || "";
    var result = value;
    if (config.transactionDate) {
      var d = config.transactionDate;
      var dd = String(d.getDate()).padStart(2, "0");
      var mm = String(d.getMonth() + 1).padStart(2, "0");
      var yyyy = String(d.getFullYear());
      result = result
        .replace(/\{\{invoiceDate\}\}/g, dd + "." + mm + "." + yyyy)
        .replace(/\{\{invoiceDateISO\}\}/g, yyyy + "-" + mm + "-" + dd)
        .replace(/\{\{invoiceMonth\}\}/g, mm)
        .replace(/\{\{invoiceYear\}\}/g, yyyy);
    }
    return result;
  }

  // ============================================================================
  // Page Intelligence — classify page, detect pagination, extract invoice rows
  // ============================================================================

  /**
   * Classify the current page type for LLM context.
   * Returns: "login" | "invoice_list" | "invoice_detail" | "download_area" | "overview_dashboard" | "unknown"
   */
  function classifyPage() {
    if (isAuthPage(window.location.href)) return "login";

    var bodyText = (document.body.innerText || "").toLowerCase();
    var amountParser = window.__tsAmountParser;

    // Count amounts on page
    var amountCount = 0;
    if (amountParser) {
      var amountMatches = bodyText.match(/[\d.,]+\s*(€|eur|usd|\$|£)/gi) || [];
      amountCount = amountMatches.length;
    }

    // Count download/PDF elements (links AND buttons with download text/icons)
    var downloadLinks = document.querySelectorAll(
      'a[href*="download"], a[href*="pdf"], a[href*=".pdf"], ' +
      'a[href*="invoice"], button[aria-label*="download" i], ' +
      'button[aria-label*="pdf" i], [data-action*="download"]'
    );
    var downloadCount = downloadLinks.length;
    // Also count buttons whose text or icon classes indicate download
    var allButtons = document.querySelectorAll("button, [role='button']");
    for (var bi = 0; bi < allButtons.length; bi++) {
      var btn = allButtons[bi];
      if (!isVisible(btn)) continue;
      var btnText = (btn.textContent || "").toLowerCase();
      var btnClass = (btn.className || "") + " " + (btn.innerHTML || "");
      if (/herunterladen|download|pdf|dokument/i.test(btnText) ||
          /icon-download|icon-pdf|download-btn|download_btn/i.test(btnClass)) {
        downloadCount++;
      }
    }

    // Check for invoice table
    var tableData = parseInvoiceTable(null);
    var hasInvoiceTable = tableData && tableData.rows && tableData.rows.length >= 2;

    // Check for invoice keywords in headings
    var headings = document.querySelectorAll("h1, h2, h3, h4");
    var hasInvoiceHeading = false;
    for (var h = 0; h < headings.length; h++) {
      var ht = (headings[h].textContent || "").toLowerCase();
      if (/invoice|rechnung|beleg|faktur|billing|zahlung|payment/i.test(ht)) {
        hasInvoiceHeading = true;
        break;
      }
    }

    // Classify
    if (hasInvoiceTable || (hasInvoiceHeading && amountCount >= 3)) {
      return "invoice_list";
    }
    if (downloadCount >= 3) {
      return "download_area";
    }
    if (amountCount >= 1 && amountCount <= 3 && downloadCount >= 1) {
      return "invoice_detail";
    }

    // Count nav links
    var navLinks = document.querySelectorAll("nav a, [role='navigation'] a, .sidebar a, .menu a");
    if (navLinks.length >= 5 && amountCount <= 2 && downloadCount <= 1) {
      return "overview_dashboard";
    }

    return "unknown";
  }

  /**
   * Detect pagination controls on the page.
   */
  function detectPagination() {
    var result = { hasAny: false, hasNext: false, hasPrevious: false, currentPage: null };

    var allElements = document.querySelectorAll("a, button, [role='button']");
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (!isVisible(el)) continue;
      var text = normalizeText(el.textContent || "");
      var ariaLabel = normalizeText(el.getAttribute("aria-label") || "");
      var combined = text + " " + ariaLabel;

      if (/\bnext\b|\bweiter\b|\bnächste\b|►|→|>>/i.test(combined)) {
        result.hasNext = true;
        result.hasAny = true;
      }
      if (/\bprevious\b|\bprev\b|\bzurück\b|\bvorige\b|◄|←|<</i.test(combined)) {
        result.hasPrevious = true;
        result.hasAny = true;
      }
    }

    // Check for numbered page links
    var currentPageEl = document.querySelector("[aria-current='page'], .active[data-page], .pagination .active");
    if (currentPageEl) {
      result.hasAny = true;
      var pageNum = parseInt(currentPageEl.textContent, 10);
      if (!isNaN(pageNum)) result.currentPage = pageNum;
    }

    return result;
  }

  /**
   * Extract structured invoice-like rows from the page.
   * Returns up to 10 rows with amount, date, description, download info.
   */
  function extractInvoiceLikeRows() {
    var rows = [];
    var amountParser = window.__tsAmountParser;
    var dateParser = window.__tsDateParser;

    // Try formal table first
    var tableData = parseInvoiceTable(null);
    if (tableData && tableData.rows && tableData.rows.length > 0) {
      for (var t = 0; t < Math.min(tableData.rows.length, 10); t++) {
        var row = tableData.rows[t];
        var rowText = row._rowElement ? (row._rowElement.textContent || "").trim() : "";
        rows.push({
          index: t,
          amount: row.amount || (amountParser ? String(amountParser.parseAmount(rowText) || "") : ""),
          date: row.date || "",
          description: (row.description || rowText).slice(0, 100),
          hasDownload: !!(row._downloadElement || row._downloadHref),
        });
      }
      return rows;
    }

    // Fall back to page scan
    var pageScan = scanPageForInvoiceMatch(0, null);
    // scanPageForInvoiceMatch returns only the best match, but we want all candidates
    // Instead, collect candidates manually
    var clickables = document.querySelectorAll(
      "a[href], button, [role='button'], [role='link'], [role='listitem'], [role='row']"
    );

    for (var i = 0; i < clickables.length && rows.length < 10; i++) {
      var el = clickables[i];
      if (!isVisible(el)) continue;
      var text = (el.textContent || "").trim();
      if (!text || text.length > 300 || text.length < 5) continue;

      var date = dateParser ? dateParser.parseInvoiceDate(text) : null;
      var amount = amountParser ? amountParser.parseAmount(text) : null;
      if (!date && !amount) continue;

      var downloadEl = el.querySelector('a[href*="download"], a[href*="pdf"], a[href*=".pdf"]');

      rows.push({
        index: rows.length,
        amount: amount !== null ? String(amount) : "",
        date: date ? date.toISOString().slice(0, 10) : "",
        description: text.slice(0, 100),
        hasDownload: !!downloadEl,
      });
    }

    return rows;
  }

  /**
   * Collect a snapshot of the page for Tier 2 agent.
   * Similar to collectPageData() but without bodyHTML (too large for API).
   */
  function collectReplaySnapshot() {
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll("button, [role='button']")
    ).slice(0, 50).map(function (b, i) {
      return {
        index: i,
        text: (b.textContent || "").trim().slice(0, 100),
        ariaLabel: b.getAttribute("aria-label") || "",
        tagName: (b.tagName || "").toLowerCase(),
      };
    });

    var links = Array.prototype.slice.call(
      document.querySelectorAll("a[href]")
    ).slice(0, 50).map(function (a, i) {
      return {
        index: i,
        text: (a.textContent || "").trim().slice(0, 100),
        href: (a.getAttribute("href") || "").slice(0, 200),
      };
    });

    var headings = Array.prototype.slice.call(
      document.querySelectorAll("h1, h2, h3, h4")
    ).slice(0, 20).map(function (h) {
      return (h.textContent || "").trim().slice(0, 100);
    });

    var tables = document.querySelectorAll("table").length;

    // Get visible text (truncated)
    var visibleText = (document.body.innerText || "").slice(0, 3000);

    return {
      url: window.location.href,
      title: document.title,
      buttons: buttons,
      links: links,
      headings: headings,
      tables: tables,
      visibleText: visibleText,
      pageType: classifyPage(),
      pagination: detectPagination(),
      invoiceLikeRows: extractInvoiceLikeRows(),
    };
  }

  // ============================================================================
  // Draggable Panel with Corner-Snapping
  // ============================================================================

  /**
   * Make a fixed-position panel draggable by its header.
   * On mouseup, the panel snaps to the nearest corner with a smooth transition.
   * @param {HTMLElement} panel - The panel element (position:fixed)
   * @param {HTMLElement} handle - The drag handle (e.g., header element)
   */
  function makeDraggable(panel, handle) {
    var isDragging = false;
    var startX = 0, startY = 0;
    var panelStartX = 0, panelStartY = 0;
    var MARGIN = 12;

    handle.style.cursor = "grab";
    handle.style.userSelect = "none";

    function getPanelRect() {
      return panel.getBoundingClientRect();
    }

    function setPosition(x, y, animate) {
      if (animate) {
        panel.style.transition = "left 0.3s ease, top 0.3s ease, right 0.3s ease, bottom 0.3s ease";
      } else {
        panel.style.transition = "none";
      }
      // Clear all positional properties and use left/top for dragging
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = x + "px";
      panel.style.top = y + "px";
    }

    function snapToCorner() {
      var rect = getPanelRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var vw = window.innerWidth;
      var vh = window.innerHeight;

      // Determine nearest corner
      var isRight = cx > vw / 2;
      var isBottom = cy > vh / 2;

      // Clear left/top and use corner-based positioning
      panel.style.transition = "left 0.3s ease, top 0.3s ease, right 0.3s ease, bottom 0.3s ease";
      if (isRight) {
        panel.style.left = "auto";
        panel.style.right = MARGIN + "px";
      } else {
        panel.style.right = "auto";
        panel.style.left = MARGIN + "px";
      }
      if (isBottom) {
        panel.style.top = "auto";
        panel.style.bottom = MARGIN + "px";
      } else {
        panel.style.bottom = "auto";
        panel.style.top = MARGIN + "px";
      }

      // Clean up transition after animation
      setTimeout(function () {
        panel.style.transition = "none";
      }, 350);
    }

    handle.addEventListener("mousedown", function (e) {
      // Don't start drag on buttons
      if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      var rect = getPanelRect();
      panelStartX = rect.left;
      panelStartY = rect.top;
      handle.style.cursor = "grabbing";
      e.preventDefault();
    });

    document.addEventListener("mousemove", function (e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newX = panelStartX + dx;
      var newY = panelStartY + dy;
      // Clamp to viewport
      var rect = getPanelRect();
      newX = Math.max(0, Math.min(newX, window.innerWidth - rect.width));
      newY = Math.max(0, Math.min(newY, window.innerHeight - rect.height));
      setPosition(newX, newY, false);
    });

    document.addEventListener("mouseup", function () {
      if (!isDragging) return;
      isDragging = false;
      handle.style.cursor = "grab";
      snapToCorner();
    });
  }

  // ============================================================================
  // Replay Overlay UI
  // ============================================================================

  function ensureReplayOverlay(partnerName) {
    if (document.getElementById(REPLAY_OVERLAY_ID)) return;

    // Push page content inward so it's not hidden behind the 16px border.
    // Apply to both html and body — some sites (Google Ads, SPAs) lay out on body.
    if (!window.__tsReplayOriginalStyles) {
      var de = document.documentElement;
      var bd = document.body;
      window.__tsReplayOriginalStyles = {
        htmlPadding: de.style.padding || "",
        htmlBoxSizing: de.style.boxSizing || "",
        bodyPadding: bd.style.padding || "",
        bodyBoxSizing: bd.style.boxSizing || "",
        bodyMargin: bd.style.margin || "",
      };
    }
    document.documentElement.style.setProperty("padding", "16px", "important");
    document.documentElement.style.setProperty("box-sizing", "border-box", "important");
    document.body.style.setProperty("padding", "16px", "important");
    document.body.style.setProperty("box-sizing", "border-box", "important");
    document.body.style.setProperty("margin", "0", "important");

    var styleId = "ts-replay-overlay-styles";
    if (!document.getElementById(styleId)) {
      var style = document.createElement("style");
      style.id = styleId;
      style.textContent =
        "@keyframes ts-replay-gradient { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } } " +
        "@keyframes ts-replay-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } } " +
        "@keyframes ts-replay-glow { 0%, 100% { opacity: 0.3; filter: blur(12px); } 50% { opacity: 0.5; filter: blur(16px); } } " +
        "#" + REPLAY_OVERLAY_ID + "-glow { position: fixed !important; inset: -20px !important; " +
          "background: linear-gradient(90deg, #06b6d4, #8b5cf6, #06b6d4) !important; " +
          "background-size: 300% 300% !important; animation: ts-replay-gradient 3s ease infinite, ts-replay-glow 4s ease-in-out infinite !important; " +
          "pointer-events: none !important; z-index: 2147483645 !important; " +
          "-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "-webkit-mask-composite: xor !important; mask-composite: exclude !important; padding: 24px !important; } " +
        "#" + REPLAY_OVERLAY_ID + "-border { position: fixed !important; inset: 0 !important; " +
          "background: linear-gradient(90deg, #06b6d4, #8b5cf6, #06b6d4) !important; " +
          "background-size: 300% 300% !important; animation: ts-replay-gradient 3s ease infinite !important; " +
          "pointer-events: none !important; z-index: 2147483646 !important; " +
          "-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important; " +
          "-webkit-mask-composite: xor !important; mask-composite: exclude !important; padding: 16px !important; }";
      (document.head || document.documentElement).appendChild(style);
    }

    // Glow
    var glow = document.createElement("div");
    glow.id = REPLAY_OVERLAY_ID + "-glow";
    document.body.appendChild(glow);

    // Border
    var border = document.createElement("div");
    border.id = REPLAY_OVERLAY_ID + "-border";
    document.body.appendChild(border);

    // Panel
    var panel = document.createElement("div");
    panel.id = REPLAY_OVERLAY_ID;
    panel.style.cssText = "position:fixed; right:12px; bottom:12px; width:300px; border-radius:14px; " +
      "background:rgba(6,16,38,0.94); backdrop-filter:blur(8px); color:#e6f2ff; " +
      "font:500 12px/1.4 'Inter',sans-serif; box-shadow:0 12px 30px rgba(4,11,24,0.5); z-index:2147483647;";

    // Header
    var header = document.createElement("div");
    header.style.cssText = "padding:12px 14px; border-bottom:1px solid rgba(6,182,212,0.3); display:flex; align-items:center; justify-content:space-between;";

    var titleCol = document.createElement("div");
    var title = document.createElement("div");
    title.style.cssText = "font-weight:700; font-size:13px; color:#22d3ee;";
    title.textContent = "FiBuKI Replay";
    var subtitle = document.createElement("div");
    subtitle.style.cssText = "font-size:10px; opacity:0.7; margin-top:2px;";
    subtitle.textContent = partnerName || "Replaying...";
    titleCol.appendChild(title);
    titleCol.appendChild(subtitle);

    var playIcon = document.createElement("span");
    playIcon.style.cssText = "font-size:16px; animation:ts-replay-pulse 1.5s ease-in-out infinite;";
    playIcon.textContent = "\u25B6"; // Play symbol

    header.appendChild(titleCol);
    header.appendChild(playIcon);

    // Status
    var status = document.createElement("div");
    status.id = REPLAY_OVERLAY_ID + "-status";
    status.style.cssText = "padding:10px 14px; font-size:11px; color:#67e8f9;";
    status.textContent = "Starting replay...";

    // Progress
    var progress = document.createElement("div");
    progress.id = REPLAY_OVERLAY_ID + "-progress";
    progress.style.cssText = "padding:0 14px 10px; font-size:10px; opacity:0.6;";
    progress.textContent = "Step 0/0";

    panel.appendChild(header);
    panel.appendChild(status);
    panel.appendChild(progress);
    document.body.appendChild(panel);

    // Make panel draggable by header, snaps to nearest corner
    makeDraggable(panel, header);
  }

  function updateReplayOverlay(step, total, message) {
    var status = document.getElementById(REPLAY_OVERLAY_ID + "-status");
    if (status) status.textContent = message || "";
    var progress = document.getElementById(REPLAY_OVERLAY_ID + "-progress");
    if (progress) progress.textContent = "Step " + step + "/" + total;
  }

  function removeReplayOverlay() {
    var ids = [REPLAY_OVERLAY_ID, REPLAY_OVERLAY_ID + "-border", REPLAY_OVERLAY_ID + "-glow",
               REPLAY_OVERLAY_ID + "-skip-auth"];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.remove();
    }
    var style = document.getElementById("ts-replay-overlay-styles");
    if (style) style.remove();

    // Restore original html/body styles
    if (window.__tsReplayOriginalStyles) {
      var orig = window.__tsReplayOriginalStyles;
      document.documentElement.style.padding = orig.htmlPadding;
      document.documentElement.style.boxSizing = orig.htmlBoxSizing;
      document.body.style.padding = orig.bodyPadding;
      document.body.style.boxSizing = orig.bodyBoxSizing;
      document.body.style.margin = orig.bodyMargin;
      window.__tsReplayOriginalStyles = undefined;
    }
  }

  // Expose globally for content.js
  window.__tsReplayEngine = {
    ReplayStateMachine: ReplayStateMachine,
    findElement: findElement,
    parseInvoiceTable: parseInvoiceTable,
    matchInvoiceRow: matchInvoiceRow,
    scanPageForInvoiceMatch: scanPageForInvoiceMatch,
    collectReplaySnapshot: collectReplaySnapshot,
    classifyPage: classifyPage,
    detectPagination: detectPagination,
    extractInvoiceLikeRows: extractInvoiceLikeRows,
    ensureReplayOverlay: ensureReplayOverlay,
    updateReplayOverlay: updateReplayOverlay,
    removeReplayOverlay: removeReplayOverlay,
    isAuthPage: isAuthPage,
    makeDraggable: makeDraggable,
    STATES: STATES,
  };
})();
