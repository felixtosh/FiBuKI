/**
 * How htmlToPdf starts its shared Chromium, with Puppeteer mocked. The real-browser behaviour
 * lives in htmlToPdf.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("puppeteer-core", () => ({ default: { launch } }));
vi.mock("@sparticuz/chromium", () => ({ default: {} }));
vi.mock("./renderGuard", () => ({ guardPage: vi.fn() }));

function fakeBrowser() {
  const page = {
    setContent: vi.fn(),
    pdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
    close: vi.fn(),
  };
  return { connected: true, on: vi.fn(), newPage: vi.fn(async () => page), close: vi.fn(), process: () => null };
}

describe("htmlToPdf browser launch", () => {
  beforeEach(() => {
    vi.resetModules();
    launch.mockReset();
    vi.stubEnv("FIBUKI_CHROME_PATH", "/usr/bin/chromium");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives a cold start longer than Puppeteer's 30s default", async () => {
    launch.mockResolvedValue(fakeBrowser());
    const { convertHtmlToPdf } = await import("./htmlToPdf");

    await convertHtmlToPdf("<p>x</p>");

    expect(launch.mock.calls[0][0].timeout).toBeGreaterThan(30_000);
  });

  it("launches again after a failed launch instead of failing every later call", async () => {
    launch.mockRejectedValueOnce(new Error("Timed out while waiting for the WS endpoint URL"));
    launch.mockResolvedValueOnce(fakeBrowser());
    const { convertHtmlToPdf } = await import("./htmlToPdf");

    await expect(convertHtmlToPdf("<p>x</p>")).rejects.toThrow("WS endpoint");
    const { pdfBuffer } = await convertHtmlToPdf("<p>x</p>");

    expect(launch).toHaveBeenCalledTimes(2);
    expect(pdfBuffer.length).toBeGreaterThan(0);
  });
});
