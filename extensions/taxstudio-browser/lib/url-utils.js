/**
 * URL utility functions for FiBuKI browser extension
 * Extracted for testability
 */

/**
 * Strict host check: parses the URL and compares the hostname, so
 * "evil.com/payments.google.com" never matches.
 * @param {string} url - The URL to check
 * @param {string} host - Hostname to match (also matches subdomains)
 * @returns {boolean}
 */
function hostMatches(url, host) {
  if (!url) return false;
  try {
    var h = new URL(String(url)).hostname.toLowerCase();
    return h === host || h.endsWith("." + host);
  } catch (err) {
    return false;
  }
}

/**
 * Check if a URL looks like it could be a PDF download
 * @param {string} url - The URL to check
 * @returns {boolean}
 */
function shouldTrackRequest(url) {
  if (!url) return false;
  var lowerUrl = String(url).toLowerCase();

  // Check for Google Payments PDF URLs
  if (hostMatches(url, "payments.google.com")) {
    if (lowerUrl.indexOf("apis-secure/doc") !== -1) return true;
  }

  // Check for doc parameter (generic PDF indicator)
  if (lowerUrl.indexOf("doc=") !== -1) return true;

  return false;
}

/**
 * Check if a URL is a Google login challenge page
 * @param {string} url - The URL to check
 * @returns {boolean}
 */
function isLoginChallenge(url) {
  if (!url) return false;
  var lowerUrl = String(url).toLowerCase();
  return lowerUrl.indexOf("https://accounts.google.com/v3/signin/challenge") === 0;
}

/**
 * Check if a URL looks like a login/auth page
 * @param {string} url - The URL to check
 * @returns {boolean}
 */
function isLoginPage(url) {
  if (!url) return false;
  var lowerUrl = String(url).toLowerCase();

  var loginPatterns = [
    "/signin",
    "/login",
    "/auth",
    "/oauth",
    "/sso",
    "/authenticate",
    "/session",
    "accounts.google.com",
  ];

  for (var i = 0; i < loginPatterns.length; i++) {
    if (lowerUrl.indexOf(loginPatterns[i]) !== -1) {
      return true;
    }
  }

  return false;
}

/**
 * Extract domain from a URL for display
 * @param {string} url - The URL to extract domain from
 * @returns {string}
 */
function extractDomain(url) {
  if (!url) return "";
  try {
    var parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch (err) {
    return "";
  }
}

/**
 * Check if a URL looks like a PDF download link
 * @param {string} url - The URL to check
 * @returns {boolean}
 */
function looksLikeDownload(url) {
  if (!url) return false;
  var lowerUrl = String(url).toLowerCase();

  // Check file extension
  if (lowerUrl.match(/\.pdf(\?|$|#)/)) return true;

  // Check for download-related URL patterns
  var downloadPatterns = [
    "download",
    "export",
    "invoice",
    "receipt",
    "document",
    "attachment",
  ];

  for (var i = 0; i < downloadPatterns.length; i++) {
    if (lowerUrl.indexOf(downloadPatterns[i]) !== -1) {
      return true;
    }
  }

  return false;
}

/**
 * Validate that a URL is safe to fetch (same origin check)
 * @param {string} url - The URL to validate
 * @param {string} pageOrigin - The origin of the current page
 * @returns {boolean}
 */
function isSameOrigin(url, pageOrigin) {
  if (!url || !pageOrigin) return false;
  try {
    var urlOrigin = new URL(url).origin;
    return urlOrigin === pageOrigin;
  } catch (err) {
    return false;
  }
}

// Export for testing and use
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    hostMatches,
    shouldTrackRequest,
    isLoginChallenge,
    isLoginPage,
    extractDomain,
    looksLikeDownload,
    isSameOrigin,
  };
}
