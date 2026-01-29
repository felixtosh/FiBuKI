"use client";

import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ImportRecord } from "@/types/import";
import { formatDistanceToNow } from "date-fns";
import { Clock, Trash2, ArrowRight, FileSpreadsheet } from "lucide-react";

interface DraftImportsSectionProps {
  sourceId: string;
  drafts: ImportRecord[];
  onDeleteDraft: (importId: string) => Promise<void>;
  isLoading?: boolean;
}

export function DraftImportsSection({
  sourceId,
  drafts,
  onDeleteDraft,
  isLoading,
}: DraftImportsSectionProps) {
  const router = useRouter();

  if (isLoading || drafts.length === 0) {
    return null;
  }

  const handleContinue = (importId: string) => {
    router.push(`/sources/${sourceId}/import?importId=${importId}&step=mapping`);
  };

  const handleDelete = async (importId: string) => {
    if (window.confirm("Delete this draft import?")) {
      await onDeleteDraft(importId);
    }
  };

  return (
    <Card className="border-dashed border-amber-300 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-700">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-medium flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-amber-600" />
          Draft Imports
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {drafts.map((draft) => {
          const createdAt = draft.createdAt?.toDate?.();
          const expiresAt = draft.expiresAt?.toDate?.();

          return (
            <div
              key={draft.id}
              className="flex items-center justify-between p-3 bg-background rounded-lg border"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{draft.fileName}</p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                  <span>{draft.totalRows} rows</span>
                  {createdAt && (
                    <span>
                      Started {formatDistanceToNow(createdAt, { addSuffix: true })}
                    </span>
                  )}
                  {expiresAt && (
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <Clock className="h-3 w-3" />
                      Expires {formatDistanceToNow(expiresAt, { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 ml-4">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(draft.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleContinue(draft.id)}
                >
                  Continue
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
