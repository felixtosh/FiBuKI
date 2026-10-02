import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import {
  assertFetchableUrl,
  fetchPublicUrl,
  isPublicAddress,
  publicOnlyLookup,
  UnsafeUrlError,
} from "./safeFetch";

describe("isPublicAddress", () => {
  it.each([
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1",
    "192.167.255.255", "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255",
    "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1",
  ])("%s is public", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    // IPv4: every special range, at both ends
    "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.17.0.2", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.88.99.1",
    "192.168.0.1", "192.168.255.255", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255",
    // IPv6
    "::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12:3456:789a::1", "fec0::1", "ff02::1", "2001:db8::1", "2001:0:4136:e378::1",
    "100::1", "::2", "4000::1", "1::1",
    // IPv4 hidden inside IPv6
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::127.0.0.1",
    "64:ff9b::a00:1", "64:ff9b::7f00:1", "2002:7f00:1::1", "2002:a00:1::", "2002:a9fe:a9fe::",
    // not addresses
    "not-an-ip", "", "10.0.0", "1.2.3.4.5", "999.1.1.1", "::g",
  ])("%s is not public", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("assertFetchableUrl", () => {
  it.each([
    "https://example.com/invoice.pdf",
    "https://files.example.co.uk/a/b?c=d#e",
    "https://8.8.8.8/x.pdf",
    "https://[2606:4700:4700::1111]/x.pdf",
    "https://example.com:443/x",
    "HTTPS://Example.COM/x",
  ])("accepts %s", (url) => {
    expect(() => assertFetchableUrl(url)).not.toThrow();
  });

  it.each([
    ["http://example.com/x.pdf", /only https/],
    ["ftp://example.com/x", /only https/],
    ["file:///etc/passwd", /only https/],
    ["gopher://example.com/", /only https/],
    ["javascript:alert(1)", /only https/],
    ["data:text/plain;base64,AAAA", /only https/],
    ["https://user:pw@example.com/x", /credentials/],
    ["https://user@example.com/x", /credentials/],
    ["https://example.com:8443/x", /port/],
    ["https://example.com:80/x", /port/],
    ["not a url", /valid URL/],
    ["", /valid URL/],
    // names that mean this machine or network
    ["https://localhost/x", /host name/],
    ["https://LOCALHOST/x", /host name/],
    ["https://localhost./x", /host name/],
    ["https://metadata.google.internal./x", /host name/],
    ["https://127.0.0.1./x", /public/],
    ["https://app.localhost/x", /host name/],
    ["https://fibuki-api/x", /host name/],
    ["https://postgres/x", /host name/],
    ["https://metadata.google.internal/x", /host name/],
    ["https://printer.local/x", /host name/],
    ["https://nas.lan/x", /host name/],
    // addresses, in every spelling the URL parser normalises
    ["https://127.0.0.1/x", /public/],
    ["https://127.1/x", /public/],
    ["https://0x7f.0.0.1/x", /public/],
    ["https://2130706433/x", /public/],
    ["https://017700000001/x", /public/],
    ["https://0/x", /public/],
    ["https://10.0.0.5/x", /public/],
    ["https://172.17.0.1/x", /public/],
    ["https://169.254.169.254/latest/meta-data/", /public/],
    ["https://[::1]/x", /public/],
    ["https://[::ffff:127.0.0.1]/x", /public/],
    ["https://[::ffff:7f00:1]/x", /public/],
    ["https://[fd00::1]/x", /public/],
  ])("refuses %s", (url, reason) => {
    expect(() => assertFetchableUrl(url)).toThrow(UnsafeUrlError);
    expect(() => assertFetchableUrl(url)).toThrow(reason);
  });
});

describe("publicOnlyLookup (what the connection resolves through)", () => {
  const answers = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const run = (resolver: Parameters<typeof publicOnlyLookup>[3], options: Parameters<typeof publicOnlyLookup>[1] = {}) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      publicOnlyLookup("files.example.com", options, (err, address, family) => resolve({ err, address, family }), resolver)
    );

  it("connects to a public answer", async () => {
    const res = await run(answers("93.184.216.34"));
    expect(res).toEqual({ err: null, address: "93.184.216.34", family: 4 });
  });

  it("returns all of them when asked for all", async () => {
    const res = await run(answers("93.184.216.34", "2606:2800:220:1::1"), { all: true });
    expect(res.err).toBeNull();
    expect(res.address).toHaveLength(2);
  });

  it("refuses a name that resolves to a private address, a loopback, or the metadata address", async () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "::1", "fd00::5", "::ffff:10.0.0.1"]) {
      const res = await run(answers(ip));
      expect(res.err).toBeInstanceOf(UnsafeUrlError);
    }
  });

  it("one private answer refuses the whole name, however many public ones come with it", async () => {
    const res = await run(answers("93.184.216.34", "127.0.0.1"));
    expect(res.err).toBeInstanceOf(UnsafeUrlError);
    expect(res.err?.message).toMatch(/public address/);
  });

  it("refuses an empty answer and passes a resolver failure on", async () => {
    expect((await run(answers())).err).toBeInstanceOf(UnsafeUrlError);
    const failure = await run(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    expect(failure.err?.message).toBe("ENOTFOUND");
  });
});

