"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  X,
  Building2,
  Globe,
  CreditCard,
  FileText,
  Pencil,
  Trash2,
  ExternalLink,
  Receipt,
  ChevronRight,
  ChevronDown,
  Ban,
  Mail,
  File,
  UserCheck,
  Loader2,
  Check,
  AlertCircle,
  Zap,
  Hash,
  MapPin,
  StickyNote,
  Link as LinkIcon,
  Tag,
} from "lucide-react";
import { UserPartner, PartnerFormData, ManualRemoval, ManualFileRemoval } from "@/types/partner";
import { Transaction } from "@/types/transaction";
import { TaxFile } from "@/types/file";
import { usePartners } from "@/hooks/use-partners";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import { formatIban } from "@/lib/import/deduplication";
import { useState, useEffect, useMemo, ReactNode } from "react";
import { AddPartnerDialog } from "./add-partner-dialog";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  documentId,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { format } from "date-fns";
import Link from "next/link";
import {
  removeEmailPatternFromPartner,
  mergePartnerIntoUserData,
  reextractFilesForPartner,
  unmarkPartnerAsMe,
} from "@/lib/operations";
import { useUserData } from "@/hooks/use-user-data";
import { useInvoiceSources } from "@/hooks/use-invoice-sources";
import { InvoiceSourcesSection } from "./invoice-sources-section";
import { RuleCard } from "./rule-card";
// Collapsible components used internally by CollapsibleListSection primitive
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FieldRow, SectionHeader, CollapsibleListSection, ListItem } from "@/components/ui/detail-panel-primitives";
import { useAuth } from "@/components/auth";
import { Bot, Hand, Sparkles, MousePointerClick } from "lucide-react";
import { useNoReceiptCategories } from "@/hooks/use-no-receipt-categories";

// ============================================================================
// Match Source Badge
// ============================================================================

type MatchedBy = "manual" | "auto" | "ai" | "suggestion" | null | undefined;

function MatchSourceBadge({ matchedBy }: { matchedBy: MatchedBy }) {
  if (!matchedBy) return null;

  const configs: Record<string, { icon: ReactNode; label: string; className: string }> = {
    manual: {
      icon: <Hand className="h-3 w-3" />,
      label: "Manual",
      className: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    },
    ai: {
      icon: <Bot className="h-3 w-3" />,
      label: "AI",
      className: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
    },
    auto: {
      icon: <Sparkles className="h-3 w-3" />,
      label: "Auto",
      className: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    },
    suggestion: {
      icon: <MousePointerClick className="h-3 w-3" />,
      label: "Click",
      className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    },
  };

  const config = configs[matchedBy];
  if (!config) return null;

  return (
    <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium", config.className)}>
      {config.icon}
      {config.label}
    </span>
  );
}

interface PartnerDetailPanelProps {
  partner: UserPartner;
  onClose: () => void;
}

interface FeedbackMessage {
  type: "success" | "info" | "error";
  text: string;
}

// NOTE: SectionHeader, CollapsibleListSection, and ListItem are now imported
// from @/components/ui/detail-panel-primitives for consistency across all panels

