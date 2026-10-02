/**
 * Keeps the HTML-to-PDF renderer from being used to reach the network behind us.
 *
 * The HTML is attacker-controlled (the convertHtmlToPdf callable takes it from the caller, inbound
 * email from anyone who can write to a user's address), and Chromium runs next to internal services.
 * Left alone it would fetch whatever the markup names (an iframe, an image, a stylesheet, a meta
 * refresh, a form post, script) and print the answer into the PDF.
 *
 * So the page is locked down to what a rendered invoice or email needs:
 *  - script is off;
 *  - only image, stylesheet and font requests are served; documents (iframes, navigations, form
 *    posts), media, fetch/XHR, websockets and everything else are aborted;
 *  - data: and about: are allowed (inline content); every other scheme (file:, ftp:, cid:, ...) is not;
 *  - a remote https subresource is fetched BY US through fetchPublicUrl (public addresses only,
 *    pinned at connect time, redirects re-checked) and handed to the browser with respond(), so the
 *    browser itself never opens a connection and DNS rebinding has nothing to rebind;
 *  - plain http is dropped: a mail client would block it as mixed content anyway;
 *  - the number and size of subresources are capped, so a page cannot be a download amplifier.
 */

import { fetchPublicUrl, type FetchedFile, type SafeFetchOptions } from "../utils/safeFetch";

const ALLOWED_RESOURCE_TYPES = new Set(["image", "stylesheet", "font"]);
const INLINE_SCHEMES = new Set(["data:", "about:"]);

export const MAX_SUBRESOURCES = 40;
export const MAX_SUBRESOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
export const SUBRESOURCE_TIMEOUT_MS = 8_000;

/** The slice of a Puppeteer HTTPRequest the guard uses. */
export interface GuardedRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  abort(errorCode?: string): Promise<void>;
  respond(response: { status: number; contentType?: string; body: Buffer }): Promise<void>;
  continue(): Promise<void>;
}

/** The slice of a Puppeteer Page the guard uses. */
export interface GuardedPage {
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setRequestInterception(enabled: boolean): Promise<void>;
  on(event: "request", handler: (request: GuardedRequest) => void): unknown;
}

export interface RenderGuardOptions {
  /** Test seam; production uses fetchPublicUrl. */
  fetcher?: (url: string, options: SafeFetchOptions) => Promise<FetchedFile>;
}

export interface RenderGuard {
  /** Requests answered with the real bytes. */
  served: number;
  /** Requests refused, by URL. */
  blocked: string[];
}

export async function guardPage(page: GuardedPage, options: RenderGuardOptions = {}): Promise<RenderGuard> {
  const fetcher = options.fetcher ?? fetchPublicUrl;
  const guard: RenderGuard = { served: 0, blocked: [] };
  let requested = 0;
  let totalBytes = 0;

  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);

  const refuse = (request: GuardedRequest): Promise<void> => {
    guard.blocked.push(request.url());
    return request.abort("blockedbyclient").catch(() => undefined);
  };

  page.on("request", (request) => {
    void handle(request);
  });

  async function handle(request: GuardedRequest): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return refuse(request);
    }

    if (INLINE_SCHEMES.has(url.protocol)) {
      // about:blank is the document being set up; data: is inline content with no network behind it.
      if (url.protocol === "data:" && !ALLOWED_RESOURCE_TYPES.has(request.resourceType())) return refuse(request);
      await request.continue().catch(() => undefined);
      return;
    }

    if (
      url.protocol !== "https:" ||
      request.method() !== "GET" ||
      !ALLOWED_RESOURCE_TYPES.has(request.resourceType()) ||
      requested >= MAX_SUBRESOURCES
    ) {
      return refuse(request);
    }
    requested += 1;

    try {
      const budget = MAX_TOTAL_BYTES - totalBytes;
      if (budget <= 0) return refuse(request);
      const file = await fetcher(url.toString(), {
        maxBytes: Math.min(MAX_SUBRESOURCE_BYTES, budget),
        timeoutMs: SUBRESOURCE_TIMEOUT_MS,
      });
      totalBytes += file.buffer.length;
      guard.served += 1;
      await request.respond({
        status: 200,
        contentType: file.contentType ?? undefined,
        body: file.buffer,
      });
    } catch {
      // Unsafe address, oversize, timeout, or a failing server: the element just does not load.
      await refuse(request);
    }
  }

  return guard;
}
