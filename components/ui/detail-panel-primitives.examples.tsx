"use client";

import { useState } from "react";
import { ArrowRightLeft, FileText, Inbox, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CollapsibleListSection,
  EmptyState,
  FieldRow,
  FileListItem,
  ListItem,
  PanelContainer,
  PanelContent,
  PanelFooter,
  PanelHeader,
  SectionDivider,
  SectionHeader,
} from "@/components/ui/detail-panel-primitives";
import type { ComponentDoc } from "@/lib/design-system/types";

/** The same parts every detail panel (Transaction, File, Partner) is built from. */
export function SampleDetailPanel({ onClose = () => {} }: { onClose?: () => void }) {
  const [index, setIndex] = useState(1);
  return (
    <PanelContainer>
      <PanelHeader
        title="A1 Telekom"
        icon={<Receipt className="h-5 w-5" />}
        onClose={onClose}
        onNavigatePrevious={() => setIndex((i) => i - 1)}
        onNavigateNext={() => setIndex((i) => i + 1)}
        hasPrevious={index > 0}
        hasNext={index < 2}
      />
      <PanelContent>
        <div className="space-y-3">
          <FieldRow label="Date">15.03.2026</FieldRow>
          <FieldRow label="Amount">
            <span className="tabular-nums text-amount-negative">-€49,90</span>
          </FieldRow>
          <FieldRow label="IBAN">
            <span className="font-mono text-xs">AT61 1904 3002 3457 3201</span>
          </FieldRow>
        </div>
        <SectionDivider />
        <SectionHeader>Files</SectionHeader>
        <FileListItem fileName="Rechnung 2026-031.pdf" date="15.03.2026" amount={4990} onClick={() => {}} onRemove={() => {}} />
        <FileListItem fileName="Beleg.jpg" date="16.03.2026" onClick={() => {}} isExtracting />
        <SectionDivider />
        <CollapsibleListSection title="Transactions" icon={<ArrowRightLeft className="h-4 w-4" />} count={2} defaultOpen>
          <ListItem title="A1 Telekom" subtitle="15.03.2026" amount={-4990} isNegative onClick={() => {}} />
          <ListItem title="A1 Telekom" subtitle="15.02.2026" amount={-4990} isNegative onClick={() => {}} badge={<Badge variant="success">Complete</Badge>} />
        </CollapsibleListSection>
      </PanelContent>
      <PanelFooter>
        <Button variant="outline" size="sm">Open partner</Button>
      </PanelFooter>
    </PanelContainer>
  );
}

function Panel() {
  return (
    <div className="h-[560px] max-w-md border rounded-md overflow-hidden">
      <SampleDetailPanel />
    </div>
  );
}

function Empty() {
  return (
    <div className="max-w-md border rounded-md">
      <EmptyState
        icon={<Inbox className="h-8 w-8" />}
        title="No files connected"
        description="Connect a receipt to complete this transaction."
        action={<Button size="sm"><FileText className="h-4 w-4 mr-2" />Connect file</Button>}
      />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Detail panel primitives",
  purpose: "The parts every detail panel is built from: PanelHeader, FieldRow, SectionHeader, list items, footer, EmptyState.",
  layer: "pattern",
  examples: [
    { name: "A whole panel", Example: Panel },
    { name: "Empty section", Example: Empty },
  ],
};
export default doc;
