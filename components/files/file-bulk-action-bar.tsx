"use client";

import { Ban, Building2, FileCheck, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileBulkActionBarProps {
  selectedCount: number;
  onAssignPartner: () => void;
  onMarkAsNotInvoice: () => void;
  onMarkAsInvoice: () => void;
  onDelete: () => void;
  onClearSelection: () => void;
  isDeleting?: boolean;
  isUpdating?: boolean;
  isAssigningPartner?: boolean;
  progress?: { completed: number; total: number } | null;
}

export function FileBulkActionBar({
  selectedCount,
  onAssignPartner,
  onMarkAsNotInvoice,
  onMarkAsInvoice,
  onDelete,
  onClearSelection,
  isDeleting = false,
  isUpdating = false,
  isAssigningPartner = false,
  progress = null,
}: FileBulkActionBarProps) {
  const busy = isDeleting || isUpdating || isAssigningPartner;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full border bg-background px-3 py-2 shadow-lg">
      <span className="text-sm font-medium px-1 whitespace-nowrap">
        {progress
          ? `${isAssigningPartner ? "Assigning" : "Updating"} ${progress.completed} / ${progress.total}...`
          : `${selectedCount} selected`}
      </span>
      <Button size="sm" variant="outline" onClick={onAssignPartner} disabled={busy}>
        <Building2 className="h-4 w-4 mr-1.5" />
        Assign partner
      </Button>
      <Button size="sm" variant="outline" onClick={onMarkAsNotInvoice} disabled={busy}>
        <Ban className="h-4 w-4 mr-1.5" />
        Mark as not invoice
      </Button>
      <Button size="sm" variant="outline" onClick={onMarkAsInvoice} disabled={busy}>
        <FileCheck className="h-4 w-4 mr-1.5" />
        Mark as invoice
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-destructive hover:text-destructive hover:bg-destructive/10"
        onClick={onDelete}
        disabled={busy}
      >
        <Trash2 className="h-4 w-4 mr-1.5" />
        {isDeleting ? "Deleting..." : "Delete"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClearSelection} disabled={busy} aria-label="Clear selection">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
