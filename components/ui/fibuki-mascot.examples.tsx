"use client";

import { useState } from "react";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import type { ComponentDoc } from "@/lib/design-system/types";

function Sizes() {
  const [jumping, setJumping] = useState(false);
  return (
    <button type="button" className="flex items-end gap-4" onClick={() => setJumping((j) => !j)}>
      <FibukiMascot size={28} isJumping={jumping} />
      <FibukiMascot size={48} isJumping={jumping} />
      <FibukiMascot size={72} isJumping={jumping} forceFacingRight />
    </button>
  );
}

const doc: ComponentDoc = {
  title: "FibukiMascot",
  purpose: "The FiBuKI mascot; it follows the mouse and can jump.",
  layer: "brand",
  examples: [{ name: "Sizes (click to jump)", Example: Sizes }],
};
export default doc;
