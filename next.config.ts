import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const IS_DEV = process.env.NODE_ENV !== "production";

// In dev we need to talk to the Firebase emulators (auth:9099, firestore:8080,
// storage:9199, functions:5001) and Next's HMR (ws://localhost:*) over plain
// HTTP. Production keeps the strict allow-list for CASA Tier 2.
const DEV_CONNECT_SRC = IS_DEV
  ? [
      "http://127.0.0.1:*",
      "http://localhost:*",
      "ws://127.0.0.1:*",
      "ws://localhost:*",
    ]
  : [];

const DEV_IMG_SRC = IS_DEV
  ? ["http://127.0.0.1:*", "http://localhost:*"]
  : [];

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
    ...DEV_IMG_SRC,
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
    ...DEV_CONNECT_SRC,
  ],
  "frame-src": [
    "'self'",
    // PDF/file previews render fetched attachments as iframes from blob: URLs.
    "blob:",
    // Issued invoice PDFs are served from Firebase Storage signed URLs.
    "https://firebasestorage.googleapis.com",
    "https://*.firebaseapp.com",
    "https://accounts.google.com",
    "https://www.google.com",
    // Firebase Auth emulator injects an iframe for OAuth popup flows in dev.
    ...(IS_DEV ? ["http://127.0.0.1:*", "http://localhost:*"] : []),
  ],
  // `upgrade-insecure-requests` would rewrite http://127.0.0.1:* emulator URLs
  // to https://, which the emulators don't serve. Only apply in production.
  ...(IS_DEV ? {} : { "upgrade-insecure-requests": [] }),
};

const CSP = Object.entries(CSP_DIRECTIVES)
  .map(([directive, values]) =>
    values.length > 0 ? `${directive} ${values.join(" ")}` : directive
  )
  .join("; ");

const SECURITY_HEADERS = [
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
  { key: "Content-Security-Policy", value: CSP },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
  async rewrites() {
    // In dev the Firebase Auth emulator hosts its own /__/auth/ handler at
    // 127.0.0.1:9099; forwarding to prod intercepts the OAuth callback and
    // breaks sign-in via the emulator.
    if (IS_DEV) return [];
    return [
      {
        source: "/__/auth/:path*",
        destination: "https://taxstudio-f12fb.firebaseapp.com/__/auth/:path*",
      },
    ];
  },
};

export default withNextIntl(nextConfig);
