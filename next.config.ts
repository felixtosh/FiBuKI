import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'", "https://accounts.google.com"],
  "manifest-src": ["'self'"],
  "worker-src": ["'self'", "blob:"],
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "https://apis.google.com",
    "https://www.gstatic.com",
    "https://www.google.com",
    "https://www.googletagmanager.com",
  ],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    "https://*.googleusercontent.com",
    "https://*.googleapis.com",
    "https://www.google.com",
    "https://www.gstatic.com",
    "https://asset.brandfetch.io",
  ],
  "font-src": ["'self'", "data:"],
  "connect-src": [
    "'self'",
    "https://*.googleapis.com",
    "https://*.cloudfunctions.net",
    "https://*.firebaseio.com",
    "https://*.firebaseapp.com",
    "https://firebasestorage.googleapis.com",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://oauth2.googleapis.com",
    "https://*.cloud.langfuse.com",
    "https://api.truelayer.com",
    "https://api.truelayer-sandbox.com",
    "https://auth.truelayer.com",
    "https://auth.truelayer-sandbox.com",
    "https://*.finapi.io",
    "https://*.plaid.com",
    "https://www.google.com",
    "https://www.gstatic.com",
  ],
  "frame-src": [
    "'self'",
    "https://*.firebaseapp.com",
    "https://accounts.google.com",
    "https://www.google.com",
  ],
  "upgrade-insecure-requests": [],
};

const CSP = Object.entries(CSP_DIRECTIVES)
  .map(([directive, values]) =>
    values.length > 0 ? `${directive} ${values.join(" ")}` : directive
  )
  .join("; ");

const SECURITY_HEADERS = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
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
  { key: "Content-Security-Policy", value: CSP },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/__/auth/:path*",
        destination: "https://taxstudio-f12fb.firebaseapp.com/__/auth/:path*",
      },
    ];
  },
};

export default withNextIntl(nextConfig);
