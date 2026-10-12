"use client";

import { useTranslations } from "next-intl";
import { PanelHeader } from "@/components/ui/detail-panel-primitives";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AutomationHistoryEntry } from "@/types/transaction";
import { ActivityHistory } from "./activity-history";

interface ActivityLogOverlayProps {
  entries: AutomationHistoryEntry[] | undefined;
  onClose: () => void;
}

/**
 * The activity log as a full-panel overlay over a detail panel, the same on
 * Transactions and Files. The panel's root must be `relative`.
 */
export function ActivityLogOverlay({ entries, onClose }: ActivityLogOverlayProps) {
  const t = useTranslations("activity");
  return (
    <div className="absolute inset-0 z-40 bg-background flex flex-col">
      <PanelHeader title={t("title")} onClose={onClose} />
      <ScrollArea className="flex-1 px-4 py-4">
        <ActivityHistory entries={entries} expandedByDefault />
      </ScrollArea>
    </div>
  );
}
