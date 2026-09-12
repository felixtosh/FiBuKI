"use client";

import { GitMerge, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PartnerBulkActionBarProps {
  selectedCount: number;
  onMerge: () => void;
  onClearSelection: () => void;
}

export function PartnerBulkActionBar({
  selectedCount,
  onMerge,
  onClearSelection,
}: PartnerBulkActionBarProps) {
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full border bg-background px-3 py-2 shadow-lg">
      <span className="text-sm font-medium px-1 whitespace-nowrap">
        {selectedCount} selected
      </span>
      <Button size="sm" variant="outline" onClick={onMerge} disabled={selectedCount < 2}>
        <GitMerge className="h-4 w-4 mr-1.5" />
        Merge
      </Button>
      <Button size="sm" variant="ghost" onClick={onClearSelection} aria-label="Clear selection">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