export function PartnerDetailPanel({
  partner,
  onClose,
}: PartnerDetailPanelProps) {
  const { userId } = useAuth();
  const { updatePartner, deletePartner } = usePartners();
  const { integrations } = useEmailIntegrations();
  const { isPartnerMarkedAsMe } = useUserData();
  const { categories: allCategories } = useNoReceiptCategories();
  const invoiceSourcesHook = useInvoiceSources({ partnerId: partner.id });
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isMarkingAsMe, setIsMarkingAsMe] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackMessage | null>(null);

  const isMarkedAsMe = isPartnerMarkedAsMe(partner.id);
  const ctx = useMemo(() => ({ db, userId: userId ?? "" }), [userId]);

  const integrationLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const integration of integrations) {
      map.set(
        integration.id,
        integration.displayName || integration.email || integration.provider
      );
    }
    return map;
  }, [integrations]);

  const gmailFilePatterns = useMemo(() => {
    return (partner.fileSourcePatterns || [])
      .filter((pattern) => pattern.sourceType === "gmail")
      .sort((a, b) => {
        if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
        return b.confidence - a.confidence;
      });
  }, [partner.fileSourcePatterns]);

  // Clear feedback after 4 seconds
  useEffect(() => {
    if (feedback) {
      const timer = setTimeout(() => setFeedback(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [feedback]);

  // Transaction state
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [totalTransactionCount, setTotalTransactionCount] = useState(0);
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(true);

  // File state
  const [files, setFiles] = useState<TaxFile[]>([]);
  const [totalFileCount, setTotalFileCount] = useState(0);
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);

  // Fetch transactions
  useEffect(() => {
    async function fetchTransactions() {
      setIsLoadingTransactions(true);
      try {
        const q = query(
          collection(db, "transactions"),
          where("userId", "==", userId),
          where("partnerId", "==", partner.id),
          orderBy("date", "desc"),
          limit(10)
        );
        const snapshot = await getDocs(q);
        const txs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Transaction[];

        setTransactions(txs);
        setTotalTransactionCount(snapshot.size);
      } catch (error) {
        console.error("Failed to fetch transactions:", error);
      } finally {
        setIsLoadingTransactions(false);
      }
    }
    fetchTransactions();
  }, [partner.id, userId]);

  // Fetch files - includes files directly matched to partner AND files connected to partner's transactions
  useEffect(() => {
    async function fetchFiles() {
      setIsLoadingFiles(true);
      try {
        // First get transaction IDs for this partner (to find files connected to them)
        const txIds = transactions.map((tx) => tx.id);

        // Query 1: Files directly matched to this partner
        const directFilesQuery = query(
          collection(db, "files"),
          where("userId", "==", userId),
          where("partnerId", "==", partner.id),
          orderBy("uploadedAt", "desc"),
          limit(10)
        );
        const directSnapshot = await getDocs(directFilesQuery);
        const directFiles = directSnapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as TaxFile[];

        // Query 2: Files connected to partner's transactions (if we have transaction IDs)
        let connectedFiles: TaxFile[] = [];
        if (txIds.length > 0) {
          // Firestore array-contains-any supports up to 30 values
          const txIdBatches = [];
          for (let i = 0; i < txIds.length; i += 10) {
            txIdBatches.push(txIds.slice(i, i + 10));
          }

          for (const batch of txIdBatches.slice(0, 3)) { // Limit to 3 batches (30 txs)
            const connectedQuery = query(
              collection(db, "files"),
              where("userId", "==", userId),
              where("transactionIds", "array-contains-any", batch),
              limit(10)
            );
            const connectedSnapshot = await getDocs(connectedQuery);
            connectedFiles.push(
              ...connectedSnapshot.docs.map((doc) => ({
                id: doc.id,
                ...doc.data(),
              })) as TaxFile[]
            );
          }
        }

        // Merge and dedupe
        const allFilesMap = new Map<string, TaxFile>();
        for (const f of [...directFiles, ...connectedFiles]) {
          if (!allFilesMap.has(f.id)) {
            allFilesMap.set(f.id, f);
          }
        }
        const allFiles = Array.from(allFilesMap.values())
          .sort((a, b) => {
            const aTime = a.uploadedAt?.toMillis?.() || 0;
            const bTime = b.uploadedAt?.toMillis?.() || 0;
            return bTime - aTime;
          })
          .slice(0, 10);

        setFiles(allFiles);
        setTotalFileCount(allFilesMap.size);
      } catch (error) {
        console.error("Failed to fetch files:", error);
      } finally {
        setIsLoadingFiles(false);
      }
    }

    // Wait for transactions to load first
    if (!isLoadingTransactions) {
      fetchFiles();
    }
  }, [partner.id, transactions, isLoadingTransactions, userId]);

  // Compute categories from transactions that have noReceiptCategoryId
  const connectedCategories = useMemo(() => {
    const categoryMap = new Map<string, { categoryId: string; name: string; count: number }>();
    for (const tx of transactions) {
      if (tx.noReceiptCategoryId) {
        const existing = categoryMap.get(tx.noReceiptCategoryId);
        if (existing) {
          existing.count++;
        } else {
          // Look up category name from user's categories
          const category = allCategories.find((c) => c.id === tx.noReceiptCategoryId);
          categoryMap.set(tx.noReceiptCategoryId, {
            categoryId: tx.noReceiptCategoryId,
            name: category?.name || tx.noReceiptCategoryId,
            count: 1,
          });
        }
      }
    }
    return Array.from(categoryMap.values()).sort((a, b) => b.count - a.count);
  }, [transactions, allCategories]);

  const handleEdit = async (data: PartnerFormData) => {
    await updatePartner(partner.id, data);
  };

  const handleDelete = async () => {
    if (confirm("Are you sure you want to delete this partner?")) {
      await deletePartner(partner.id);
      onClose();
    }
  };

  const handleRemoveEmailPattern = async (patternIndex: number) => {
    await removeEmailPatternFromPartner(ctx, partner.id, patternIndex);
  };

  const handleMarkAsMe = async () => {
    setIsMarkingAsMe(true);
    setFeedback(null);
    try {
      const result = await mergePartnerIntoUserData(ctx, {
        partnerId: partner.id,
        name: partner.name,
        vatId: partner.vatId,
        ibans: partner.ibans,
      });
      const reextractResult = await reextractFilesForPartner(ctx, partner.id);

      const added: string[] = [];
      if (result.aliasAdded) added.push("name");
      if (result.vatIdAdded) added.push("VAT ID");
      if (result.ibansAdded > 0)
        added.push(`${result.ibansAdded} IBAN${result.ibansAdded > 1 ? "s" : ""}`);

      if (added.length > 0 || reextractResult.queuedCount > 0) {
        const parts: string[] = [];
        if (added.length > 0) parts.push(`Added ${added.join(", ")} to your identity.`);
        if (reextractResult.queuedCount > 0)
          parts.push(`Re-extracting ${reextractResult.queuedCount} file${reextractResult.queuedCount > 1 ? "s" : ""}.`);
        setFeedback({ type: "success", text: parts.join(" ") });
      } else {
        setFeedback({
          type: "info",
          text: "This partner's info is already in your user data.",
        });
      }
    } catch (error) {
      console.error("Failed to mark partner as me:", error);
      setFeedback({ type: "error", text: "Failed to add partner to your identity." });
    } finally {
      setIsMarkingAsMe(false);
    }
  };

  const handleUnmarkAsMe = async () => {
    setIsMarkingAsMe(true);
    setFeedback(null);
    try {
      const removed = await unmarkPartnerAsMe(ctx, partner.id);
      if (removed) setFeedback({ type: "success", text: "Removed from your companies." });
    } catch (error) {
      console.error("Failed to unmark partner:", error);
      setFeedback({ type: "error", text: "Failed to remove from your companies." });
    } finally {
      setIsMarkingAsMe(false);
    }
  };

  // Check if we have any matching rules to show
  const hasMatchingRules =
    partner.ibans.length > 0 ||
    partner.vatId ||
    partner.website ||
    partner.learnedPatterns?.length ||
    partner.aliases.some((a) => a.includes("*")) ||
    partner.emailDomains?.length ||
    gmailFilePatterns.length > 0;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold truncate">{partner.name}</h2>
            {isMarkedAsMe && (
              <span className="text-xs text-primary">My Company</span>
            )}
            {partner.globalPartnerId && !isMarkedAsMe && (
              <span className="text-xs text-muted-foreground">
                Global Partner
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-6">
          {/* Basic Info Section */}
          <div className="space-y-1">
            {partner.aliases.length > 0 && (
              <FieldRow label="Also known as" icon={<Hash className="h-3 w-3" />}>
                <div className="flex flex-wrap gap-1">
                  {partner.aliases.filter((a) => !a.includes("*")).map((alias, idx) => (
                    <Badge key={idx} variant="secondary" className="text-xs">
                      {alias}
                    </Badge>
                  ))}
                </div>
              </FieldRow>
            )}

            {partner.vatId && (
              <FieldRow label="VAT ID" icon={<FileText className="h-3 w-3" />}>
                <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                  {partner.vatId}
                </code>
              </FieldRow>
            )}

            {partner.ibans.length > 0 && (
              <FieldRow label="Bank" icon={<CreditCard className="h-3 w-3" />}>
                <div className="space-y-0.5">
                  {partner.ibans.map((iban, idx) => (
                    <code key={idx} className="font-mono text-xs block">
                      {formatIban(iban)}
                    </code>
                  ))}
                </div>
              </FieldRow>
            )}

            {partner.website && (
              <FieldRow label="Website" icon={<Globe className="h-3 w-3" />}>
                <a
                  href={`https://${partner.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  {partner.website}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </FieldRow>
            )}

            {partner.address && (
              <FieldRow label="Address" icon={<MapPin className="h-3 w-3" />}>
                <div className="space-y-0.5">
                  {partner.address.street && <p>{partner.address.street}</p>}
                  {(partner.address.postalCode || partner.address.city) && (
                    <p>
                      {[partner.address.postalCode, partner.address.city]
                        .filter(Boolean)
                        .join(" ")}
                    </p>
                  )}
                  {partner.address.country && <p>{partner.address.country}</p>}
                </div>
              </FieldRow>
            )}

            {partner.notes && (
              <FieldRow label="Notes" icon={<StickyNote className="h-3 w-3" />}>
                <p className="text-muted-foreground whitespace-pre-wrap">
                  {partner.notes}
                </p>
              </FieldRow>
            )}
          </div>

          {/* Matching Rules Section */}
          {hasMatchingRules && (
            <div className="space-y-3">
              <SectionHeader>Matching Rules</SectionHeader>
              <div className="grid gap-2">
                {/* IBAN Rule */}
                {partner.ibans.length > 0 && (
                  <RuleCard
                    icon={<CreditCard className="h-4 w-4" />}
                    title="IBAN Match"
                    confidence={100}
                    variant="manual"
                  >
                    <div className="flex flex-wrap gap-1">
                      {partner.ibans.map((iban, idx) => (
                        <code
                          key={idx}
                          className="text-xs bg-green-100/50 dark:bg-green-900/30 px-1.5 py-0.5 rounded font-mono"
                        >
                          {formatIban(iban)}
                        </code>
                      ))}
                    </div>
                  </RuleCard>
                )}

                {/* VAT ID Rule */}
                {partner.vatId && (
                  <RuleCard
                    icon={<FileText className="h-4 w-4" />}
                    title="VAT ID Match"
                    confidence={95}
                    variant="manual"
                  >
                    <code className="text-xs bg-green-100/50 dark:bg-green-900/30 px-1.5 py-0.5 rounded font-mono">
                      {partner.vatId}
                    </code>
                  </RuleCard>
                )}

                {/* Website Rule */}
                {partner.website && (
                  <RuleCard
                    icon={<Globe className="h-4 w-4" />}
                    title="Domain Match"
                    confidence={90}
                  >
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                      *{partner.website}*
                    </code>
                  </RuleCard>
                )}

                {/* Manual Patterns */}
                {partner.aliases.some((a) => a.includes("*")) && (
                  <RuleCard
                    icon={<Zap className="h-4 w-4" />}
                    title="Manual Patterns"
                    confidence={90}
                    variant="manual"
                  >
                    <div className="flex flex-wrap gap-1">
                      {partner.aliases
                        .filter((a) => a.includes("*"))
                        .map((alias, idx) => (
                          <code
                            key={idx}
                            className="text-xs bg-green-100/50 dark:bg-green-900/30 px-1.5 py-0.5 rounded font-mono"
                          >
                            {alias}
                          </code>
                        ))}
                    </div>
                  </RuleCard>
                )}

                {/* Learned Patterns */}
                {partner.learnedPatterns && partner.learnedPatterns.length > 0 && (
                  <RuleCard
                    icon={<Zap className="h-4 w-4" />}
                    title="Learned Patterns"
                    variant="learned"
                  >
                    <div className="space-y-1">
                      {partner.learnedPatterns.slice(0, 3).map((pattern, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <code className="text-xs bg-blue-100/50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded font-mono flex-1 truncate">
                            {pattern.pattern}
                          </code>
                          <Badge variant="outline" className="text-[10px]">
                            {pattern.confidence}%
                          </Badge>
                        </div>
                      ))}
                      {partner.learnedPatterns.length > 3 && (
                        <p className="text-xs text-muted-foreground">
                          +{partner.learnedPatterns.length - 3} more
                        </p>
                      )}
                    </div>
                  </RuleCard>
                )}

                {/* Email Domains */}
                {partner.emailDomains && partner.emailDomains.length > 0 && (
                  <RuleCard
                    icon={<Mail className="h-4 w-4" />}
                    title="Email Domains"
                    confidence={90}
                    variant="learned"
                  >
                    <div className="flex flex-wrap gap-1">
                      {partner.emailDomains.map((domain, idx) => (
                        <code
                          key={idx}
                          className="text-xs bg-blue-100/50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded font-mono"
                        >
                          @{domain}
                        </code>
                      ))}
                    </div>
                  </RuleCard>
                )}

                {/* Gmail Search Patterns */}
                {gmailFilePatterns.length > 0 && (
                  <RuleCard
                    icon={<Mail className="h-4 w-4" />}
                    title="Gmail Searches"
                    variant="learned"
                  >
                    <div className="space-y-1">
                      {gmailFilePatterns.slice(0, 2).map((pattern, idx) => (
                        <div key={idx} className="flex items-center gap-1.5">
                          <code className="text-xs bg-blue-100/50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded font-mono flex-1 truncate">
                            {pattern.pattern}
                          </code>
                          <Badge variant="outline" className="text-[10px]">
                            {pattern.confidence}%
                          </Badge>
                        </div>
                      ))}
                      {gmailFilePatterns.length > 2 && (
                        <p className="text-xs text-muted-foreground">
                          +{gmailFilePatterns.length - 2} more
                        </p>
                      )}
                    </div>
                  </RuleCard>
                )}

                {/* Name Match - always shown */}
                <RuleCard
                  icon={<Building2 className="h-4 w-4" />}
                  title="Name Match"
                  confidence={70}
                >
                  <div className="flex flex-wrap gap-1">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {partner.name}
                    </code>
                    {partner.aliases
                      .filter((a) => !a.includes("*"))
                      .slice(0, 2)
                      .map((alias, idx) => (
                        <code
                          key={idx}
                          className="text-xs bg-muted px-1.5 py-0.5 rounded"
                        >
                          {alias}
                        </code>
                      ))}
                  </div>
                </RuleCard>
              </div>
            </div>
          )}

          {/* Invoice Sources Section */}
          <div className="space-y-3">
            <SectionHeader>Invoice Sources</SectionHeader>
            <InvoiceSourcesSection
              partner={partner}
              onAddSource={invoiceSourcesHook.addSource}
              onRemoveSource={invoiceSourcesHook.removeSource}
              onToggleStatus={invoiceSourcesHook.toggleSourceStatus}
              onFetchNow={invoiceSourcesHook.triggerFetch}
              onPromoteLink={invoiceSourcesHook.promoteLink}
              onInferFrequency={invoiceSourcesHook.inferFrequency}
              isLoading={invoiceSourcesHook.isLoading}
            />
          </div>

          {/* Divider */}
          <div className="border-t" />

          {/* Connected Data - Collapsible */}
          <div className="space-y-2">
            <SectionHeader>Connected Data</SectionHeader>

            {/* Transactions */}
            <CollapsibleListSection
              title="Transactions"
              icon={<Receipt className="h-4 w-4" />}
              count={totalTransactionCount}
              isLoading={isLoadingTransactions}
              viewAllLink={`/transactions?partnerIds=${partner.id}`}
              viewAllLabel={`View all ${totalTransactionCount} transactions`}
            >
              {transactions.length === 0 && !isLoadingTransactions && (!partner.manualRemovals || partner.manualRemovals.length === 0) ? (
                <p className="text-sm text-muted-foreground py-2">
                  No transactions connected
                </p>
              ) : (
                <>
                  {transactions.slice(0, 5).map((tx) => (
                    <ListItem
                      key={tx.id}
                      href={`/transactions?id=${tx.id}`}
                      title={tx.name}
                      subtitle={
                        tx.date?.toDate
                          ? format(tx.date.toDate(), "MMM d, yyyy")
                          : ""
                      }
                      amount={tx.amount}
                      currency={tx.currency}
                      isNegative={tx.amount < 0}
                      badge={<MatchSourceBadge matchedBy={tx.partnerMatchedBy} />}
                    />
                  ))}
                  {/* Manual Rejects */}
                  {partner.manualRemovals && partner.manualRemovals.length > 0 && (
                    <div className="pt-2 border-t mt-2">
                      <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                        <Ban className="h-3 w-3" />
                        Rejected ({partner.manualRemovals.length})
                      </p>
                      {partner.manualRemovals.slice(0, 3).map((removal) => (
                        <div
                          key={removal.transactionId}
                          className="flex items-center gap-2 py-1.5 px-2 -mx-2 rounded text-muted-foreground line-through opacity-60"
                        >
                          <span className="text-sm truncate flex-1">
                            {removal.name || removal.partner || "Unknown"}
                          </span>
                        </div>
                      ))}
                      {partner.manualRemovals.length > 3 && (
                        <p className="text-xs text-muted-foreground pl-2">
                          +{partner.manualRemovals.length - 3} more
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </CollapsibleListSection>

            {/* Files */}
            <CollapsibleListSection
              title="Files"
              icon={<File className="h-4 w-4" />}
              count={totalFileCount}
              isLoading={isLoadingFiles}
              viewAllLink={`/files?partnerId=${partner.id}`}
              viewAllLabel={`View all ${totalFileCount} files`}
            >
              {files.length === 0 && !isLoadingFiles && (!partner.manualFileRemovals || partner.manualFileRemovals.length === 0) ? (
                <p className="text-sm text-muted-foreground py-2">
                  No files connected
                </p>
              ) : (
                <>
                  {files.slice(0, 5).map((file) => (
                    <ListItem
                      key={file.id}
                      href={`/files?id=${file.id}`}
                      title={file.fileName}
                      subtitle={
                        file.uploadedAt?.toDate
                          ? format(file.uploadedAt.toDate(), "MMM d, yyyy")
                          : ""
                      }
                      amount={file.extractedAmount || undefined}
                      currency={file.extractedCurrency || undefined}
                      isNegative={false}
                      badge={<MatchSourceBadge matchedBy={file.partnerMatchedBy} />}
                    />
                  ))}
                  {/* Manual File Rejects */}
                  {partner.manualFileRemovals && partner.manualFileRemovals.length > 0 && (
                    <div className="pt-2 border-t mt-2">
                      <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                        <Ban className="h-3 w-3" />
                        Rejected ({partner.manualFileRemovals.length})
                      </p>
                      {partner.manualFileRemovals.slice(0, 3).map((removal) => (
                        <div
                          key={removal.fileId}
                          className="flex items-center gap-2 py-1.5 px-2 -mx-2 rounded text-muted-foreground line-through opacity-60"
                        >
                          <span className="text-sm truncate flex-1">
                            {removal.fileName || "Unknown file"}
                          </span>
                        </div>
                      ))}
                      {partner.manualFileRemovals.length > 3 && (
                        <p className="text-xs text-muted-foreground pl-2">
                          +{partner.manualFileRemovals.length - 3} more
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </CollapsibleListSection>

            {/* Categories (No-Receipt) */}
            {connectedCategories.length > 0 && (
              <CollapsibleListSection
                title="Categories"
                icon={<Tag className="h-4 w-4" />}
                count={connectedCategories.length}
                isLoading={isLoadingTransactions}
              >
                {connectedCategories.map((cat) => (
                  <div
                    key={cat.categoryId}
                    className="flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-muted/50"
                  >
                    <span className="text-sm truncate">{cat.name}</span>
                    <Badge variant="secondary" className="text-xs shrink-0 ml-2">
                      {cat.count} tx
                    </Badge>
                  </div>
                ))}
              </CollapsibleListSection>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Footer Actions */}
      <div className="p-4 border-t space-y-2">
        {feedback && (
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm",
              feedback.type === "success" &&
                "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
              feedback.type === "error" &&
                "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
              feedback.type === "info" &&
                "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
            )}
          >
            {feedback.type === "success" ? (
              <Check className="h-4 w-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}

        <Button
          variant={isMarkedAsMe ? "secondary" : "outline"}
          className="w-full"
          onClick={isMarkedAsMe ? handleUnmarkAsMe : handleMarkAsMe}
          disabled={isMarkingAsMe}
        >
          {isMarkingAsMe ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <UserCheck className="h-4 w-4 mr-2" />
          )}
          {isMarkedAsMe ? "Remove from my companies" : "This is my company"}
        </Button>

        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleDelete}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => setIsEditDialogOpen(true)}
          >
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </div>
      </div>

      <AddPartnerDialog
        open={isEditDialogOpen}
        onClose={() => setIsEditDialogOpen(false)}
        onAdd={handleEdit}
        initialData={{
          name: partner.name,
          aliases: partner.aliases,
          vatId: partner.vatId || "",
          ibans: partner.ibans,
          website: partner.website || "",
          address: partner.address,
          notes: partner.notes || "",
        }}
        mode="edit"
      />
    </div>
  );
}
