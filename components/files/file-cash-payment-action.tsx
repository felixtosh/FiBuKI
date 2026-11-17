"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { TaxFile } from "@/types/file";
import { useSources } from "@/hooks/use-sources";
import { AddCashPaymentDialog } from "@/components/sources/add-cash-payment-dialog";
import {
  cashPaymentDefaultsFromFile,
  cashPaymentOffer,
} from "@/functions/src/transactions/cashPaymentDefaults";

/**
 * "Add as cash payment" on the File detail panel (#789): whether it is
 * offered (`promoted` on a File the extraction says was paid in cash,
 * `offered` on any other File with no Transaction), and the add-payment
 * dialog it opens, filled from the File and offering the User's Cash Boxes.
 */
export function useFileCashPayment(file: TaxFile): {
  offer: "promoted" | "offered" | null;
  open: () => void;
  dialog: ReactNode;
} {
  const [isOpen, setIsOpen] = useState(false);
  const { sources } = useSources();
  const offer = cashPaymentOffer(file);
  const cashBoxes = useMemo(
    () =>
      sources
        .filter((s) => s.accountKind === "cash")
        .map((s) => ({ id: s.id, name: s.name, currency: s.currency || "EUR" })),
    [sources]
  );

  // Mounted only while open, so the form starts from the File's current figures.
  const dialog = isOpen ? (
    <AddCashPaymentDialog
      open
      onClose={() => setIsOpen(false)}
      currency={cashBoxes[0]?.currency ?? file.extractedCurrency ?? "EUR"}
      fromFile={{ fileId: file.id, defaults: cashPaymentDefaultsFromFile(file) }}
      cashBoxes={cashBoxes}
    />
  ) : null;

  return { offer, open: () => setIsOpen(true), dialog };
}
