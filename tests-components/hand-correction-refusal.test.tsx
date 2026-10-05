/**
 * #639: a re-extraction the server refuses for a Hand Correction used to be
 * swallowed: Retry and "Mark as invoice" caught it into the console and the
 * click seemed to do nothing.
 *
 * The guard is rendered in a small harness that stands in for the File
 * panel's Retry and the files page's "Mark as invoice": both hand it the
 * action and the forced re-extraction, exactly as here. The refusal is the
 * callable error's shape, `details: { code: "HAND_CORRECTED", fields }`
 * (functions/src/extraction/retryExtraction.ts), copied rather than imported:
 * this suite resolves from the root tree and functions/ is not part of it.
 * The forced re-extraction is the real `retryFileExtraction` operation over a
 * stubbed `firebase/functions`, so the test sees the request it sends.
 */

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import en from "@/messages/en.json";
import de from "@/messages/de.json";

const callable = vi.hoisted(() => ({ calls: [] as Array<{ name: string; data: unknown }> }));

vi.mock("firebase/functions", () => ({
  getFunctions: () => ({}),
  httpsCallable: (_functions: unknown, name: string) => async (data: unknown) => {
    callable.calls.push({ name, data });
    return { data: { queued: true } };
  },
}));
// file-ops imports the app's callable wrapper, which boots Firebase.
vi.mock("@/lib/firebase/callable", () => ({ callFunction: vi.fn() }));

import { useHandCorrectionGuard } from "@/components/files/hand-correction-dialog";
import { retryFileExtraction } from "@/lib/operations/file-ops";
import {
  bulkMarkAsInvoiceSummary,
  handCorrectedFieldsOf,
  markFilesAsInvoice,
} from "@/lib/files/hand-correction-refusal";

/** The callable error a Hand Correction refusal arrives as. */
function refusal(fields: string[]) {
  return Object.assign(new Error("File carries hand corrections a re-extraction would discard"), {
    code: "functions/failed-precondition",
    details: { code: "HAND_CORRECTED", fields },
  });
}

const CTX = { db: {}, userId: "u1" } as never;

function Harness({ attempt, onError }: { attempt: () => Promise<unknown>; onError?: (e: unknown) => void }) {
  const { guard, dialog } = useHandCorrectionGuard();
  const [outcome, setOutcome] = React.useState("");
  return (
    <>
      <button
        onClick={() =>
          guard(attempt, () => retryFileExtraction(CTX, "file-1", true, { overwriteCorrections: true }))
            .then(setOutcome)
            .catch((e) => onError?.(e))
        }
      >
        retry
      </button>
      <output data-testid="outcome">{outcome}</output>
      {dialog}
    </>
  );
}

function renderHarness(
  attempt: () => Promise<unknown>,
  { locale = "en", onError }: { locale?: "en" | "de"; onError?: (e: unknown) => void } = {}
) {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de} timeZone="Europe/Vienna">
      <Harness attempt={attempt} onError={onError} />
    </NextIntlClientProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
}

beforeEach(() => {
  callable.calls.length = 0;
});

