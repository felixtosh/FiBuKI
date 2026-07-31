/**
 * Client blob-plane router (work item 6, slice C): the server side the
 * frontend storage shim (lib/selfhost/storage-client.ts) talks to. Serves
 * functions/src/selfhost/storage-shim.ts's blob surface over HTTP.
 *
 *   POST   /upload?path=<enc>&contentType=<enc>   raw body -> { path, downloadUrl }
 *   GET    /download/<path>                       -> raw bytes (streams file.download())
 *   DELETE /object/<path>                          -> { ok: true } (idempotent)
 *
 * All routes require a valid Bearer token, EXCEPT the download route ALSO
 * accepts `?token=` (verified the same way) so an <img>/<iframe> `src` — which
 * can't set an Authorization header — still authenticates.
 *
 * No `/v0/b/:bucket/o/` GCS-compat route: the client shim never builds one
 * (fresh-data + write-time helper make it dead code — frontend-shim-design
 * §2.6 decision).
 *
 * Errors use the callable wire shape ({ error: { message, status } }) so the
 * client shim maps one format, same convention as data-plane.ts.
 */

import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import { getStorage } from "./storage-shim";
import { makeRateLimiter } from "./rate-limit";
import type { AuthData } from "./https-shim";
import type { TokenVerifier } from "./host";

class StorageRouteError extends Error {
  constructor(
    public readonly code: "invalid-argument" | "unauthenticated" | "permission-denied" | "not-found" | "internal",
    message: string,
  ) {
    super(message);
  }
}

const CODE_TO_HTTP: Record<string, number> = {
  "invalid-argument": 400,
  unauthenticated: 401,
  "permission-denied": 403,
  "not-found": 404,
  internal: 500,
};

function sendError(res: Response, code: string, message: string): void {
  res.status(CODE_TO_HTTP[code] ?? 500).json({
    error: { message, status: code.toUpperCase().replace(/-/g, "_") },
  });
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 404;
}

/** Reject leading-slash / ".." traversal and malformed (empty-segment) paths — loud 400. */
function assertSafePath(path: string): void {
  if (!path) throw new StorageRouteError("invalid-argument", "path is required");
  if (path.startsWith("/") || path.includes("..")) {
    throw new StorageRouteError("invalid-argument", `unsafe storage path "${path}"`);
  }
  if (path.split("/").some((seg) => seg.length === 0)) {
    throw new StorageRouteError("invalid-argument", `malformed storage path "${path}"`);
  }
}

/** Express decodes the wildcard capture group itself; no extra decodeURIComponent needed. */
function wildcardPath(req: Request): string {
  const raw = (req.params as Record<string, string>)[0];
  return typeof raw === "string" ? raw : "";
}

export function createStorageRoutes(verifyToken: TokenVerifier, options?: { jsonLimit?: string }): Router {
  const router = express.Router();

  // DoS/bruteforce backstop for the blob plane.
  router.use(makeRateLimiter(600));

  const bearerToken = (req: Request): string | undefined => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
    return undefined;
  };

  // All storage routes require a verified identity. The download route also
  // accepts ?token= (checked with the same verifier) for <img>/<iframe> src.
  router.use(async (req: Request & { fibukiAuth?: AuthData }, res: Response, next: NextFunction) => {
    const isDownload = req.method === "GET" && req.path.startsWith("/download/");
    const queryToken = isDownload && typeof req.query.token === "string" ? req.query.token : undefined;
    const token = bearerToken(req) ?? queryToken;
    if (!token) {
      sendError(res, "unauthenticated", "Storage routes require a Bearer token (or ?token= on downloads).");
      return;
    }
    try {
      const auth = await verifyToken(token);
      if (auth === null) {
        sendError(res, "unauthenticated", "Invalid authentication token.");
        return;
      }
      req.fibukiAuth = auth;
      next();
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/upload",
    // Reuses the shared "jsonLimit" option name (host.ts passes one limit for
    // all client-plane mounts) even though this body is raw bytes, not JSON.
    // `type: () => true` parses EVERY upload body regardless of Content-Type:
    // browsers/undici may omit the header on a Blob/Uint8Array send, and a
    // `*/*` matcher skips parsing when no Content-Type is present (leaving
    // req.body a non-Buffer and silently storing an empty object).
    express.raw({ type: () => true, limit: options?.jsonLimit ?? "32mb" }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const path = typeof req.query.path === "string" ? req.query.path : "";
        assertSafePath(path);
        const contentType = typeof req.query.contentType === "string" ? req.query.contentType : undefined;

        let customMetadata: Record<string, string> | undefined;
        const customHeader = req.headers["x-fibuki-custom"];
        if (typeof customHeader === "string") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.from(customHeader, "base64").toString("utf-8"));
          } catch {
            throw new StorageRouteError("invalid-argument", "malformed x-fibuki-custom header");
          }
          // Custom metadata becomes storage headers: accept only a flat map
          // of primitive values with safe key names, coerced to strings.
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new StorageRouteError("invalid-argument", "x-fibuki-custom must be a JSON object");
          }
          customMetadata = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            // Literal comparisons on purpose — the guard shape CodeQL recognizes.
            if (k === "__proto__" || k === "constructor" || k === "prototype") {
              throw new StorageRouteError("invalid-argument", `unsafe custom metadata key "${k}"`);
            }
            if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
              throw new StorageRouteError(
                "invalid-argument",
                `custom metadata value for "${k}" must be a primitive`,
              );
            }
            customMetadata[k] = String(v);
          }
        }

        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        await getStorage()
          .bucket()
          .file(path)
          .save(buf, {
            contentType,
            metadata: customMetadata ? { metadata: customMetadata } : undefined,
          });

        const base = (process.env.FIBUKI_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
        const encodedPath = path.split("/").map(encodeURIComponent).join("/");
        res.status(200).json({ path, downloadUrl: `${base}/__storage/download/${encodedPath}` });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/download/*", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const path = wildcardPath(req);
      assertSafePath(path);
      const file = getStorage().bucket().file(path);
      const [meta] = await file.getMetadata();
      const [data] = await file.download();
      if (meta.contentType) res.setHeader("content-type", meta.contentType);
      res.status(200).send(data);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/object/*", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const path = wildcardPath(req);
      assertSafePath(path);
      try {
        await getStorage().bucket().file(path).delete();
      } catch (err) {
        if (!isNotFound(err)) throw err; // missing object -> idempotent success
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Error funnel: route errors get their code, a storage-shim 404 maps to
  // not-found, everything else stays opaque.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof StorageRouteError) {
      sendError(res, err.code, err.message);
    } else if (isNotFound(err)) {
      sendError(res, "not-found", err instanceof Error ? err.message : "Not found");
    } else if (!res.headersSent) {
      console.error("[storage-routes] internal error:", err);
      sendError(res, "internal", "INTERNAL");
    }
  });

  return router;
}
