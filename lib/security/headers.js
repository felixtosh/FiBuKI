// Response headers for every page, consumed by next.config.ts headers().
//
// Cross-Origin-Embedder-Policy is deliberately absent (#255): cross-origin
// isolation buys nothing FiBuKI uses, and require-corp breaks the Google
// sign-in popup and the document and mail-attachment viewers.

/** @param {string} csp */
function baseHeaders(csp) {
  return [
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(self), interest-cohort=()",
    },
    { key: "Content-Security-Policy", value: csp },
  ];
}

// Outgoing emails hotlink this image, and webmail clients load it from their
// own origin, so it must stay cross-origin readable. Next applies the later
// rule's value when two rules set the same key.
const EMBEDDABLE_ASSETS = ["/email-image.png"];

/** @param {string} csp */
export function securityHeaderRules(csp) {
  return [
    { source: "/(.*)", headers: baseHeaders(csp) },
    ...EMBEDDABLE_ASSETS.map((source) => ({
      source,
      headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }],
    })),
  ];
}
