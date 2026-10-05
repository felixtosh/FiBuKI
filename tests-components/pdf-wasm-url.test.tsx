/**
 * Both of FiBuKI's pdf.js renderers, the page viewer and the detail-panel
 * thumbnail, hand pdf.js the same `wasmUrl` (#681): without it a JPEG 2000
 * scan draws blank. That the decoders exist at that URL and actually draw a
 * JPEG 2000 page is tests/pdfjs-jpx-wasm.test.mjs.
 *
 * react-pdf is replaced by a stand-in Document that records the options it
 * receives, and next/dynamic by a loader that resolves the mocked module, as in
 * pdf-password-prompt.test.
 */

import { act, render } from "@testing-library/react";
import { createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pdf = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({ options, children }: { options?: unknown; children?: ReactNode }) => {
    pdf.options.push(options);
    return createElement("div", { "data-testid": "pdf-document" }, children);
  },
  Page: () => createElement("canvas"),
}));

vi.mock("react-pdf/dist/Page/TextLayer.css", () => ({}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<ComponentType<Record<string, unknown>>>) =>
    function Dynamic(props: Record<string, unknown>) {
      const [Loaded, setLoaded] = useState<ComponentType<Record<string, unknown>> | null>(null);
      useEffect(() => {
        loader().then((component) => setLoaded(() => component));
      }, []);
      return Loaded ? createElement(Loaded, props) : null;
    },
}));

import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";
import pdfjsPackage from "pdfjs-dist/package.json";
import {
  PDF_DOCUMENT_OPTIONS,
  PdfPageViewer,
  PdfThumbnail,
} from "@/components/files/pdf-page-viewer";

function withIntl(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Vienna">
      {children}
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  pdf.options = [];
});

describe("pdf.js wasm decoders", () => {
  it("are served same-origin, under the installed pdf.js version", () => {
    expect(PDF_DOCUMENT_OPTIONS.wasmUrl).toBe(`/pdfjs/${pdfjsPackage.version}/wasm/`);
  });

  it.each([
    ["page viewer", () => <PdfPageViewer url="blob:https://fibuki.test/scan" />],
    ["thumbnail", () => <PdfThumbnail url="blob:https://fibuki.test/scan" />],
  ])("the %s passes them to pdf.js, as one stable object", async (_name, element) => {
    let rerender!: (ui: ReactNode) => void;
    await act(async () => {
      ({ rerender } = render(withIntl(element())));
    });
    await act(async () => {
      rerender(withIntl(element()));
    });

    expect(pdf.options.length).toBeGreaterThan(0);
    for (const options of pdf.options) expect(options).toBe(PDF_DOCUMENT_OPTIONS);
  });
});
