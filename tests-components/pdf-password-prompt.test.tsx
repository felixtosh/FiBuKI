/**
 * A password-protected PDF opened in the viewer: react-pdf's default password
 * handler asks with window.prompt() and passes the answer on unchecked. Cancel
 * gives null, pdf.js rejects it as a wrong password and asks again, so the
 * dialog can never be closed. The viewer must answer the request itself: never
 * prompt, never call back, say the file is protected, and drop the load.
 *
 * react-pdf is replaced by a stand-in Document that asks for a password on
 * mount the way pdf.js does, and next/dynamic by a loader that resolves the
 * mocked module, so the real component code runs unchanged.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const NEED_PASSWORD = 1;

const pdf = vi.hoisted(() => ({
  passwordCallback: vi.fn(),
  documentUnmounted: vi.fn(),
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
    return createElement("div", { "data-testid": "pdf-document" }, children);
  },
  Page: () => null,
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

import { PdfPageViewer } from "@/components/files/pdf-page-viewer";

afterEach(() => {
  vi.restoreAllMocks();
  pdf.passwordCallback.mockReset();
  pdf.documentUnmounted.mockReset();
});

describe("PdfPageViewer on a password-protected PDF", () => {
  it("never prompts and never answers the password request", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);

    await act(async () => {
      render(<PdfPageViewer url="https://example.test/locked.pdf" />);
    });

    await screen.findByText(/password-protected/i);
    expect(prompt).not.toHaveBeenCalled();
    expect(pdf.passwordCallback).not.toHaveBeenCalled();
  });

  it("unmounts the Document, which destroys the pending load", async () => {
    await act(async () => {
      render(<PdfPageViewer url="https://example.test/locked.pdf" />);
    });

    await waitFor(() => expect(pdf.documentUnmounted).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("pdf-document")).toBeNull();
  });

  it("loads the next File normally when the viewer is reused", async () => {
    const { rerender } = render(<PdfPageViewer url="https://example.test/locked.pdf" />);
    await screen.findByText(/password-protected/i);

    rerender(<PdfPageViewer url="https://example.test/open.pdf" />);

    await screen.findByTestId("pdf-document");
    expect(screen.queryByText(/password-protected/i)).toBeNull();
  });
});
