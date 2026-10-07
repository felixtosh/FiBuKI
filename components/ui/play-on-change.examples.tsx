"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { PlayOnChange } from "@/components/ui/play-on-change";
import type { ComponentDoc } from "@/lib/design-system/types";

const PARTNERS = ["A1 Telekom", "Kunde GmbH", "Hetzner"];

function ChangeVersusMount() {
  const [index, setIndex] = useState(0);
  const [mount, setMount] = useState(0);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" variant="outline" onClick={() => setIndex((i) => (i + 1) % PARTNERS.length)}>
        Change the Partner
      </Button>
      <Button size="sm" variant="outline" onClick={() => setMount((m) => m + 1)}>
        Remount (no animation)
      </Button>
      <PlayOnChange key={mount} value={PARTNERS[index]}>
        {(changed) => <Pill label={PARTNERS[index]} icon={Building2} matchedBy="auto" animate={changed} />}
      </PlayOnChange>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "PlayOnChange",
  purpose: "Plays a cell's animation (pill pop, check) only when its value changes on screen, never when the row appears.",
  layer: "primitive",
  examples: [{ name: "Change versus appear", Example: ChangeVersusMount }],
};
export default doc;
