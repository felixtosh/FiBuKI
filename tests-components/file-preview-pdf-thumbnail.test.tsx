/**
 * The File detail panel's thumbnail (#676). It used to embed the browser's own
 * PDF viewer in an iframe; for a password-protected PDF that viewer shows its
 * own password box and takes keyboard focus, so the list's arrow keys stop
 * reaching prev/next. The thumbnail now draws the first page with FiBuKI's own
 * renderer (react-pdf), which says a protected PDF is locked and holds nothing
 * that can take focus.
 *
 * react-pdf is replaced by a stand-in Document that asks for a password on
 * mount the way pdf.js does (for a url containing "locked"), and next/dynamic
 * by a loader that resolves the mocked module, as in pdf-password-prompt.test.
 * useFileObjectUrl is stubbed to hand the stored url straight back: resolving a
 * self-host url is its own concern and reaches Firebase auth.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const NEED_PASSWORD = 1;

const pdf = vi.hoisted(() => ({
  passwordCallback: vi.fn(),
  documentUnmounted: vi.fn(),
  resolved: { url: null as string | null, loading: false, error: null as string | null },
}));

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({
    file,
    onPassword,
    children,
  }: {
    file?: string;
    onPassword?: (callback: (password: string | null) => void, reason: number) => void;
    children?: ReactNode;
  }) => {
    useEffect(() => {
      if (file?.includes("locked")) onPassword?.(pdf.passwordCallback, NEED_PASSWORD);
      return () => pdf.documentUnmounted();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return createElement("div", { "data-testid": "pdf-document", "data-file": file }, children);
  },
  Page: ({
    pageNumber,
    width,
    renderTextLayer,
    renderAnnotationLayer,
  }: {
    pageNumber?: number;
    width?: number;
    renderTextLayer?: boolean;
    renderAnnotationLayer?: boolean;
  }) =>
    createElement("canvas", {
      "data-testid": "pdf-page",
      "data-page": pageNumber,
      "data-width": width,
      "data-text-layer": String(renderTextLayer),
      "data-annotation-layer": String(renderAnnotationLayer),
    }),
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

vi.mock("@/hooks/use-file-object-url", () => ({
  useFileObjectUrl: () => pdf.resolved,
}));

import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";
import { FilePreview } from "@/components/files/file-preview";

const FOCUSABLE =
  "a[href], button, input, select, textarea, iframe, embed, object, [tabindex], [contenteditable]";

function thumbnail(url: string, fileType: string, fileName: string, onClick?: () => void) {
  pdf.resolved = { url, loading: false, error: null };
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Vienna">
      <FilePreview downloadUrl={url} fileType={fileType} fileName={fileName} onClick={onClick} />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  pdf.passwordCallback.mockReset();
  pdf.documentUnmounted.mockReset();
  pdf.resolved = { url: null, loading: false, error: null };
});

describe("FilePreview thumbnail of a password-protected PDF", () => {
  it("shows the lock state and holds nothing that can take focus", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        thumbnail("blob:https://fibuki.test/locked", "application/pdf", "locked.pdf")
      ));
    });

    await screen.findByText(/password-protected/i);
    expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(pdf.passwordCallback).not.toHaveBeenCalled();
    await waitFor(() => expect(pdf.documentUnmounted).toHaveBeenCalledTimes(1));
  });

  it("still opens the viewer on click", async () => {
    const onClick = vi.fn();
    await act(async () => {
      render(thumbnail("blob:https://fibuki.test/locked", "application/pdf", "locked.pdf", onClick));
    });

    fireEvent.click(await screen.findByText(/password-protected/i));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("FilePreview thumbnail of an ordinary PDF", () => {
  it("draws the first page at the thumbnail's width, without text or link layers", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        thumbnail("blob:https://fibuki.test/open", "application/pdf", "open.pdf")
      ));
    });

    const page = await screen.findByTestId("pdf-page");
    expect(page.getAttribute("data-page")).toBe("1");
    expect(page.getAttribute("data-width")).toBe("120");
    expect(page.getAttribute("data-text-layer")).toBe("false");
    expect(page.getAttribute("data-annotation-layer")).toBe("false");
    expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(screen.queryByText(/password-protected/i)).toBeNull();
  });

  it("loads the next File normally when the thumbnail is reused", async () => {
    const { rerender } = render(
      thumbnail("blob:https://fibuki.test/locked", "application/pdf", "locked.pdf")
    );
    await screen.findByText(/password-protected/i);

    rerender(thumbnail("blob:https://fibuki.test/open", "application/pdf", "open.pdf"));

    await screen.findByTestId("pdf-document");
    expect(screen.queryByText(/password-protected/i)).toBeNull();
  });
});

describe("FilePreview thumbnail of other file types", () => {
  it("shows an image as an image, without the PDF renderer", async () => {
    await act(async () => {
      render(thumbnail("blob:https://fibuki.test/photo", "image/jpeg", "receipt.jpg"));
    });

    expect(screen.getByAltText("receipt.jpg").tagName).toBe("IMG");
    expect(screen.queryByTestId("pdf-document")).toBeNull();
  });
});
