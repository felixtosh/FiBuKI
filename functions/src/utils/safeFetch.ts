/**
 * Fetch a URL a USER supplied, without letting it reach our own network.
 *
 * Why: a tool like upload_file takes a URL from whoever calls it (an MCP client, a plugin, a
 * model reading an email). An unrestricted fetch lets that caller aim FiBuKI at
 * http://fibuki-api:8788, the database, the object store or a cloud metadata address, from inside
 * the network where those answer. On the self-host box all of them are one hop away.
 *
 * What this enforces, for the first request and every redirect:
 *  - https only, port 443, no credentials in the URL;
 *  - the host must resolve ONLY to public addresses. The check runs inside the connection's own
 *    DNS lookup, so the address that was checked is the address that is connected to; resolving
 *    once to check and again to connect would let a rebinding host answer differently;
 *  - IP-literal hosts are checked directly (a literal never goes through DNS);
 *  - a response size cap, a total time limit and a redirect limit.
 *
 * Fixed-host fetches (Google, Stripe, ...) do not need this; only URLs that came from outside.
 */

import dns from "dns";
import https from "https";
import net from "net";
import type { IncomingMessage } from "http";

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_REDIRECTS = 3;

/** The URL is not one we will fetch. The message says why, in words safe to show the caller. */
export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`URL not allowed: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

// ---------------------------------------------------------------------------
// Which addresses are public
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

/** [network, prefix length] for every IPv4 range that is not a public unicast address. */
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the cloud metadata address
  ["172.16.0.0", 12], // private (the docker bridge lives here)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];

function isPublicV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return !BLOCKED_V4.some(([network, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(network);
    return value >= start && value < start + size;
  });
}

/** Expand an IPv6 address to its eight 16-bit groups; null when it is not valid. */
function expandV6(address: string): number[] | null {
  let text = address.split("%")[0]; // drop a zone id
  // A dotted IPv4 tail ("::ffff:10.0.0.1") counts for two groups.
  const tail = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (net.isIPv4(tail[2]) === false) return null;
    const v4 = ipv4ToInt(tail[2]);
    text = `${tail[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const parsed = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return parsed.some(Number.isNaN) ? null : parsed;
}

function v4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPublicV6(address: string): boolean {
  const g = expandV6(address);
  if (!g) return false;
  const [a, b, c, d, e, f] = g;

  const allZeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroTo(7) && (g[7] === 0 || g[7] === 1)) return false; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d): judge by the IPv4 inside.
  if (allZeroTo(5) && (f === 0xffff || f === 0)) return isPublicV4(v4FromGroups(g[6], g[7]));
  // NAT64 (64:ff9b::/96) carries an IPv4 in the last 32 bits.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isPublicV4(v4FromGroups(g[6], g[7]));
  if (a === 0x2002) return isPublicV4(v4FromGroups(b, c)); // 6to4 embeds the IPv4 in groups 1-2
  if (a === 0x2001 && b === 0) return false; // Teredo
  if (a === 0x2001 && b === 0xdb8) return false; // documentation
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return false; // discard-only
  if ((a & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return false; // site-local fec0::/10
  if ((a & 0xff00) === 0xff00) return false; // multicast
  // Only global unicast (2000::/3) is public; everything else is unassigned or special.
  return (a & 0xe000) === 0x2000;
}

/** True only for a public, routable unicast address. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicV4(address);
  if (family === 6) return isPublicV6(address);
  return false;
}

// ---------------------------------------------------------------------------
// Checking a URL
// ---------------------------------------------------------------------------

/** Names that mean "this machine" or "this network", before any DNS is asked. */
function isInternalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    // A single-label name resolves through search domains, e.g. a compose service called "fibuki-api".
    !host.includes(".")
  );
}

