"use client";

/**
 * ## The filter row filters this table. Nothing else belongs in it
 *
 * Everything to the left of the counter narrows the rows below it: search, the
 * date range, status, type, partner. That is the contract a user learns in the
 * first minute, and it is what makes the row safe to click through.
 *
 * A control that navigates somewhere else breaks it: it reads as a filter that
 * does not filter. Account-level summary lives beside the score ring instead.
 *
 * So: narrowing the table goes left. Saying something about the whole account,
 * or leaving for another surface, goes right, next to the ring.
 */

import { useState, useRef, useEffect, memo } from "react";
import { Badge } from "@/components/ui/badge";
import { CircleCheck, ArrowUpDown, X } from "lucide-react";
import { SearchButton } from "@/components/ui/search-button";
import { TransactionFilters } from "@/types/transaction";
import { useTranslations } from "next-intl";
import { ProgressCounter } from "@/components/ui/progress-counter";
import { ChoiceFilter } from "@/components/ui/choice-filter";
import { DateRangeFilter } from "@/components/ui/date-range-filter";
import { OverflowFilterRow } from "@/components/ui/overflow-filter-row";
import { PartnerFilter } from "@/components/partners/partner-filter";
import { cn, formatCurrency } from "@/lib/utils";
import { MOTION } from "@/design-system";
import { UserPartner } from "@/types/partner";

interface TransactionToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters: TransactionFilters;
  onFiltersChange: (filters: TransactionFilters) => void;
  importFileName?: string;
  userPartners?: UserPartner[];
  /** Number of transactions with file or no-receipt category assigned */
  assignedCount?: number;
  /** Total number of transactions in current filter view */
  totalCount?: number;
  /** Sum of amounts for filtered transactions (in cents) */
  filteredSum?: number;
  /** Share of the filtered rows documented by a § 11 invoice, i.e. deductible. */
  deductiblePercent?: number;
}

