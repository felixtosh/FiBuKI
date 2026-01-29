"use client";

import { useState, useEffect } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { PanelHeader, SectionHeader } from "@/components/ui/detail-panel-primitives";
import {
  Tag,
  Receipt,
  ChevronRight,
  Building2,
  X,
} from "lucide-react";
import { UserNoReceiptCategory } from "@/types/no-receipt-category";
import { Transaction } from "@/types/transaction";
import { useNoReceiptCategories } from "@/hooks/use-no-receipt-categories";
import { usePartners } from "@/hooks/use-partners";
import { collection, query, where, orderBy, limit, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import Link from "next/link";
import { useAuth } from "@/components/auth";

interface CategoryDetailPanelProps {
  category: UserNoReceiptCategory;
  onClose: () => void;
}

export function CategoryDetailPanel({ category, onClose }: CategoryDetailPanelProps) {
  const { userId } = useAuth();
  const { updateCategory } = useNoReceiptCategories();
  const { partners: allPartners } = usePartners();
  const [manualTransactions, setManualTransactions] = useState<Transaction[]>([]);
  const [autoTransactions, setAutoTransactions] = useState<Transaction[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(true);

  // Get partner details for matched partners
  const matchedPartners = allPartners.filter((p) =>
    category.matchedPartnerIds.includes(p.id)
  );

  // Fetch connected transactions, separated by match type
  useEffect(() => {
    async function fetchTransactions() {
      setIsLoadingTransactions(true);
      try {
        const q = query(
          collection(db, "transactions"),
          where("userId", "==", userId),
          where("noReceiptCategoryId", "==", category.id),
          orderBy("date", "desc"),
          limit(50)
        );
        const snapshot = await getDocs(q);
        const txs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Transaction[];

        // Separate manual vs auto/suggestion connections
        const manual = txs.filter(tx => tx.noReceiptCategoryMatchedBy === "manual");
        const auto = txs.filter(tx => tx.noReceiptCategoryMatchedBy !== "manual");

        setManualTransactions(manual.slice(0, 10));
        setAutoTransactions(auto.slice(0, 10));
        setTotalCount(txs.length);
      } catch (error) {
        console.error("Failed to fetch transactions:", error);
      } finally {
        setIsLoadingTransactions(false);
      }
    }
    fetchTransactions();
  }, [category.id, userId]);

  const handleRemovePartner = async (partnerId: string) => {
    const updatedPartnerIds = category.matchedPartnerIds.filter(
      (id) => id !== partnerId
    );
    await updateCategory(category.id, {
      matchedPartnerIds: updatedPartnerIds,
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <PanelHeader
        title={category.name}
        icon={<Tag className="h-5 w-5 text-muted-foreground" />}
        onClose={onClose}
      />

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Description */}
        <div>
          <SectionHeader className="mb-2">Description</SectionHeader>
          <p className="text-sm">{category.description}</p>
          <p className="text-sm text-muted-foreground mt-1">{category.helperText}</p>
        </div>

        {/* Matched Partners */}
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            <Building2 className="h-3 w-3 inline mr-1" />
            Matched Partners ({matchedPartners.length})
          </h3>
          {matchedPartners.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No partners linked yet. Partners are automatically linked when you assign their transactions to this category.
            </p>
          ) : (
            <div className="space-y-1">
              {matchedPartners.map((partner) => (
                <div
                  key={partner.id}
                  className="flex items-center justify-between gap-2 p-2 -mx-2 rounded hover:bg-muted/50 transition-colors group"
                >
                  <Link
                    href={`/partners?id=${partner.id}`}
                    className="flex items-center gap-2 min-w-0 flex-1"
                  >
                    <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-sm truncate">{partner.name}</span>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleRemovePartner(partner.id)}
                  >
                    <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Connected Transactions */}
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            <Receipt className="h-3 w-3 inline mr-1" />
            Connected Transactions
            {!isLoadingTransactions && (
              <span className="ml-1 text-foreground">({totalCount})</span>
            )}
          </h3>
          {isLoadingTransactions ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : manualTransactions.length === 0 && autoTransactions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transactions connected yet</p>
          ) : (
            <div className="space-y-1">
              {/* Manual connections */}
              {manualTransactions.length > 0 && (
                <>
                  <p className="text-xs text-muted-foreground font-medium mt-2 mb-1">
                    Manually connected ({manualTransactions.length})
                  </p>
                  {manualTransactions.map((tx) => (
                    <Link
                      key={tx.id}
                      href={`/transactions?id=${tx.id}`}
                      className="flex items-center justify-between gap-2 p-2 -mx-2 rounded hover:bg-muted/50 transition-colors group"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{tx.partner || tx.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {tx.date?.toDate ? format(tx.date.toDate(), "MMM d, yyyy") : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`text-sm font-medium tabular-nums ${
                            tx.amount < 0 ? "text-amount-negative" : "text-amount-positive"
                          }`}
                        >
                          {new Intl.NumberFormat("de-DE", {
                            style: "currency",
                            currency: tx.currency || "EUR",
                          }).format(tx.amount / 100)}
                        </span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </Link>
                  ))}
                </>
              )}

              {/* Auto-matched connections */}
              {autoTransactions.length > 0 && (
                <>
                  <p className="text-xs text-muted-foreground font-medium mt-3 mb-1 pt-2 border-t">
                    Auto-matched ({autoTransactions.length})
                  </p>
                  {autoTransactions.map((tx) => (
                    <Link
                      key={tx.id}
                      href={`/transactions?id=${tx.id}`}
                      className="flex items-center justify-between gap-2 p-2 -mx-2 rounded hover:bg-muted/50 transition-colors group"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{tx.partner || tx.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {tx.date?.toDate ? format(tx.date.toDate(), "MMM d, yyyy") : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`text-sm font-medium tabular-nums ${
                            tx.amount < 0 ? "text-amount-negative" : "text-amount-positive"
                          }`}
                        >
                          {new Intl.NumberFormat("de-DE", {
                            style: "currency",
                            currency: tx.currency || "EUR",
                          }).format(tx.amount / 100)}
                        </span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </Link>
                  ))}
                </>
              )}

              {totalCount > 20 && (
                <Link
                  href={`/transactions?categoryId=${category.id}`}
                  className="text-xs text-primary hover:underline block mt-2"
                >
                  View all {totalCount} transactions
                </Link>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
