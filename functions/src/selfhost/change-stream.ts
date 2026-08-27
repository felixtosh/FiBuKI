/**
 * Server-Sent Events stream of document changes, fed by Postgres LISTEN.
 *
 * Completes the realtime path: `notifyChange` (change-notify.ts) emits on every
 * committed write from ANY process — an API replica, the cron host, a queue worker
 * — and this fans those out to connected browsers so `onSnapshot` refetches
 * immediately rather than on its next poll.
 *
 * ## Connection model
 *
 * ONE dedicated Postgres connection holds the LISTEN for the whole process. It
 * cannot come from the pool: `LISTEN` is session state, and a pooled connection
 * would stop delivering the moment it was recycled to another caller. Every SSE
 * client is then served from that single subscription, so N browsers cost one
 * database connection rather than N.
 *
 * ## Auth and isolation
 *
 * The route is mounted behind the host's normal bearer verification, and each
 * subscriber is pinned to the tenant of its verified token. A notification is
 * delivered only to subscribers whose tenant matches — cross-tenant leakage would
 * otherwise be a single string comparison away.
 *
 * Payloads carry identity only (collection, id), never document contents, so even a
 * mis-scoped delivery would reveal that *something* changed rather than what. The
 * client refetches through the ordinary authenticated data plane, which re-checks
 * ownership.
 *
 * ## Degradation
 *
 * Realtime is an optimisation, not a correctness requirement: the client keeps
 * polling as a fallback, so a dropped stream, a failed LISTEN, or a database without
 * notification support (PGlite in tests) all degrade to today's behaviour rather
 * than breaking. Nothing here may throw into a request path.
 */

import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import { CHANGE_CHANNEL, parseChangeNotification, type ChangeNotification } from "./change-notify";

/** Verified identity attached to the request by {@link changeStreamAuth}. */
export interface StreamAuth {
  uid: string;
  /** Optional, matching AuthData in https-shim.ts — some verifiers omit claims. */
  token?: Record<string, unknown>;
}

/**
 * Bearer verification for the stream route.
 *
 * Deliberately header-only — no `?token=` escape hatch, unlike the download route.
 * That hatch exists there because an `<img>`/`<iframe>` src cannot carry a header;
 * a stream has no such constraint, since the client reads it with `fetch` +
 * `ReadableStream` rather than `EventSource` (which famously cannot send headers).
 * Keeping the credential out of the URL keeps it out of `Referer`, proxy logs and
 * browser history.
 */
export function changeStreamAuth(
  verifyToken: (token: string) => Promise<StreamAuth | null>,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Only guard the stream route; everything else under this mount is handled by
    // the data plane's own middleware.
    if (!req.path.startsWith("/stream")) {
      next();
      return;
    }
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    if (!token) {
      res.status(401).json({
        error: { status: "UNAUTHENTICATED", message: "Stream requires a bearer token." },
      });
      return;
    }
    try {
      const auth = await verifyToken(token);
      if (!auth) {
        res.status(401).json({
          error: { status: "UNAUTHENTICATED", message: "Invalid authentication token." },
        });
        return;
      }
      (req as Request & { fibukiAuth?: StreamAuth }).fibukiAuth = auth;
      next();
    } catch {
      res.status(401).json({
        error: { status: "UNAUTHENTICATED", message: "Invalid authentication token." },
      });
    }
  };
}

/** How often to write a comment frame so idle connections survive proxies. */
const HEARTBEAT_MS = 25_000;

/**
 * Caddy, nginx and most load balancers close an idle upstream response well before
 * an hour. A comment line (`: ping`) is valid SSE, ignored by EventSource and by our
 * client parser, and costs nothing.
 */
interface Subscriber {
  tenant: string;
  res: Response;
}

export interface ChangeStream {
  router: Router;
  /** Deliver a notification to matching subscribers. Exported for tests. */
  dispatch(change: ChangeNotification): void;
  /** Current subscriber count, for /healthz and tests. */
  subscriberCount(): number;
  /** Tear down the LISTEN connection and close every stream. */
  close(): Promise<void>;
}

export interface ChangeStreamOptions {
  /** Verified auth for a request, or null. Mirrors the host's verifier contract. */
  authOf: (req: Request) => { uid: string; tenant: string } | null;
  /**
   * Opens the dedicated LISTEN connection. Injected so tests can drive dispatch
   * directly, and so a database without LISTEN support simply yields null.
   */
  listen?: (onNotify: (payload: string) => void) => Promise<{ close: () => Promise<void> } | null>;
}

