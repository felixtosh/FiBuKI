"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { ArrowRight, GitMerge, X } from "lucide-react";
import { db } from "@/lib/firebase/config";
import { Button } from "@/components/ui/button";

interface MergedPartnerNoticeProps {
  survivorId: string;
  onOpenSurvivor: (survivorId: string) => void;
  onClose: () => void;
}

/**
 * Shown when an old link opens a Partner that has since been merged away
 * (#263 AC7). The Merged Partner is returned as itself rather than a silent
 * redirect (ADR-0005), so this is where that "told once" moment lives.
 */
export function MergedPartnerNotice({
  survivorId,
  onOpenSurvivor,
  onClose,
}: MergedPartnerNoticeProps) {
  const [survivorName, setSurvivorName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSurvivorName() {
      try {
        const snapshot = await getDoc(doc(db, "partners", survivorId));
        if (!cancelled) {
          setSurvivorName(snapshot.exists() ? (snapshot.data().name as string) || null : null);
        }
      } catch {
        if (!cancelled) setSurvivorName(null);
      }
    }
    loadSurvivorName();
    return () => {
      cancelled = true;
    };
  }, [survivorId]);

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h2 className="font-semibold">Partner merged</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="p-4 space-y-4">
        <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3">
          <GitMerge className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">
            This partner was merged into{" "}
            {survivorName ? `"${survivorName}"` : "another partner"} and no longer appears
            in the list.
          </p>
        </div>
        <Button className="w-full" onClick={() => onOpenSurvivor(survivorId)}>
          Open {survivorName ? `"${survivorName}"` : "the surviving partner"}
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
