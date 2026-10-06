"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SummaryToast, type SummaryToastState } from "@/components/ui/summary-toast";
import type { ComponentDoc } from "@/lib/design-system/types";

function Tones() {
  const [toast, setToast] = useState<SummaryToastState | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div className="flex gap-2">
      <Button variant="outline" onClick={() => setToast({ message: "3 files connected", tone: "success" })}>Success</Button>
      <Button variant="outline" onClick={() => setToast({ message: "Could not connect 1 file", tone: "error" })}>Error</Button>
      <SummaryToast toast={toast} />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "SummaryToast",
  purpose: "A short message at the bottom of the screen after a bulk action finishes.",
  layer: "pattern",
  examples: [{ name: "Tones", Example: Tones }],
};
export default doc;