describe("a re-extraction refused for a Hand Correction (#639)", () => {
  it("opens the dialog, naming the corrected fields in words", async () => {
    renderHarness(() => Promise.reject(refusal(["amount", "dueDate"])));

    expect(await screen.findByText("Your corrections will be lost")).toBeTruthy();
    expect(
      screen.getByText(
        "This File has your corrections to Amount and Due date. Extracting it again replaces them with what the document says."
      )
    ).toBeTruthy();
    // The caller drops its spinner on this answer.
    expect(screen.getByTestId("outcome").textContent).toBe("asked");
    // "Keep corrections" is where the focus lands.
    expect(document.activeElement?.textContent).toBe("Keep corrections");
  });

  it("Keep corrections closes it and sends nothing", async () => {
    renderHarness(() => Promise.reject(refusal(["amount"])));
    fireEvent.click(await screen.findByRole("button", { name: "Keep corrections" }));

    await waitFor(() => expect(screen.queryByText("Your corrections will be lost")).toBeNull());
    expect(callable.calls).toEqual([]);
  });

  it("Extract anyway sends the forced Retry once, even on a double click", async () => {
    renderHarness(() => Promise.reject(refusal(["amount"])));
    const extract = await screen.findByRole("button", { name: "Extract anyway" });
    act(() => {
      fireEvent.click(extract);
      fireEvent.click(extract);
    });

    await waitFor(() => expect(callable.calls).toHaveLength(1));
    expect(callable.calls[0]).toEqual({
      name: "retryFileExtraction",
      data: { fileId: "file-1", force: true, overwriteCorrections: true },
    });
    await waitFor(() => expect(screen.queryByText("Your corrections will be lost")).toBeNull());
  });

  it("speaks German, with the panel's German labels", async () => {
    renderHarness(() => Promise.reject(refusal(["amount", "vatPercent", "dueDate"])), { locale: "de" });

    expect(await screen.findByText("Deine Korrekturen gehen verloren")).toBeTruthy();
    expect(
      screen.getByText(
        "Dieser Beleg enthält deine Korrekturen an Betrag, USt. % und Fälligkeitsdatum. Eine neue Extraktion ersetzt sie durch die Werte aus dem Dokument."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Korrekturen behalten" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trotzdem extrahieren" })).toBeTruthy();
  });

  it("never shows a raw field key: one it does not know reads as other fields", async () => {
    renderHarness(() => Promise.reject(refusal(["amount", "someFutureField"])));
    expect(
      await screen.findByText(/to Amount and other fields\./)
    ).toBeTruthy();
    expect(screen.queryByText(/someFutureField/)).toBeNull();
  });

  it("leaves any other error to the caller, with no dialog", async () => {
    const onError = vi.fn();
    renderHarness(() => Promise.reject(new Error("boom")), { onError });

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect((onError.mock.calls[0][0] as Error).message).toBe("boom");
    expect(screen.queryByText("Your corrections will be lost")).toBeNull();
  });

  it("goes through when nothing is refused", async () => {
    renderHarness(() => Promise.resolve());
    await waitFor(() => expect(screen.getByTestId("outcome").textContent).toBe("done"));
    expect(screen.queryByText("Your corrections will be lost")).toBeNull();
  });
});

describe("reading the refusal", () => {
  it("takes the fields from the structured details only", () => {
    expect(handCorrectedFieldsOf(refusal(["amount"]))).toEqual(["amount"]);
    // The message alone is the MCP shape; the UI does not parse text.
    expect(handCorrectedFieldsOf(new Error("HAND_CORRECTED: File carries hand corrections"))).toBeNull();
    expect(handCorrectedFieldsOf({ details: { code: "ALREADY_EXTRACTED" } })).toBeNull();
    expect(handCorrectedFieldsOf(null)).toBeNull();
  });
});

describe("bulk Mark as invoice", () => {
  it("skips hand-corrected Files and counts them apart from real failures", async () => {
    const unmark = vi.fn(async (fileId: string) => {
      if (fileId.startsWith("corrected")) throw refusal(["amount"]);
      if (fileId === "broken") throw new Error("network");
    });
    const onEach = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await markFilesAsInvoice(
      ["a", "corrected-1", "b", "broken", "corrected-2"],
      unmark,
      onEach
    );

    expect(result).toEqual({ marked: 2, skipped: 2, failed: 1 });
    // Every File was tried once and moved the progress once: no override.
    expect(unmark).toHaveBeenCalledTimes(5);
    expect(onEach).toHaveBeenCalledTimes(5);
    errors.mockRestore();
  });

  it("says so in the summary, in English and German", () => {
    const tEn = createTranslator({ locale: "en", messages: en, namespace: "files.bulkMarkAsInvoice" });
    const tDe = createTranslator({ locale: "de", messages: de, namespace: "files.bulkMarkAsInvoice" });

    expect(bulkMarkAsInvoiceSummary(tEn as never, { marked: 3, skipped: 2, failed: 0 })).toEqual({
      message: "Marked 3 Files as invoices. 2 skipped: they have your corrections. Open them to extract again.",
      tone: "success",
    });
    expect(bulkMarkAsInvoiceSummary(tEn as never, { marked: 1, skipped: 1, failed: 1 })).toEqual({
      message:
        "Marked 1 File as an invoice. 1 skipped: it has your corrections. Open it to extract again. 1 failed.",
      tone: "error",
    });
    expect(bulkMarkAsInvoiceSummary(tEn as never, { marked: 4, skipped: 0, failed: 0 }).message).toBe(
      "Marked 4 Files as invoices."
    );
    expect(bulkMarkAsInvoiceSummary(tDe as never, { marked: 3, skipped: 2, failed: 0 }).message).toBe(
      "3 Belege als Rechnung markiert. 2 übersprungen, weil sie deine Korrekturen enthalten. Öffne sie, um sie neu zu extrahieren."
    );
  });
});
