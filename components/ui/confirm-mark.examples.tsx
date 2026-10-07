"use client";

import { useState } from "react";
import { ConfirmMark } from "@/components/ui/confirm-mark";
import type { ComponentDoc } from "@/lib/design-system/types";

const CONFIRMED = "You made or confirmed this. The matching learns from it.";
const CONFIRM = "Confirm this match. The matching learns from what you confirm.";

function States() {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-6 text-sm">
      <span className="flex items-center gap-2">
        <ConfirmMark confirmed={false} onConfirm={() => setConfirmed(true)} confirmedLabel={CONFIRMED} confirmLabel={CONFIRM} />
        Automatic, click to confirm
      </span>
      <span className="flex items-center gap-2">
        <ConfirmMark confirmed confirmedLabel={CONFIRMED} confirmLabel={CONFIRM} />
        Confirmed
      </span>
      <span className="flex items-center gap-2">
        <ConfirmMark confirmed={confirmed} onConfirm={() => setConfirmed(true)} confirmedLabel={CONFIRMED} confirmLabel={CONFIRM} />
        Try it
      </span>
      <span className="flex items-center gap-2">
        <ConfirmMark confirmed={false} pending confirmedLabel={CONFIRMED} confirmLabel={CONFIRM} />
        Confirming
      </span>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "ConfirmMark",
  purpose: "Beside the X of an automatic match (Partner pill, connected File or Transaction): a muted check mark that confirms it, or the green user-check once the User stands behind it.",
  layer: "pattern",
  examples: [{ name: "States", Example: States }],
};
export default doc;