export function createChangeStream(options: ChangeStreamOptions): ChangeStream {
  const subscribers = new Set<Subscriber>();
  let listener: { close: () => Promise<void> } | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  function dispatch(change: ChangeNotification): void {
    for (const sub of subscribers) {
      // Tenant isolation. Everything else about this stream is best-effort; this
      // comparison is not.
      if (sub.tenant !== change.tenant) continue;
      try {
        sub.res.write(
          `data: ${JSON.stringify({ collection: change.collection, id: change.id, op: change.op })}\n\n`,
        );
      } catch {
        // Broken pipe — the 'close' handler will remove it.
      }
    }
  }

  // Start listening lazily on first subscriber, so a deployment that never opens a
  // stream never holds an extra connection.
  let starting: Promise<void> | null = null;
  async function ensureListening(): Promise<void> {
    if (listener || !options.listen) return;
    if (starting) return starting;
    starting = (async () => {
      try {
        listener = await options.listen!((payload) => {
          const change = parseChangeNotification(payload);
          if (change) dispatch(change);
        });
      } catch (err) {
        // Degrade to polling rather than failing the request.
        console.warn(
          "selfhost change-stream: LISTEN unavailable, clients fall back to polling:",
          err instanceof Error ? err.message : String(err),
        );
        listener = null;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  const router = express.Router();

  router.get("/stream", async (req: Request, res: Response) => {
    const auth = options.authOf(req);
    if (!auth) {
      res.status(401).json({ error: { status: "UNAUTHENTICATED", message: "Stream requires a bearer token." } });
      return;
    }

    await ensureListening();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Belt and braces for nginx-style proxies that buffer by default; without it
      // events sit in a buffer and the stream behaves worse than polling.
      "X-Accel-Buffering": "no",
    });
    // Flush headers immediately so the client knows the stream is open before the
    // first change arrives, which may be minutes away.
    res.write(`: connected\n\n`);

    const sub: Subscriber = { tenant: auth.tenant, res };
    subscribers.add(sub);
    // Realtime is invisible when it works and invisible when it does not: a client
    // that never reconnects looks exactly like a client with nothing to say. Two
    // lines per stream make a drop a fact rather than an inference — the gap
    // between a close and the next open IS the window where every listener fell
    // back to full-speed polling.
    const openedAt = Date.now();
    console.log(
      `selfhost change-stream: subscriber opened (tenant=${auth.tenant}, subscribers=${subscribers.size})`,
    );

    let closed = false;
    const cleanup = (): void => {
      if (closed) return; // "close" and "error" both fire on an aborted request
      closed = true;
      subscribers.delete(sub);
      console.log(
        `selfhost change-stream: subscriber closed after ${Math.round(
          (Date.now() - openedAt) / 1000,
        )}s (subscribers=${subscribers.size})`,
      );
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  heartbeat = setInterval(() => {
    for (const sub of subscribers) {
      try {
        sub.res.write(`: ping\n\n`);
      } catch {
        subscribers.delete(sub);
      }
    }
  }, HEARTBEAT_MS);
  // Never hold the process open for a heartbeat alone.
  heartbeat.unref?.();

  return {
    router,
    dispatch,
    subscriberCount: () => subscribers.size,
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      for (const sub of subscribers) {
        try {
          sub.res.end();
        } catch {
          /* already gone */
        }
      }
      subscribers.clear();
      if (listener) {
        await listener.close().catch(() => undefined);
        listener = null;
      }
    },
  };
}

/**
 * Real Postgres LISTEN, on a dedicated connection outside the pool.
 *
 * Returns null when DATABASE_URL is unset (tests run on embedded PGlite), so the
 * caller degrades to polling instead of failing.
 */
export async function makePgListener(
  onNotify: (payload: string) => void,
): Promise<{ close: () => Promise<void> } | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  client.on("notification", (msg) => {
    if (msg.channel === CHANGE_CHANNEL && msg.payload) onNotify(msg.payload);
  });
  // A dropped LISTEN connection would silently stop all realtime, so say so loudly
  // — the client is still polling, but an operator should see this.
  client.on("error", (err) => {
    console.error("selfhost change-stream: LISTEN connection error:", err.message);
  });
  await client.query(`LISTEN ${CHANGE_CHANNEL}`);

  return {
    close: async () => {
      try {
        await client.end();
      } catch {
        /* already closed */
      }
    },
  };
}
