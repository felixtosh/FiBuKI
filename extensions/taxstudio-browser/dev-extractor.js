// Dev extractor script - runs in sandbox with eval allowed
// Uses command-based API: ctx.click(index), ctx.clickSelector(sel), ctx.emitCandidates(urls)
// Pre-collected page data available via ctx.pageSnapshot and ctx.url

ctx.log("Dev extractor loaded", ctx.url);

var snapshot = ctx.getPageSnapshot();

// Strict host check: parses the URL and compares the hostname
function hostMatches(url, host) {
  if (!url) return false;
  try {
    var h = new URL(String(url)).hostname.toLowerCase();
    return h === host || h.endsWith("." + host);
  } catch (e) {
    return false;
  }
}

// Google Admin billing page detection
if (hostMatches(ctx.url, "admin.google.com") && ctx.url.includes("billing")) {
  ctx.log("Google Admin billing page detected");

  // Log collected data
  var invoiceLinks = snapshot.invoiceLinks || [];
  var menuItems = snapshot.menuItems || [];
  var expandables = snapshot.expandables || [];

  ctx.log("Page has:", invoiceLinks.length, "invoice links,", menuItems.length, "menu items,", expandables.length, "expandables");

  // Log invoice links
  invoiceLinks.forEach(function (link, i) {
    ctx.log("  Invoice " + i + ": \"" + link.text + "\" href=" + (link.href || "").slice(0, 60));
  });

  // Log expandables
  expandables.forEach(function (exp, i) {
    ctx.log("  Expandable " + i + ": \"" + exp.text.slice(0, 40) + "\" expanded=" + exp.expanded);
  });

  // Send debug snapshot
  ctx.sendDebugLog({
    type: "google_admin_snapshot",
    snapshot: snapshot,
  });

  // Strategy: Expand "Documents" section, then click invoice links, then click Download

  // 1. Try to expand "Documents" or "PDF" sections if collapsed
  ctx.log("Expanding document sections...");
  ctx.clickExpandable("document");
  ctx.sleep(500);
  ctx.clickExpandable("pdf");
  ctx.sleep(500);

  // 2. Refresh snapshot after expanding
  ctx.refreshSnapshot();
  ctx.sleep(300);

  // 3. Click first few invoice links and try to download
  var maxInvoices = Math.min(3, invoiceLinks.length);
  for (var i = 0; i < maxInvoices; i++) {
    ctx.log("Clicking invoice link " + i);
    ctx.clickInvoiceLink(i);
    ctx.sleep(800); // Wait for dropdown to appear

    // 4. Look for Download menu item and click it
    ctx.log("Looking for Download menu item...");
    ctx.clickMenuItem("download");
    ctx.sleep(1000); // Wait for download to start

    // Refresh for next iteration
    ctx.refreshSnapshot();
    ctx.sleep(300);
  }

  // Check for any data-attribute URLs that were pre-collected
  var urls = ctx.findDataAttributeDownloads();
  if (urls && urls.length) {
    ctx.log("Found data-attribute urls:", urls.length);
    urls.forEach(function (url, i) {
      ctx.log("  URL " + i + ": " + url.slice(0, 100));
    });
    ctx.emitCandidates(urls, new URL(ctx.url).origin);
  } else {
    ctx.log("No data-attribute urls found");
  }

} else {
  // Default behavior for other sites
  var urls = ctx.findDataAttributeDownloads();
  if (urls && urls.length) {
    ctx.log("Found data-attribute urls", urls.length);
    ctx.emitCandidates(urls, new URL(ctx.url).origin);
  } else {
    ctx.log("No data-attribute urls found");
  }
}
