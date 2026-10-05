"use client";

/**
 * Asking before a re-extraction overwrites a Hand Correction (#639).
 *
 * The server refuses a re-extraction of a File a person corrected by hand and
 * names the corrected fields. `useHandCorrectionGuard` runs an action, and on
 * that refusal opens this dialog instead of failing silently: "Keep
 * corrections" closes it and changes nothing, "Extract anyway" runs the
 * forced re-extraction the caller hands in. Any other error is the caller's,
 * as before.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { handCorrectedFieldsOf } from "@/lib/files/hand-correction-refusal";

/**
 * Each correctable field's label, under `files`: the labels the File panel
 * and its editor already use where the messages have them.
 */
const FIELD_LABEL_KEY: Record<string, string> = {
  amount: "handCorrection.fields.amount",
  vatAmount: "extracted.lineItems.vatAmount",
  vatPercent: "extracted.lineItems.vatPercent",
  date: "handCorrection.fields.date",
  lineItems: "extracted.lineItems.title",
  invoiceDirection: "detail.direction",
  tipAmount: "handCorrection.fields.tipAmount",
  dueDate: "extracted.fields.dueDate",
  debitDate: "extracted.fields.debitDate",
};

/** The translated labels of the fields a refusal named; a key it does not know reads "other fields". */
export function useCorrectedFieldList(fields: string[]): string {
  const t = useTranslations("files");
  const format = useFormatter();
  const labels = Array.from(
    new Set(fields.map((field) => t(FIELD_LABEL_KEY[field] ?? "handCorrection.fields.other")))
  );
  return format.list(labels, { type: "conjunction" });
}

interface HandCorrectionDialogProps {
  /** The corrected fields the refusal named. Open while non-null. */
  fields: string[] | null;
  onKeep: () => void;
  onExtract: () => void;
}

export function HandCorrectionDialog({ fields, onKeep, onExtract }: HandCorrectionDialogProps) {
  const t = useTranslations("files.handCorrection");
  const list = useCorrectedFieldList(fields ?? []);

  return (
    <AlertDialog open={fields !== null} onOpenChange={(open) => (open ? undefined : onKeep())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("body", { fields: list })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>{t("keep")}</AlertDialogCancel>
          <AlertDialogAction onClick={onExtract}>{t("extractAnyway")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What became of a guarded action. */
export type GuardOutcome = "done" | "asked";

/** An action that calls the server. */
interface Act {
  (): Promise<unknown>;
}

/** Runs an action; on a Hand Correction refusal, asks (see below). */
interface Guard {
  (attempt: Act, override: Act): Promise<GuardOutcome>;
}

/**
 * Run a re-extracting action; on a Hand Correction refusal, ask.
 *
 * `guard(attempt, override)` resolves "done" when `attempt` went through and
 * "asked" when the server refused it for a Hand Correction and the dialog is
 * now open, so the caller can drop its busy state. Any other error is thrown
 * on. "Extract anyway" closes the dialog first and then calls `override`
 * once, so a second click cannot send it twice. Render `dialog` once.
 */
export function useHandCorrectionGuard(): { guard: Guard; dialog: ReactNode } {
  type Pending = { fields: string[]; override: Act };
  const [pending, setPending] = useState(null as Pending | null);
  // The open question, read by "Extract anyway" and cleared by its first
  // click, so a double click cannot run the override twice.
  const pendingRef = useRef(null as Pending | null);

  const settle = useCallback((next: Pending | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const guard: Guard = useCallback(
    async (attempt: Act, override: Act) => {
      try {
        await attempt();
        return "done";
      } catch (error) {
        const fields = handCorrectedFieldsOf(error);
        if (!fields) throw error;
        settle({ fields, override });
        return "asked";
      }
    },
    [settle]
  );

  const extract = useCallback(() => {
    const asked = pendingRef.current;
    if (!asked) return;
    settle(null);
    void asked.override().catch((error) => console.error("Forced re-extraction failed:", error));
  }, [settle]);

  const dialog = (
    <HandCorrectionDialog fields={pending?.fields ?? null} onKeep={() => settle(null)} onExtract={extract} />
  );

  return { guard, dialog };
}
