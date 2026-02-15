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
import { removeEmailPatternFromPartner } from "@/lib/operations";
import { useUserData } from "@/hooks/use-user-data";
import { useBrowserRecipes } from "@/hooks/use-browser-recipes";
import { BrowserAutomationsSection } from "./browser-automations-section";
import { RuleCard } from "./rule-card";
// Collapsible components used internally by CollapsibleListSection primitive
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FieldRow, SectionHeader, CollapsibleListSection, ListItem } from "@/components/ui/detail-panel-primitives";
import { useAuth } from "@/components/auth";
import { Bot, Hand, Sparkles, MousePointerClick, Settings, User, Building } from "lucide-react";
import { useNoReceiptCategories } from "@/hooks/use-no-receipt-categories";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
      className: "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700",
    },
    ai: {
      icon: <Bot className="h-3 w-3" />,
      label: "AI",
      className: "bg-purple-50 text-purple-900 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700",
    },
    auto: {
      icon: <Sparkles className="h-3 w-3" />,
      label: "Auto",
      className: "bg-blue-50 text-blue-900 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
    },
    suggestion: {
      icon: <MousePointerClick className="h-3 w-3" />,
      label: "Click",
      className: "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
    },
  };

  const config = configs[matchedBy];
  if (!config) return null;

  return (
    <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-medium", config.className)}>
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

interface ReceiptHintQuery {
  query: string;
  sourceType: "gmail" | "local" | "browser" | "unknown";
  resultType: string | null;
  usageCount: number;
  integrationId: string | null;
}

interface ReceiptHintsData {
  hasHints: boolean;
  preferredSource: "gmail" | "local" | "browser" | "unknown" | null;
  workingQueries: ReceiptHintQuery[];
  emailDomains: string[];
  filenameExamples: string[];
  successfulConnections: number;
  message: string;
}

const EMPTY_RECEIPT_HINTS: ReceiptHintsData = {
  hasHints: false,
  preferredSource: null,
  workingQueries: [],
  emailDomains: [],
  filenameExamples: [],
  successfulConnections: 0,
  message: "No receipt search history for this partner yet.",
};

function extractDomain(emailOrValue: unknown): string | null {
  if (typeof emailOrValue !== "string") return null;
  const value = emailOrValue.trim().toLowerCase();
  if (!value) return null;
  const atIndex = value.lastIndexOf("@");
  if (atIndex >= 0 && atIndex < value.length - 1) {
    return value.slice(atIndex + 1);
  }
  return value.includes(".") ? value : null;
}

function normalizeHintSourceType(raw: unknown): "gmail" | "local" | "browser" | "unknown" {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (value.startsWith("gmail")) return "gmail";
  if (value === "local" || value === "upload" || value === "local_file") return "local";
  if (value.startsWith("browser")) return "browser";
  return "unknown";
}

function sourceTypeLabel(sourceType: ReceiptHintsData["preferredSource"]): string {
  if (sourceType === "gmail") return "Gmail";
  if (sourceType === "local") return "Local files";
  if (sourceType === "browser") return "Browser";
  return "Unknown";
}

// NOTE: SectionHeader, CollapsibleListSection, and ListItem are now imported
// from @/components/ui/detail-panel-primitives for consistency across all panels

export function PartnerDetailPanel({
  partner,
  onClose,
}: PartnerDetailPanelProps) {
  const router = useRouter();
  const { userId } = useAuth();
  const { updatePartner, deletePartner } = usePartners();
  const { isPartnerMarkedAsMe, userData, save: saveUserData } = useUserData();
  const { categories: allCategories } = useNoReceiptCategories();
  const browserRecipesHook = useBrowserRecipes(partner.id);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isMarkingAsMe, setIsMarkingAsMe] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackMessage | null>(null);

  const isMarkedAsMe = isPartnerMarkedAsMe(partner.id);

  // Check if this partner is linked to identity settings
  const isIdentityLinked = !!partner.identitySourceField;
  const ctx = useMemo(() => ({ db, userId: userId ?? "" }), [userId]);
  const [receiptHints, setReceiptHints] = useState<ReceiptHintsData>(EMPTY_RECEIPT_HINTS);
  const [isLoadingReceiptHints, setIsLoadingReceiptHints] = useState(true);
  const gmailFilePatterns = useMemo(
    () => receiptHints.workingQueries.filter((pattern) => pattern.sourceType === "gmail"),
    [receiptHints.workingQueries]
  );

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

  // Build receipt hints from successful file-connection history for this partner.
  useEffect(() => {
    let cancelled = false;

    async function fetchReceiptHints() {
      if (!userId) {
        if (!cancelled) {
          setReceiptHints(EMPTY_RECEIPT_HINTS);
          setIsLoadingReceiptHints(false);
        }
        return;
      }

      setIsLoadingReceiptHints(true);

      try {
        const txSnapshot = await getDocs(query(
          collection(db, "transactions"),
          where("userId", "==", userId),
          where("partnerId", "==", partner.id),
          limit(200)
        ));

        const transactionIds = txSnapshot.docs.map((doc) => doc.id);
        const domainSet = new Set<string>((partner.emailDomains || []).map((d) => d.toLowerCase()));
        const filenameSet = new Set<string>();
        const sourceCounts = new Map<"gmail" | "local" | "browser" | "unknown", number>();
        const queryMap = new Map<string, ReceiptHintQuery & { lastSeenAtMs: number }>();
        let successfulConnections = 0;

        if (transactionIds.length > 0) {
          const connectionData: Array<{
            fileId?: string;
            userId?: string;
            sourceType?: string;
            searchPattern?: string;
            resultType?: string;
            gmailIntegrationId?: string;
            gmailMessageFrom?: string;
            createdAt?: { toMillis?: () => number };
          }> = [];

          for (let i = 0; i < transactionIds.length; i += 30) {
            const txBatch = transactionIds.slice(i, i + 30);
            if (txBatch.length === 0) continue;
            const connectionSnapshot = await getDocs(query(
              collection(db, "fileConnections"),
              where("transactionId", "in", txBatch)
            ));

            for (const doc of connectionSnapshot.docs) {
              const data = doc.data() as typeof connectionData[number];
              if (data.userId === userId) {
                connectionData.push(data);
              }
            }
          }

          successfulConnections = connectionData.length;

          const fileIds = Array.from(
            new Set(
              connectionData
                .map((c) => c.fileId)
                .filter((id): id is string => typeof id === "string" && id.length > 0)
            )
          );

          const fileMetaById = new Map<string, { fileName: string; sourceType: string | null }>();
          for (let i = 0; i < fileIds.length; i += 30) {
            const fileBatch = fileIds.slice(i, i + 30);
            if (fileBatch.length === 0) continue;
            const fileSnapshot = await getDocs(query(
              collection(db, "files"),
              where(documentId(), "in", fileBatch)
            ));

            for (const doc of fileSnapshot.docs) {
              const data = doc.data() as { userId?: string; fileName?: string; sourceType?: string };
              if (data.userId !== userId) continue;
              fileMetaById.set(doc.id, {
                fileName: data.fileName || "",
                sourceType: data.sourceType || null,
              });
            }
          }

          for (const connection of connectionData) {
            const fileMeta = connection.fileId ? fileMetaById.get(connection.fileId) : undefined;
            let sourceType = normalizeHintSourceType(connection.sourceType || connection.resultType);
            if (sourceType === "unknown" && fileMeta?.sourceType) {
              sourceType = normalizeHintSourceType(fileMeta.sourceType);
            }

            sourceCounts.set(sourceType, (sourceCounts.get(sourceType) || 0) + 1);

            const domain = extractDomain(connection.gmailMessageFrom);
            if (domain) domainSet.add(domain);

            if (fileMeta?.fileName) filenameSet.add(fileMeta.fileName);

            const searchPattern = typeof connection.searchPattern === "string"
              ? connection.searchPattern.trim()
              : "";
            if (!searchPattern) continue;

            const integrationId = connection.gmailIntegrationId || null;
            const resultType = connection.resultType || null;
            const key = `${sourceType}|${searchPattern.toLowerCase()}|${integrationId || ""}|${resultType || ""}`;
            const lastSeenAtMs = connection.createdAt?.toMillis?.() || 0;
            const existing = queryMap.get(key);

            if (existing) {
              existing.usageCount += 1;
              existing.lastSeenAtMs = Math.max(existing.lastSeenAtMs, lastSeenAtMs);
            } else {
              queryMap.set(key, {
                query: searchPattern,
                sourceType,
                resultType,
                usageCount: 1,
                integrationId,
                lastSeenAtMs,
              });
            }
          }
        }

        if (queryMap.size === 0) {
          const patternFallback = [...(partner.fileSourcePatterns || [])]
            .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
            .slice(0, 10);

          for (const pattern of patternFallback) {
            if (!pattern.pattern) continue;
            const sourceType = normalizeHintSourceType(pattern.sourceType);
            const resultType = pattern.resultType || null;
            const integrationId = pattern.integrationId || null;
            const key = `${sourceType}|${pattern.pattern.toLowerCase()}|${integrationId || ""}|${resultType || ""}`;
            queryMap.set(key, {
              query: pattern.pattern,
              sourceType,
              resultType,
              usageCount: pattern.usageCount || 0,
              integrationId,
              lastSeenAtMs: pattern.lastUsedAt?.toMillis?.() || 0,
            });
          }
        }

        if (filenameSet.size === 0) {
          for (const pattern of partner.fileSourcePatterns || []) {
            for (const fileName of pattern.filenameExamples || []) {
              filenameSet.add(fileName);
            }
          }
        }

        let preferredSource: ReceiptHintsData["preferredSource"] = null;
        if (sourceCounts.size > 0) {
          preferredSource = [...sourceCounts.entries()]
            .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        } else {
          preferredSource = queryMap.size > 0
            ? [...queryMap.values()].sort((a, b) => b.usageCount - a.usageCount)[0]?.sourceType || null
            : null;
        }

        const workingQueries = [...queryMap.values()]
          .sort((a, b) => {
            if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
            return b.lastSeenAtMs - a.lastSeenAtMs;
          })
          .slice(0, 5)
          .map(({ lastSeenAtMs: _lastSeenAtMs, ...queryData }) => queryData);

        const emailDomains = Array.from(domainSet).slice(0, 5);
        const filenameExamples = Array.from(filenameSet).slice(0, 5);
        const hasHints = workingQueries.length > 0 || emailDomains.length > 0 || filenameExamples.length > 0;

        const message = hasHints
          ? `Based on ${successfulConnections} successful file connection${successfulConnections === 1 ? "" : "s"} for this partner`
          : "No receipt search history for this partner yet.";

        if (!cancelled) {
          setReceiptHints({
            hasHints,
            preferredSource,
            workingQueries,
            emailDomains,
            filenameExamples,
            successfulConnections,
            message,
          });
        }
      } catch (error) {
        console.error("Failed to fetch receipt hints:", error);
        if (!cancelled) {
          setReceiptHints(EMPTY_RECEIPT_HINTS);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingReceiptHints(false);
        }
      }
    }

    fetchReceiptHints();
    return () => {
      cancelled = true;
    };
  }, [partner.id, partner.emailDomains, partner.fileSourcePatterns, userId]);

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

  /**
   * Set this partner as user's personal identity.
   * Updates the personalEntity with the partner's data.
   */
  const handleSetAsPersonalIdentity = async () => {
    setIsMarkingAsMe(true);
    setFeedback(null);
    try {
      // Build updated personal entity with partner data
      const personalEntity = {
        id: userData?.personalEntity?.id || `entity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: "person" as const,
        name: partner.name,
        aliases: partner.aliases || [],
        vatId: partner.vatId || userData?.personalEntity?.vatId || "",
        ibans: [...new Set([
          ...(partner.ibans || []),
          ...(userData?.personalEntity?.ibans || []),
        ])],
        partnerId: partner.id, // Link to this partner
      };

      await saveUserData({
        country: userData?.country,
        taxNumber: userData?.taxNumber,
        ownEmails: userData?.ownEmails,
        personalEntity,
        companies: userData?.companies?.map(c => ({
          ...c,
          type: "company" as const,
        })),
      });

      setFeedback({
        type: "success",
        text: `Set "${partner.name}" as your personal identity.`
      });
    } catch (error) {
      console.error("Failed to set as personal identity:", error);
      setFeedback({ type: "error", text: "Failed to update identity settings." });
    } finally {
      setIsMarkingAsMe(false);
    }
  };

  /**
   * Add this partner as a company to user's identity.
   * Creates a new company entity linked to this partner.
   */
  const handleAddAsCompany = async () => {
    setIsMarkingAsMe(true);
    setFeedback(null);
    try {
      // Create new company entity from partner data
      const newCompany = {
        id: `entity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: "company" as const,
        name: partner.name,
        aliases: partner.aliases || [],
        vatId: partner.vatId || "",
        ibans: partner.ibans || [],
        partnerId: partner.id, // Link to this partner
      };

      // Get existing companies or empty array
      const existingCompanies = (userData?.companies || []).map(c => ({
        ...c,
        type: "company" as const,
      }));

      await saveUserData({
        country: userData?.country,
        taxNumber: userData?.taxNumber,
        ownEmails: userData?.ownEmails,
        personalEntity: userData?.personalEntity ? {
          ...userData.personalEntity,
          type: "person" as const,
        } : undefined,
        companies: [...existingCompanies, newCompany],
      });

      setFeedback({
        type: "success",
        text: `Added "${partner.name}" as a company to your identity.`
      });
    } catch (error) {
      console.error("Failed to add as company:", error);
      setFeedback({ type: "error", text: "Failed to update identity settings." });
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
    partner.categoryMatchRules?.length ||
    partner.aliases.some((a) => a.includes("*")) ||
    partner.emailDomains?.length ||
    gmailFilePatterns.length > 0;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold truncate">{partner.name}</h2>
            {isIdentityLinked ? (
              <span className="text-xs text-primary flex items-center gap-1">
                <Settings className="h-3 w-3" />
                From Identity ({
                  partner.identitySourceField === "personalEntity" || partner.identitySourceField === "name"
                    ? "Personal"
                    : "Company"
                })
              </span>
            ) : isMarkedAsMe ? (
              <span className="text-xs text-primary">My Company</span>
            ) : partner.globalPartnerId ? (
              <span className="text-xs text-muted-foreground">
                Global Partner
              </span>
            ) : null}
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
                          className="text-xs bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 rounded font-mono"
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
                    <code className="text-xs bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 rounded font-mono">
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
                            className="text-xs bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 rounded font-mono"
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
                    <div className="space-y-2">
                      {partner.learnedPatterns.slice(0, 3).map((pattern, idx) => (
                        <div key={idx} className="space-y-1">
                          <div className="flex items-center gap-2">
                            <code className="text-xs bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 rounded font-mono flex-1 truncate">
                              {pattern.pattern}
                            </code>
                            <Badge variant="outline" className="text-[10px]">
                              {pattern.confidence}%
                            </Badge>
                          </div>
                          {pattern.excludePatterns && pattern.excludePatterns.length > 0 && (
                            <div className="flex flex-wrap gap-1 pl-2">
                              {pattern.excludePatterns.map((excludePattern, exIdx) => (
                                <code
                                  key={exIdx}
                                  className="text-xs bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded font-mono line-through"
                                >
                                  {excludePattern}
                                </code>
                              ))}
                            </div>
                          )}
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

                {/* Category Match Rules */}
                {partner.categoryMatchRules && partner.categoryMatchRules.length > 0 && (
                  partner.categoryMatchRules.map((rule, idx) => {
                    const category = allCategories.find((c) => c.id === rule.categoryId);
                    const categoryName = category?.name || "Unknown Category";
                    return (
                      <RuleCard
                        key={idx}
                        icon={<Tag className="h-4 w-4" />}
                        title={categoryName}
                        confidence={rule.confidence}
                        variant="learned"
                      >
                        <div className="flex flex-wrap gap-1">
                          {rule.patterns.map((pattern, pIdx) => (
                            <code
                              key={pIdx}
                              className="text-xs bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 rounded font-mono"
                            >
                              {pattern}
                            </code>
                          ))}
                          {rule.excludePatterns && rule.excludePatterns.map((pattern, pIdx) => (
                            <code
                              key={`ex-${pIdx}`}
                              className="text-xs bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded font-mono line-through"
                            >
                              {pattern}
                            </code>
                          ))}
                        </div>
                      </RuleCard>
                    );
                  })
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
                          className="text-xs bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 rounded font-mono"
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
                          <code className="text-xs bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 rounded font-mono flex-1 truncate">
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

          {/* Browser Automations Section */}
          <div className="space-y-3">
            <SectionHeader>Browser Automations</SectionHeader>
            <BrowserAutomationsSection
              partner={partner}
              onAddBookmark={browserRecipesHook.addBookmark}
              onDeleteRecipe={browserRecipesHook.deleteRecipe}
              onToggleStatus={browserRecipesHook.toggleStatus}
              onToggleAutoRun={browserRecipesHook.toggleAutoRun}
              onPromoteLink={browserRecipesHook.promoteLink}
              onInferFrequency={browserRecipesHook.inferFrequency}
              isLoading={browserRecipesHook.isLoading}
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
                        subtitle={tx.date?.toDate ? format(tx.date.toDate(), "MMM d, yyyy") : ""}
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
                {connectedCategories.map((cat) => {
                  // Get transactions for this category
                  const categoryTransactions = transactions.filter(
                    (tx) => tx.noReceiptCategoryId === cat.categoryId
                  );
                  // Get rejected transactions for this category
                  const categoryRejections = (partner.categoryManualRemovals || [])
                    .filter((r) => r.categoryId === cat.categoryId);

                  return (
                    <div key={cat.categoryId} className="space-y-1">
                      {/* Category header */}
                      <div className="flex items-center justify-between py-1.5 px-2 -mx-2">
                        <span className="text-sm font-medium truncate">{cat.name}</span>
                        <Badge variant="secondary" className="text-xs shrink-0 ml-2">
                          {cat.count} tx
                        </Badge>
                      </div>
                      {/* Category transactions */}
                      {categoryTransactions.slice(0, 5).map((tx) => (
                        <ListItem
                          key={tx.id}
                          href={`/transactions?id=${tx.id}`}
                          title={tx.name}
                          subtitle={tx.date?.toDate ? format(tx.date.toDate(), "MMM d, yyyy") : ""}
                          amount={tx.amount}
                          currency={tx.currency}
                          isNegative={tx.amount < 0}
                          badge={<MatchSourceBadge matchedBy={tx.noReceiptCategoryMatchedBy} />}
                        />
                      ))}
                      {categoryTransactions.length > 5 && (
                        <p className="text-xs text-muted-foreground pl-2">
                          +{categoryTransactions.length - 5} more
                        </p>
                      )}
                      {/* Rejected transactions */}
                      {categoryRejections.length > 0 && (
                        <div className="pt-1 border-t mt-1">
                          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1 px-2">
                            <Ban className="h-3 w-3" />
                            Rejected ({categoryRejections.length})
                          </p>
                          {categoryRejections.slice(0, 3).map((removal) => (
                            <div
                              key={removal.transactionId}
                              className="flex items-center gap-2 py-1.5 px-2 text-muted-foreground line-through opacity-60"
                            >
                              <span className="text-sm truncate flex-1">
                                {removal.name || removal.partner || "Unknown"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
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

        {isIdentityLinked ? (
          // Identity-linked partner: show "Edit in Identity" button only
          <Button
            variant="outline"
            className="w-full"
            onClick={() => router.push("/settings/identity")}
          >
            <Settings className="h-4 w-4 mr-2" />
            Edit in Identity
          </Button>
        ) : (
          // Regular partner: show normal buttons
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={isMarkingAsMe}
                >
                  {isMarkingAsMe ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <UserCheck className="h-4 w-4 mr-2" />
                  )}
                  This is me
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-56">
                <DropdownMenuItem onClick={handleSetAsPersonalIdentity}>
                  <User className="h-4 w-4 mr-2" />
                  Set as my personal name
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleAddAsCompany}>
                  <Building className="h-4 w-4 mr-2" />
                  Add as my company
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

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
          </>
        )}
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
