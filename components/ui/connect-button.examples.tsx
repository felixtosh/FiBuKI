"use client";

import { useState } from "react";
import { ConnectButton } from "@/components/ui/connect-button";
import type { ComponentDoc } from "@/lib/design-system/types";

function States() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ConnectButton isOpen={open} onClick={() => setOpen((o) => !o)} />
      <ConnectButton label="Connect file" />
      <ConnectButton showIcon={false} label="No icon" />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "ConnectButton",
  purpose: "Opens the connect overlay that links a File and a Transaction.",
  layer: "pattern",
  examples: [{ name: "States", Example: States }],
};
export default doc;
