"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Mail, Trash2, Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { UserPartner } from "@/types/partner";
import { EmailSearchPattern } from "@/types/email-integration";

interface EmailPatternsSectionProps {
  partner: UserPartner;
  onRemovePattern: (patternIndex: number) => Promise<void>;
  onTestPattern?: (pattern: string) => void;
}

export function EmailPatternsSection({
  partner,
  onRemovePattern,
  onTestPattern,
}: EmailPatternsSectionProps) {
  const [removingIndex, setRemovingIndex] = useState<number | null>(null);
  const patterns = partner.emailSearchPatterns || [];

  if (patterns.length === 0) {
    return null;
  }

  const handleRemove = async (index: number) => {
    setRemovingIndex(index);
    try {
      await onRemovePattern(index);
    } finally {
      setRemovingIndex(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Mail className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">Email Search Patterns</h3>
        <Badge variant="secondary" className="text-xs">
          {patterns.length}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        Learned search patterns for finding invoices from this partner in Gmail.
      </p>

      <div className="space-y-2">
        {patterns.map((pattern, index) => (
          <EmailPatternCard
            key={`${pattern.pattern}-${index}`}
            pattern={pattern}
            onRemove={() => handleRemove(index)}
            onTest={onTestPattern ? () => onTestPattern(pattern.pattern) : undefined}
            removing={removingIndex === index}
          />
        ))}
      </div>
    </div>
  );
}

interface EmailPatternCardProps {
  pattern: EmailSearchPattern;
  onRemove: () => void;
  onTest?: () => void;
  removing: boolean;
}

function EmailPatternCard({ pattern, onRemove, onTest, removing }: EmailPatternCardProps) {
  const lastUsed = pattern.lastUsedAt?.toDate?.() ?? new Date(pattern.lastUsedAt as unknown as string);
  const confidence = pattern.confidence;

  return (
    <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded truncate max-w-[200px]">
            {pattern.pattern}
          </code>
          <ConfidenceBadge confidence={confidence} />
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
          <span>Used {pattern.usageCount} time{pattern.usageCount !== 1 ? "s" : ""}</span>
          <span>&middot;</span>
          <span>Last used {formatDistanceToNow(lastUsed, { addSuffix: true })}</span>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {onTest && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onTest}
            className="h-8 w-8 p-0"
            title="Test this pattern"
          >
            <Search className="h-4 w-4" />
          </Button>
        )}

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              disabled={removing}
            >
              {removing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Search Pattern?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove the search pattern <code className="font-mono bg-muted px-1 rounded">{pattern.pattern}</code> from this partner.
                The pattern won&apos;t be suggested for future transactions.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onRemove}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  if (confidence >= 80) {
    return (
      <Badge variant="default" className="text-xs bg-green-50 text-green-900 border-green-300 hover:bg-green-50">
        High confidence
      </Badge>
    );
  }
  if (confidence >= 50) {
    return (
      <Badge variant="secondary" className="text-xs">
        Medium confidence
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs">
      Low confidence
    </Badge>
  );
}