// --- a fake HTTPS transport: no network, but every option the real one would receive is visible ---

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  /** Never ends: a server that drips or stalls. */
  stall?: boolean;
}

function fakeTransport(responses: FakeResponse[]) {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const transport = {
    request(url: URL | string, options: Record<string, unknown>, callback: (res: Readable) => void) {
      calls.push({ url: String(url), options });
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
      req.destroy = (error?: Error) => error && req.emit("error", error);
      req.end = () => {
        const spec = responses[calls.length - 1] ?? { status: 500 };
        const body = spec.stall
          ? new Readable({ read() {} })
          : Readable.from(spec.chunks ?? [Buffer.from("PDF")], { objectMode: false });
        Object.assign(body, { statusCode: spec.status ?? 200, statusMessage: "STATUS", headers: spec.headers ?? {} });
        queueMicrotask(() => callback(body));
      };
      return req;
    },
  };
  return { transport: transport as never, calls };
}

const okLookup = (() => undefined) as never;

describe("fetchPublicUrl", () => {
  it("downloads a file and reports its type and final URL", async () => {
    const { transport, calls } = fakeTransport([{ headers: { "content-type": "application/pdf" }, chunks: [Buffer.from("%PDF-"), Buffer.from("1.4")] }]);
    const file = await fetchPublicUrl("https://files.example.com/a.pdf", { transport, lookup: okLookup });
    expect(file.buffer.toString()).toBe("%PDF-1.4");
    expect(file.contentType).toBe("application/pdf");
    expect(file.finalUrl).toBe("https://files.example.com/a.pdf");
    expect(calls).toHaveLength(1);
  });

  it("connects through the checking lookup, with a fresh agent, never the default resolution", async () => {
    const { transport, calls } = fakeTransport([{}]);
    const lookup = vi.fn() as never;
    await fetchPublicUrl("https://files.example.com/a.pdf", { transport, lookup });
    expect(calls[0].options.lookup).toBe(lookup);
    expect(calls[0].options.agent).toBe(false);
    expect(calls[0].options.method).toBe("GET");
  });

  it("uses the real checking lookup when none is injected", async () => {
    const { transport, calls } = fakeTransport([{}]);
    await fetchPublicUrl("https://files.example.com/a.pdf", { transport });
    expect(calls[0].options.lookup).toBe(publicOnlyLookup);
  });

  it("refuses an unsafe URL before connecting at all", async () => {
    const { transport, calls } = fakeTransport([{}]);
    for (const url of ["http://files.example.com/a", "https://10.0.0.1/a", "https://localhost/a", "https://fibuki-api:8788/x", "https://169.254.169.254/"]) {
      await expect(fetchPublicUrl(url, { transport, lookup: okLookup })).rejects.toBeInstanceOf(UnsafeUrlError);
    }
    expect(calls).toHaveLength(0);
  });

  it("follows a redirect to another public https URL", async () => {
    const { transport, calls } = fakeTransport([
      { status: 302, headers: { location: "/files/real.pdf" } },
      { status: 301, headers: { location: "https://cdn.example.net/real.pdf" } },
      { chunks: [Buffer.from("ok")] },
    ]);
    const file = await fetchPublicUrl("https://files.example.com/a.pdf", { transport, lookup: okLookup });
    expect(calls.map((c) => c.url)).toEqual(["https://files.example.com/a.pdf", "https://files.example.com/files/real.pdf", "https://cdn.example.net/real.pdf"]);
    expect(file.finalUrl).toBe("https://cdn.example.net/real.pdf");
  });

  it("a redirect gets every check again: to http, to a private address, to localhost, to another port", async () => {
    for (const location of [
      "http://files.example.com/a",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/x",
      "https://localhost/x",
      "https://[::1]/x",
      "https://files.example.com:8443/x",
      "https://user:pw@files.example.com/x",
      "//127.0.0.1/x",
    ]) {
      const { transport, calls } = fakeTransport([{ status: 302, headers: { location } }, { chunks: [Buffer.from("secret")] }]);
      await expect(fetchPublicUrl("https://files.example.com/a.pdf", { transport, lookup: okLookup })).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(calls).toHaveLength(1); // the second request was never made
    }
  });

  it("stops redirect loops and redirects with nowhere to go", async () => {
    const loop = fakeTransport(Array.from({ length: 10 }, () => ({ status: 302, headers: { location: "https://files.example.com/again" } })));
    await expect(fetchPublicUrl("https://files.example.com/a", { transport: loop.transport, lookup: okLookup, maxRedirects: 3 })).rejects.toThrow(/Too many redirects/);
    expect(loop.calls).toHaveLength(4);

    const lost = fakeTransport([{ status: 302 }]);
    await expect(fetchPublicUrl("https://files.example.com/a", { transport: lost.transport, lookup: okLookup })).rejects.toThrow(/without a Location/);
  });

  it("reports an error status", async () => {
    const { transport } = fakeTransport([{ status: 404 }]);
    await expect(fetchPublicUrl("https://files.example.com/a", { transport, lookup: okLookup })).rejects.toThrow(/404/);
  });

  it("refuses a file that declares itself too large, without reading it", async () => {
    const { transport } = fakeTransport([{ headers: { "content-length": String(30 * 1024 * 1024) }, chunks: [Buffer.from("x")] }]);
    await expect(fetchPublicUrl("https://files.example.com/a", { transport, lookup: okLookup })).rejects.toThrow(/larger than the 25 MB limit/);
  });

  it("refuses a file that lies about its size and keeps going", async () => {
    const { transport } = fakeTransport([{ chunks: [Buffer.alloc(600), Buffer.alloc(600)] }]);
    await expect(fetchPublicUrl("https://files.example.com/a", { transport, lookup: okLookup, maxBytes: 1000 })).rejects.toThrow(/larger than/);
  });

  it("gives up on a server that stalls or drips, however long it keeps the socket alive", async () => {
    const { transport } = fakeTransport([{ stall: true }]);
    await expect(fetchPublicUrl("https://files.example.com/a", { transport, lookup: okLookup, timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });

  it("gives up when the response headers never arrive", async () => {
    const hang = {
      request() {
        const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
        req.destroy = (error?: Error) => error && req.emit("error", error);
        req.end = () => undefined; // never calls back
        return req;
      },
    } as never;
    await expect(fetchPublicUrl("https://files.example.com/a", { transport: hang, lookup: okLookup, timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });
});

describe("with the real socket and the real resolver (no network needed: the lookup refuses first)", () => {
  it("'localhost.' is refused before anything is resolved", async () => {
    await expect(fetchPublicUrl("https://localhost./x", { timeoutMs: 5000 })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("a loopback literal is refused before any socket is opened", async () => {
    await expect(fetchPublicUrl("https://127.0.0.1/x", { timeoutMs: 5000 })).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