/** Parse and vet a URL before any connection. Throws UnsafeUrlError; returns the URL when acceptable. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("only https URLs are supported");
  if (url.username || url.password) throw new UnsafeUrlError("a URL with credentials is not supported");
  if (url.port && url.port !== "443") throw new UnsafeUrlError("only the standard https port is supported");

  // WHATWG URL normalises 0x7f.1, 2130706433 and the like to dotted form, so this sees what the socket would.
  // A trailing dot is the same name ("localhost." is "localhost"), so it must not slip past the checks below.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new UnsafeUrlError("that address is not a public one");
  } else if (isInternalName(host)) {
    throw new UnsafeUrlError("that host name is not a public one");
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * The DNS lookup the connection uses. Every address the name resolves to must be public;
 * one private answer refuses the whole name, so a record that mixes public and private
 * addresses cannot be used to get a private one connected.
 */
export function publicOnlyLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
  resolver: (host: string, opts: dns.LookupAllOptions) => Promise<dns.LookupAddress[]> = (h, o) =>
    dns.promises.lookup(h, o)
): void {
  resolver(hostname, { all: true, verbatim: true })
    .then((addresses) => {
      if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
        callback(new UnsafeUrlError("that host does not resolve to a public address"), []);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    })
    .catch((err) => callback(err as NodeJS.ErrnoException, []));
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface FetchedFile {
  buffer: Buffer;
  contentType: string | null;
  /** The URL after redirects. */
  finalUrl: string;
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test seams: the HTTPS transport and the DNS lookup. Production uses the real ones. */
  transport?: Pick<typeof https, "request">;
  lookup?: typeof publicOnlyLookup;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function readBody(res: IncomingMessage, maxBytes: number, budgetMs: number): Promise<Buffer> {
  const limit = `${Math.floor(maxBytes / 1024 / 1024)} MB`;
  return new Promise((resolve, reject) => {
    const length = Number(res.headers["content-length"]);
    if (Number.isFinite(length) && length > maxBytes) {
      res.destroy();
      reject(new Error(`File is larger than the ${limit} limit`));
      return;
    }
    // The socket timeout only fires on silence; a server that drips a byte at a time
    // would hold the request open for ever, so the whole download has a deadline.
    const timer = setTimeout(() => {
      res.destroy();
      reject(new Error("Download timed out"));
    }, Math.max(budgetMs, 1));
    const chunks: Buffer[] = [];
    let received = 0;
    res.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        clearTimeout(timer);
        res.destroy();
        reject(new Error(`File is larger than the ${limit} limit`));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    res.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Fetch a user-supplied URL under the rules above. Throws UnsafeUrlError for a URL we refuse. */
export async function fetchPublicUrl(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedFile> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const transport = options.transport ?? https;
  const lookup = options.lookup ?? publicOnlyLookup;
  const startedAt = Date.now();

  let url = assertFetchableUrl(rawUrl);

  for (let hop = 0; ; hop++) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("Download timed out");

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      // Absolute limit on getting the response headers (the option below is an idle limit).
      const timer = setTimeout(() => req.destroy(new Error("Download timed out")), remaining);
      const req = transport.request(
        url,
        {
          method: "GET",
          // The check and the connection share this lookup, so they cannot disagree.
          lookup: lookup as never,
          timeout: remaining,
          // No pooled sockets: a reused connection would skip the lookup, and with it the check.
          agent: false,
          headers: { "User-Agent": "FiBuKI-fetch/1.0", Accept: "*/*" },
        },
        (res) => {
          clearTimeout(timer);
          resolve(res);
        }
      );
      req.on("timeout", () => req.destroy(new Error("Download timed out")));
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });

    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUSES.has(status)) {
      response.resume();
      const location = response.headers.location;
      if (!location) throw new Error(`Redirect (${status}) without a Location`);
      if (hop >= maxRedirects) throw new Error("Too many redirects");
      // A redirect is a new URL from the same untrusted source: it gets every check again.
      url = assertFetchableUrl(new URL(location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`Failed to download file: ${status} ${response.statusMessage ?? ""}`.trim());
    }

    const buffer = await readBody(response, maxBytes, timeoutMs - (Date.now() - startedAt));
    const contentType = response.headers["content-type"];
    return { buffer, contentType: typeof contentType === "string" ? contentType : null, finalUrl: url.toString() };
  }
}
