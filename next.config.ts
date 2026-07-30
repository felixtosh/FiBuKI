import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const IS_DEV = process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------
// Self-host backend (work item 6): swap the Firebase client SDK for the
// API-client shims at module resolution, the same trick the backend shims use.
// Active ONLY when FIBUKI_BACKEND=selfhost; a normal Firebase build is a no-op.
// Shims live in lib/selfhost/, so the app code is unmodified. See
// frontend-shim-design.md §1.
// ---------------------------------------------------------------------------
const IS_SELFHOST = process.env.FIBUKI_BACKEND === "selfhost";
const SELFHOST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib/selfhost");
const SELFHOST_SHIMS: Record<string, string> = {
  "firebase/app": "app-shim.ts",
  "firebase/firestore": "firestore-client.ts",
  "firebase/storage": "storage-client.ts",
  "firebase/functions": "functions-client.ts",
  "firebase/auth": "auth-client.ts",
  // SERVER-side auth for the ~45 routes under app/api. Not a client SDK, but the
  // same problem: the upstream helper verifies a FIREBASE ID token (RS256, via
  // firebase-admin), while a self-host deployment's tokens come from Better Auth and
  // are signed EdDSA. firebase-admin rejects them outright —
  //   "incorrect algorithm. Expected RS256 but got EdDSA"
  // — so every server-authenticated route answered 401. Aliasing here fixes all of
  // them at once and keeps Firebase code out of a Firebase-free build, rather than
  // branching inside the helper. Same technique the API build already uses for
  // utils/mailer and utils/buildDownloadUrl.
  "@/lib/auth/get-server-user": "get-server-user-shim.ts",
};
// Webpack resolves aliases to absolute filesystem paths.
const SELFHOST_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(SELFHOST_SHIMS).map(([spec, file]) => [spec, path.join(SELFHOST_DIR, file)]),
);
// Turbopack's resolveAlias interprets values as project-root-relative (or bare
// module) specifiers — an ABSOLUTE path gets mis-resolved (e.g. /app/lib/... →
// ./app/lib/...), so it must get `./lib/selfhost/<file>` instead.
const SELFHOST_ALIASES_TURBO: Record<string, string> = Object.fromEntries(
  Object.entries(SELFHOST_SHIMS).map(([spec, file]) => [spec, `./lib/selfhost/${file}`]),
);

// The self-host client talks to fibuki-api and Authentik from the browser, so
// the strict CSP must allow those origins. connect-src: XHR/fetch to the data
// plane (API) + OIDC discovery/token endpoints (issuer). img-src/frame-src: the
// API origin serves storage downloads rendered as <img>/<iframe> (?token= URLs).
function safeOrigin(u?: string): string | null {
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}
const SELFHOST_API_ORIGIN = IS_SELFHOST ? safeOrigin(process.env.NEXT_PUBLIC_FIBUKI_API_URL) : null;
const SELFHOST_OIDC_ORIGIN = IS_SELFHOST ? safeOrigin(process.env.NEXT_PUBLIC_OIDC_ISSUER) : null;
const SELFHOST_CONNECT_SRC = [SELFHOST_API_ORIGIN, SELFHOST_OIDC_ORIGIN].filter(Boolean) as string[];
const SELFHOST_MEDIA_SRC = [SELFHOST_API_ORIGIN].filter(Boolean) as string[];

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
    ...SELFHOST_MEDIA_SRC,
    ...DEV_IMG_SRC,
  ],
  "font-src": ["'self'", "data:"],
  "connect-src": [
    "'self'",
    // PdfPageViewer (pdf.js) reads the document over XHR, and on the self-host
    // stack that document is a blob: URL — the file is fetched with an
    // Authorization header and handed to the viewer as a blob rather than as a
    // tokenised URL (hooks/use-file-object-url.ts). `'self'` does NOT cover the
    // blob: scheme, so without this the full-screen preview is blocked while the
    // iframe thumbnail still works, because frame-src already allows blob:.
    //
    // Low risk: a blob: URL is origin-bound, unguessable, and created by this page,
    // so this permits reading our own buffers and cannot reach an external host.
    // Same reasoning already applied to img-src, worker-src and frame-src.
    "blob:",
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
    ...SELFHOST_CONNECT_SRC,
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
    // Self-host storage downloads render as <iframe> from the API origin.
    ...SELFHOST_MEDIA_SRC,
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
  // imapflow is a Node-only IMAP client used by /api/mail/imap/connect; keep it
  // out of the bundle so its dynamic requires resolve at runtime.
  serverExternalPackages: ["imapflow"],
  // Surface the backend choice to the client bundle so the shared UI can gate
  // self-host-only differences (e.g. hiding the GitHub button, which the
  // self-host auth client can't service). FIBUKI_BACKEND itself is server-only;
  // this is the NEXT_PUBLIC_* mirror the browser reads. Absent (undefined) in a
  // normal Firebase build. See lib/auth/social-providers.ts.
  ...(IS_SELFHOST ? { env: { NEXT_PUBLIC_FIBUKI_BACKEND: "selfhost" } } : {}),
  // Turbopack (Next 16 default for dev + build): exact-specifier aliases.
  ...(IS_SELFHOST
    ? { turbopack: { resolveAlias: SELFHOST_ALIASES_TURBO } }
    : {}),
  // Webpack fallback (e.g. `next build --webpack`): same map, exact match via
  // the `$` suffix so `firebase/firestore/lite`-style subpaths are untouched.
  webpack(config: { resolve: { alias: Record<string, string> } }) {
    if (IS_SELFHOST) {
      for (const [spec, target] of Object.entries(SELFHOST_ALIASES)) {
        config.resolve.alias[`${spec}$`] = target;
      }
    }
    return config;
  },
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
