import { describe, it, expect, vi } from "vitest";
import {
  guardPage,
  MAX_SUBRESOURCES,
  MAX_SUBRESOURCE_BYTES,
  type GuardedPage,
  type GuardedRequest,
} from "./renderGuard";
import { UnsafeUrlError } from "../utils/safeFetch";

type Outcome = "continued" | "aborted" | "responded";

function setup(fetcher = vi.fn()) {
  let handler!: (r: GuardedRequest) => void;
  const page: GuardedPage = {
    setJavaScriptEnabled: vi.fn().mockResolvedValue(undefined),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    on: (_event, h) => {
      handler = h;
    },
  };
  const guard = guardPage(page, { fetcher });
  async function send(url: string, resourceType = "image", method = "GET") {
    let outcome: Outcome | undefined;
    let body: Buffer | undefined;
    const done = new Promise<void>((resolve) => {
      const settle = (o: Outcome) => () => {
        outcome = o;
        resolve();
        return Promise.resolve();
      };
      handler({
        url: () => url,
        method: () => method,
        resourceType: () => resourceType,
        abort: settle("aborted"),
        continue: settle("continued"),
        respond: (r) => {
          body = r.body;
          return settle("responded")();
        },
      });
    });
    await done;
    return { outcome, body };
  }
  return { page, guard, send, fetcher };
}

describe("guardPage", () => {
  it("turns script off and intercepts every request", async () => {
    const { page, guard } = setup();
    await guard;
    expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false);
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
  });

  it("lets about:blank and inline data: images through", async () => {
    const { guard, send } = setup();
    await guard;
    expect((await send("about:blank", "document")).outcome).toBe("continued");
    expect((await send("data:image/png;base64,AAAA")).outcome).toBe("continued");
  });

  it.each([
    ["a document (iframe, navigation)", "https://example.com/p", "document", "GET"],
    ["fetch", "https://example.com/p", "fetch", "GET"],
    ["a websocket", "https://example.com/p", "websocket", "GET"],
    ["plain http", "http://example.com/a.png", "image", "GET"],
    ["a loopback http service", "http://127.0.0.1:8788/x", "image", "GET"],
    ["file:", "file:///etc/passwd", "image", "GET"],
    ["cid:", "cid:logo@mail", "image", "GET"],
    ["a POST", "https://example.com/a.png", "image", "POST"],
    ["a data: document", "data:text/html,<h1>x</h1>", "document", "GET"],
  ])("refuses %s", async (_name, url, type, method) => {
    const { guard, send, fetcher } = setup();
    const g = await guard;
    expect((await send(url, type, method)).outcome).toBe("aborted");
    expect(fetcher).not.toHaveBeenCalled();
    expect(g.blocked).toContain(url);
  });

  it("fetches an https subresource itself and hands the bytes to the browser", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      buffer: Buffer.from("PNG"),
      contentType: "image/png",
      finalUrl: "https://cdn.example.com/logo.png",
    });
    const { guard, send } = setup(fetcher);
    const g = await guard;
    const { outcome, body } = await send("https://cdn.example.com/logo.png");
    expect(outcome).toBe("responded");
    expect(body?.toString()).toBe("PNG");
    expect(fetcher).toHaveBeenCalledWith(
      "https://cdn.example.com/logo.png",
      expect.objectContaining({ maxBytes: MAX_SUBRESOURCE_BYTES })
    );
    expect(g.served).toBe(1);
  });

  it("drops the element when the address is not public, instead of loading it", async () => {
    const fetcher = vi.fn().mockRejectedValue(new UnsafeUrlError("resolves to a private address"));
    const { guard, send } = setup(fetcher);
    const g = await guard;
    expect((await send("https://internal.example.com/a.png")).outcome).toBe("aborted");
    expect(g.served).toBe(0);
  });

  it("stops after the subresource cap", async () => {
    const fetcher = vi.fn().mockResolvedValue({ buffer: Buffer.from("x"), contentType: null, finalUrl: "" });
    const { guard, send } = setup(fetcher);
    await guard;
    for (let i = 0; i < MAX_SUBRESOURCES; i++) await send(`https://cdn.example.com/${i}.png`);
    expect((await send("https://cdn.example.com/over.png")).outcome).toBe("aborted");
    expect(fetcher).toHaveBeenCalledTimes(MAX_SUBRESOURCES);
  });
});
