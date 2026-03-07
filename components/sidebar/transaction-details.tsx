"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { format } from "date-fns";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { Timestamp } from "firebase/firestore";
import { Transaction } from "@/types/transaction";
import { TransactionSource } from "@/types/source";
import { UserPartner, GlobalPartner, PartnerSuggestion } from "@/types/partner";

/** Safely convert Firestore Timestamp or timestamp-like object to Date */
function toDate(ts: Timestamp | { seconds: number; nanoseconds: number } | Date | null | undefined): Date {
  if (!ts) return new Date();
  if (ts instanceof Date) return ts;
  if (ts instanceof Timestamp) return ts.toDate();
  if (typeof ts === "object" && "seconds" in ts) {
    return new Date(ts.seconds * 1000);
  }
  return new Date();
}
import { Button } from "@/components/ui/button";
import { AddPartnerDialog } from "@/components/partners/add-partner-dialog";
import { PartnerPill } from "@/components/partners/partner-pill";
import { FieldRow } from "@/components/ui/detail-panel-primitives";
import { usePartnerSuggestions, useAssignedPartner } from "@/hooks/use-partner-suggestions";
import { Plus, ExternalLink, Loader2, WandSparkles } from "lucide-react";
import { ShowMoreButton } from "@/components/ui/show-more-button";
import { cn } from "@/lib/utils";
import { functions } from "@/lib/firebase/config";
import { useChat } from "@/components/chat/chat-provider";

interface TransactionDetailsProps {
  transaction: Transaction;
  source?: TransactionSource;
  userPartners: UserPartner[];
  globalPartners: GlobalPartner[];
  onAssignPartner: (
    partnerId: string,
    partnerType: "global" | "user",
    matchedBy: "manual" | "suggestion" | "auto",
    confidence?: number
  ) => Promise<void>;
  onRemovePartner: () => Promise<void>;
  onCreatePartner: (data: { name: string; aliases?: string[]; vatId?: string; ibans?: string[]; website?: string; country?: string; notes?: string }, options?: { skipAutoMatch?: boolean }) => Promise<string>;
}