function TransactionToolbarInner({
  searchValue,
  onSearchChange,
  filters,
  onFiltersChange,
  importFileName,
  userPartners = [],
  assignedCount,
  totalCount,
  filteredSum,
  deductiblePercent,
}: TransactionToolbarProps) {
  const tProgress = useTranslations("progress");
  const tFilters = useTranslations("filters");

  // Counter bump animation when assignedCount changes
  const prevAssignedRef = useRef(assignedCount);
  const [counterBumping, setCounterBumping] = useState(false);
  useEffect(() => {
    if (assignedCount !== undefined && prevAssignedRef.current !== undefined &&
        assignedCount !== prevAssignedRef.current) {
      queueMicrotask(() => setCounterBumping(true));
      const timer = setTimeout(() => setCounterBumping(false), MOTION.COUNTER_BUMP_DURATION_MS);
      prevAssignedRef.current = assignedCount;
      return () => clearTimeout(timer);
    }
    prevAssignedRef.current = assignedCount;
  }, [assignedCount]);

  const hasDateFilter = filters.dateFrom || filters.dateTo;
  const hasAmountFilter = filters.amountType && filters.amountType !== "all";



  const clearImportFilter = () => {
    onFiltersChange({ ...filters, importId: undefined });
  };










  // Show counter only when there are transactions
  const showCounter = totalCount !== undefined && totalCount > 0;

  return (
    <div className="grid grid-cols-[1fr_minmax(0,auto)] gap-2 px-4 py-2 border-b bg-background items-center">
      {/* Filters: one line, in column order; what does not fit goes behind
          More (#522). Search and a deep-linked import always stay. */}
      <OverflowFilterRow
        moreLabel={tFilters("more")}
        panelTitle={tFilters("panelTitle")}
        clearLabel={tFilters("clearAll")}
        onClearAll={() =>
          onFiltersChange({
            ...filters,
            dateFrom: undefined,
            dateTo: undefined,
            amountType: undefined,
            partnerIds: undefined,
            partnerId: undefined,
            hasPartner: undefined,
            isComplete: undefined,
            documentationStates: undefined,
          })
        }
        leading={
          <div className="flex items-center gap-2">
            <SearchButton
              value={searchValue}
              onSearch={onSearchChange}
              placeholder="Search transactions..."
            />
        {/* Import filter badge (if active) */}
        {filters.importId && (
          <Badge variant="secondary" className="gap-1 h-8">
            Import: {importFileName || "Selected"}
            <span
              role="button"
              tabIndex={0}
              onClick={clearImportFilter}
              onKeyDown={(e) => e.key === "Enter" && clearImportFilter()}
              className="ml-1 hover:bg-muted rounded cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          </Badge>
        )}
          </div>
        }
        items={[
          {
            key: "date",
            active: Boolean(hasDateFilter),
            node: (
              <>
      <DateRangeFilter
        from={filters.dateFrom}
        to={filters.dateTo}
        onChange={(dateFrom, dateTo) => onFiltersChange({ ...filters, dateFrom, dateTo })}
      />
              </>
            ),
          },
          {
            key: "type",
            active: Boolean(hasAmountFilter),
            node: (
              <>
      <ChoiceFilter
        label={tFilters("type.label")}
        icon={<ArrowUpDown className="h-4 w-4" />}
        allLabel={tFilters("all")}
        value={filters.amountType && filters.amountType !== "all" ? filters.amountType : undefined}
        onChange={(amountType) => onFiltersChange({ ...filters, amountType })}
        options={[
          { value: "income", label: tFilters("type.income") },
          { value: "expense", label: tFilters("type.expense") },
        ]}
      />
              </>
            ),
          },
          {
            key: "partner",
            active: Boolean(filters.partnerIds?.length) || filters.hasPartner !== undefined,
            node: (
              <>
      <PartnerFilter
        userPartners={userPartners}
        partnerIds={filters.partnerIds}
        hasPartner={filters.hasPartner}
        onChange={(next) => onFiltersChange({ ...filters, ...next })}
      />
              </>
            ),
          },
          {
            key: "files",
            active: filters.isComplete !== undefined,
            node: (
              <>
      {/* Files: the File column, assigned = a File or a no-receipt category (#519) */}
      <ChoiceFilter
        label={tFilters("files.label")}
        icon={<CircleCheck className="h-4 w-4" />}
        allLabel={tFilters("all")}
        value={
          filters.isComplete === true
            ? "assigned"
            : filters.isComplete === false
              ? "unassigned"
              : undefined
        }
        onChange={(value) =>
          onFiltersChange({
            ...filters,
            isComplete: value === undefined ? undefined : value === "assigned",
          })
        }
        options={[
          { value: "assigned", label: tFilters("assigned") },
          { value: "unassigned", label: tFilters("unassigned") },
        ]}
      />
              </>
            ),
          },
        ]}
      />

      {/* Counter and sum - always stacked vertically */}
      {showCounter && (
        <div className="flex flex-col items-end justify-center text-xs leading-4">
          <ProgressCounter
            done={assignedCount ?? 0}
            total={totalCount ?? 0}
            bump={counterBumping}
            explanation={
              <div className="space-y-1.5">
                <p>
                  {tProgress("transactions", {
                    done: assignedCount ?? 0,
                    total: totalCount ?? 0,
                  })}
                </p>
                {deductiblePercent !== undefined && (
                  <p className="text-muted-foreground">
                    {tProgress("transactionsDeductible", { percent: deductiblePercent })}
                  </p>
                )}
                <p className="text-muted-foreground">{tProgress("followsFilters")}</p>
              </div>
            }
          />
          {filteredSum !== undefined && (
            <span
              className={cn(
                "tabular-nums",
                filteredSum < 0 ? "text-amount-negative" : "text-amount-positive"
              )}
            >
              ({formatCurrency(filteredSum)})
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Memoised: it sits in the table, which re-renders on every row selection,
 * and nothing it shows depends on which row is selected.
 */
export const TransactionToolbar = memo(TransactionToolbarInner);