export function TransactionDetails({
  transaction,
  source,
  userPartners,
  globalPartners,
  onAssignPartner,
  onRemovePartner,
  onCreatePartner,
}: TransactionDetailsProps) {
  const router = useRouter();
  const [isAddPartnerOpen, setIsAddPartnerOpen] = useState(false);
  const [isAssigningPartner, setIsAssigningPartner] = useState(false);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const matchedTransactionIds = useRef<Set<string>>(new Set());

  // Chat hook for agentic partner search
  const { startPartnerSearch, activeWandTargets, notifications } = useChat();
  const hasRunningWorkerNotification = notifications.some(
    (notification) =>
      notification.type === "worker_activity" &&
      notification.context.workerStatus === "running" &&
      notification.context.transactionId === transaction.id
  );
  const isWandActive = activeWandTargets.has(transaction.id) || hasRunningWorkerNotification;

  // Get partner suggestions and assigned partner (all from server-side data)
  const suggestions = usePartnerSuggestions(transaction, userPartners, globalPartners);
  const assignedPartner = useAssignedPartner(transaction, userPartners, globalPartners);

  // Memoize initialData to prevent unnecessary re-renders of AddPartnerDialog
  const dialogInitialData = useMemo(() => ({
    name: transaction.partner || transaction.name || undefined,
    ibans: transaction.partnerIban ? [transaction.partnerIban] : undefined,
  }), [transaction.partner, transaction.name, transaction.partnerIban]);

  // Trigger partner matching when opening a transaction without partner/suggestions
  useEffect(() => {
    const shouldMatch =
      !assignedPartner &&
      suggestions.length === 0 &&
      !matchedTransactionIds.current.has(transaction.id);

    if (shouldMatch) {
      matchedTransactionIds.current.add(transaction.id);
      setIsLoadingSuggestions(true);

      const matchPartners = httpsCallable(functions, "matchPartners");
      matchPartners({ transactionIds: [transaction.id] })
        .catch((error) => {
          console.error("Failed to match partners:", error);
        })
        .finally(() => {
          setIsLoadingSuggestions(false);
        });
    }
  }, [transaction.id, assignedPartner, suggestions.length]);

  const handleSelectSuggestion = async (suggestion: PartnerSuggestion) => {
    setIsAssigningPartner(true);
    try {
      await onAssignPartner(
        suggestion.partnerId,
        suggestion.partnerType,
        "suggestion",
        suggestion.confidence
      );
    } finally {
      setIsAssigningPartner(false);
    }
  };

  const handleRemovePartner = async () => {
    setIsAssigningPartner(true);
    try {
      // Prevent triggering matchPartners on the server after removal
      matchedTransactionIds.current.add(transaction.id);
      await onRemovePartner();
    } catch (error) {
      // If removal failed, allow matching again
      matchedTransactionIds.current.delete(transaction.id);
      throw error;
    } finally {
      setIsAssigningPartner(false);
    }
  };

  const handleNavigateToPartner = () => {
    if (transaction.partnerId) {
      router.push(`/partners?id=${transaction.partnerId}`);
    }
  };

  const handleAddPartner = async (data: { name: string; aliases?: string[]; vatId?: string; ibans?: string[]; website?: string; country?: string; notes?: string }) => {
    // Skip auto-match on partner create - we're manually assigning immediately after
    // This prevents race condition where onPartnerCreate auto-matches before manual assignment
    const partnerId = await onCreatePartner(data, { skipAutoMatch: true });
    // Auto-assign the newly created partner
    await onAssignPartner(partnerId, "user", "manual", 100);
    return partnerId;
  };

  const handleSelectExistingPartner = async (partnerId: string, partnerType: "user" | "global") => {
    setIsAssigningPartner(true);
    try {
      await onAssignPartner(partnerId, partnerType, "manual", 100);
    } finally {
      setIsAssigningPartner(false);
    }
  };

  const formattedAmount = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: transaction.currency || "EUR",
  }).format(transaction.amount / 100);

  return (
    <div className="space-y-3">
      <FieldRow label="Date" labelWidth="w-32">
        {format(toDate(transaction.date), "MMM d, yyyy")}
      </FieldRow>

      <FieldRow label="Amount" labelWidth="w-32">
        <span className={cn("tabular-nums", transaction.amount < 0 ? "text-amount-negative" : "text-amount-positive")}>
          {formattedAmount}
        </span>
      </FieldRow>

      {transaction.partner && (
        <FieldRow label="Counterparty" labelWidth="w-32">
          {transaction.partner}
        </FieldRow>
      )}

      {transaction.partnerIban && (
        <FieldRow label="IBAN" labelWidth="w-32">
          <span className="font-mono text-xs">{transaction.partnerIban}</span>
        </FieldRow>
      )}

      <FieldRow label="Description" labelWidth="w-32">
        {transaction.name}
      </FieldRow>

      {transaction.reference && (
        <FieldRow label="Reference" labelWidth="w-32">
          <span className="font-mono text-xs">{transaction.reference}</span>
        </FieldRow>
      )}

      {source && (
        <FieldRow label="Account" labelWidth="w-32">
          <Link
            href={`/sources/${source.id}`}
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            {source.name}
            <ExternalLink className="h-3 w-3" />
          </Link>
        </FieldRow>
      )}

      {/* Show More / Metadata Toggle */}
      <FieldRow label="" labelWidth="w-32">
        <ShowMoreButton
          expanded={showMetadata}
          onToggle={() => setShowMetadata(!showMetadata)}
        />
      </FieldRow>

      {/* Metadata Section (collapsible) */}
      {showMetadata && (
        <div className="space-y-3 pt-2 pb-1 animate-in slide-in-from-top-2 duration-200">
          <FieldRow label="Dedupe Hash" labelWidth="w-32">
            <span className="font-mono text-xs truncate max-w-[200px]" title={transaction.dedupeHash}>
              {transaction.dedupeHash.slice(0, 16)}...
            </span>
          </FieldRow>

          {transaction.importJobId && (
            <FieldRow label="Import Job" labelWidth="w-32">
              <span className="font-mono text-xs">
                {transaction.importJobId.slice(0, 8)}...
              </span>
            </FieldRow>
          )}

          <FieldRow label="Created" labelWidth="w-32">
            {format(toDate(transaction.createdAt), "MMM d, yyyy HH:mm")}
          </FieldRow>

          <FieldRow label="Updated" labelWidth="w-32">
            {format(toDate(transaction.updatedAt), "MMM d, yyyy HH:mm")}
          </FieldRow>
        </div>
      )}

      {/* Partner section */}
      <div className="border-t pt-3 mt-3 -mx-4 px-4" data-onboarding="partner-section">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">Partner</h3>
          {/* Show search button only when no partner assigned */}
          {!assignedPartner && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => startPartnerSearch(transaction.id)}
              disabled={isWandActive}
              title="AI search for partner"
            >
              {isWandActive ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <WandSparkles className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>

        <FieldRow label="Connect" labelWidth="w-32">
          {assignedPartner ? (
            <PartnerPill
              name={assignedPartner.name}
              confidence={transaction.partnerMatchConfidence ?? undefined}
              matchedBy={transaction.partnerMatchedBy}
              partnerType={transaction.partnerType ?? undefined}
              onClick={handleNavigateToPartner}
              onRemove={handleRemovePartner}
            />
          ) : isLoadingSuggestions ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsAddPartnerOpen(true)}
              className="h-7 px-3"
            >
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          )}
        </FieldRow>

        {/* Partner suggestions when no match */}
        {!assignedPartner && !isLoadingSuggestions && suggestions.length > 0 && (
          <FieldRow label="Suggestions" labelWidth="w-32" className="mt-1">
            <div className="flex flex-wrap gap-1.5">
              {suggestions.slice(0, 3).map((suggestion) => (
                <PartnerPill
                  key={suggestion.partnerId}
                  name={suggestion.partner.name}
                  confidence={suggestion.confidence}
                  variant="suggestion"
                  partnerType={suggestion.partnerType}
                  onClick={() => handleSelectSuggestion(suggestion)}
                  disabled={isAssigningPartner}
                />
              ))}
            </div>
          </FieldRow>
        )}
      </div>

      {/* Add Partner Dialog */}
      <AddPartnerDialog
        open={isAddPartnerOpen}
        onClose={() => setIsAddPartnerOpen(false)}
        onAdd={handleAddPartner}
        onSelectPartner={handleSelectExistingPartner}
        onSelectSuggestion={handleSelectSuggestion}
        suggestions={suggestions}
        userPartners={userPartners}
        globalPartners={globalPartners}
        initialData={dialogInitialData}
      />
    </div>
  );
}
