"use client";

import { ReactNode, useState } from "react";
import {
  ChevronUp,
  ChevronDown,
  X,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// ============================================================================
// PANEL HEADER
// ============================================================================

interface PanelHeaderProps {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  children?: ReactNode;
}

/**
 * Consistent panel header with optional navigation arrows and close button.
 * Used across all detail panels (Transaction, File, Partner, Category).
 */
export function PanelHeader({
  title,
  icon,
  onClose,
  onNavigatePrevious,
  onNavigateNext,
  hasPrevious = false,
  hasNext = false,
  children,
}: PanelHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2 h-[53px] border-b px-4">
      <h2 className="text-lg font-semibold flex items-center gap-2 min-w-0 flex-1">
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="truncate">{title}</span>
      </h2>
      <div className="flex items-center gap-1 shrink-0">
        {children}
        {onNavigatePrevious && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onNavigatePrevious}
            disabled={!hasPrevious}
            className="h-8 w-8"
          >
            <ChevronUp className="h-4 w-4" />
            <span className="sr-only">Previous</span>
          </Button>
        )}
        {onNavigateNext && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onNavigateNext}
            disabled={!hasNext}
            className="h-8 w-8"
          >
            <ChevronDown className="h-4 w-4" />
            <span className="sr-only">Next</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-8 w-8"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// FIELD ROW
// ============================================================================

interface FieldRowProps {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Width of the label column (default: w-24) */
  labelWidth?: string;
}

/**
 * Consistent field row layout - left label, right value.
 * Provides uniform styling for field displays across detail panels.
 */
export function FieldRow({
  label,
  icon,
  children,
  className,
  labelWidth = "w-24",
}: FieldRowProps) {
  return (
    <div className={cn("flex items-baseline gap-3 py-1.5", className)}>
      <span
        className={cn(
          "text-sm text-muted-foreground shrink-0 flex items-center gap-1.5",
          labelWidth
        )}
      >
        {icon}
        {label}
      </span>
      <span className="text-sm flex-1 min-w-0">{children}</span>
    </div>
  );
}

// ============================================================================
// SECTION HEADER
// ============================================================================

interface SectionHeaderProps {
  children: ReactNode;
  className?: string;
}

/**
 * Section header with consistent uppercase styling.
 */
export function SectionHeader({ children, className }: SectionHeaderProps) {
  return (
    <h3
      className={cn(
        "text-xs font-semibold text-muted-foreground uppercase tracking-wider",
        className
      )}
    >
      {children}
    </h3>
  );
}

// ============================================================================
// COLLAPSIBLE LIST SECTION
// ============================================================================

interface CollapsibleListSectionProps {
  title: string;
  icon: ReactNode;
  count: number;
  isLoading?: boolean;
  children: ReactNode;
  defaultOpen?: boolean;
  viewAllLink?: string;
  viewAllLabel?: string;
  /** Custom badge variant */
  badgeVariant?: "default" | "secondary" | "destructive" | "outline";
}

/**
 * Collapsible section for lists of items (transactions, files, etc).
 * Features:
 * - Animated expand/collapse
 * - Item count badge
 * - Loading state
 * - Optional "View all" link
 */
export function CollapsibleListSection({
  title,
  icon,
  count,
  isLoading = false,
  children,
  defaultOpen = false,
  viewAllLink,
  viewAllLabel,
  badgeVariant = "secondary",
}: CollapsibleListSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center justify-between w-full py-2 px-3 -mx-3 rounded-lg hover:bg-muted/50 transition-colors group">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{icon}</span>
            <span className="text-sm font-medium">{title}</span>
            <Badge variant={badgeVariant} className="text-xs">
              {isLoading ? "..." : count}
            </Badge>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              isOpen && "rotate-180"
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="animate-in slide-in-from-top-2 duration-200">
        <div className="pt-2 space-y-1">
          {children}
          {viewAllLink && count > 5 && (
            <Link
              href={viewAllLink}
              className="text-xs text-primary hover:underline block pt-2"
            >
              {viewAllLabel || `View all ${count}`}
            </Link>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// LIST ITEM
// ============================================================================

interface ListItemProps {
  href?: string;
  onClick?: () => void;
  title: string;
  subtitle?: string;
  /** Amount to display (formatted with currency if provided) */
  amount?: number;
  currency?: string;
  /** Whether amount is negative (shows red) or positive (shows green) */
  isNegative?: boolean;
  badge?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/**
 * List item for transactions, files, or other clickable items.
 * Supports either link-based or click-based navigation.
 */
export function ListItem({
  href,
  onClick,
  title,
  subtitle,
  amount,
  currency = "EUR",
  isNegative,
  badge,
  icon,
  className,
}: ListItemProps) {
  const formattedAmount =
    amount !== undefined
      ? new Intl.NumberFormat("de-DE", {
          style: "currency",
          currency,
        }).format(Math.abs(amount) / 100)
      : null;

  const content = (
    <div
      className={cn(
        "flex items-center gap-3 py-2 px-3 -mx-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer",
        className
      )}
      onClick={onClick}
    >
      {icon && <span className="text-muted-foreground shrink-0">{icon}</span>}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{title}</p>
        {subtitle && (
          <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
        )}
      </div>
      {badge}
      {formattedAmount && (
        <span
          className={cn(
            "text-sm font-medium tabular-nums",
            isNegative ? "text-amount-negative" : "text-amount-positive"
          )}
        >
          {isNegative ? "-" : "+"}
          {formattedAmount}
        </span>
      )}
    </div>
  );

  if (href) {
    return <Link href={href}>{content}</Link>;
  }

  return content;
}

// ============================================================================
// PANEL FOOTER
// ============================================================================

interface PanelFooterProps {
  children: ReactNode;
  className?: string;
}

/**
 * Footer section for detail panels, typically containing action buttons.
 */
export function PanelFooter({ children, className }: PanelFooterProps) {
  return (
    <div className={cn("border-t px-4 py-2 bg-background", className)}>
      {children}
    </div>
  );
}

// ============================================================================
// PANEL CONTAINER
// ============================================================================

interface PanelContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * Full-height panel container with proper overflow handling.
 */
export function PanelContainer({ children, className }: PanelContainerProps) {
  return (
    <div
      className={cn(
        "h-full flex flex-col bg-background overflow-hidden",
        className
      )}
    >
      {children}
    </div>
  );
}

// ============================================================================
// PANEL CONTENT
// ============================================================================

interface PanelContentProps {
  children: ReactNode;
  className?: string;
}

/**
 * Scrollable content area for detail panels.
 */
export function PanelContent({ children, className }: PanelContentProps) {
  return (
    <ScrollArea className="flex-1">
      <div className={cn("px-4 py-6 space-y-4", className)}>{children}</div>
    </ScrollArea>
  );
}

// ============================================================================
// EMPTY STATE
// ============================================================================

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/**
 * Empty state display for when there's no data.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("py-8 text-center", className)}>
      <div className="mx-auto text-muted-foreground mb-4">{icon}</div>
      <h3 className="text-sm font-medium mb-1">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground mb-4">{description}</p>
      )}
      {action}
    </div>
  );
}

// ============================================================================
// SECTION DIVIDER
// ============================================================================

interface SectionDividerProps {
  className?: string;
}

/**
 * Visual divider between panel sections.
 */
export function SectionDivider({ className }: SectionDividerProps) {
  return <div className={cn("border-t pt-3 mt-3 -mx-4 px-4", className)} />;
}

// ============================================================================
// FILE LIST ITEM
// ============================================================================

interface FileListItemProps {
  /** Link destination for the file */
  href?: string;
  /** Click handler (alternative to href) */
  onClick?: () => void;
  /** File name */
  fileName: string;
  /** Date to display (formatted string) */
  date?: string;
  /** Amount in cents */
  amount?: number | null;
  /** Currency code */
  currency?: string;
  /** Whether this item is being removed/disconnected */
  isRemoving?: boolean;
  /** Handler for remove/disconnect action */
  onRemove?: () => void;
  /** Whether extraction is in progress (shows spinner) */
  isExtracting?: boolean;
  /** Custom className */
  className?: string;
}

/**
 * File list item with consistent styling for file displays.
 * Features:
 * - Truncated file name
 * - Date subtitle
 * - Amount display (when extracted)
 * - Remove action button (hover reveal)
 * - Extraction loading state
 * - Arrow navigation indicator
 */
export function FileListItem({
  href,
  onClick,
  fileName,
  date,
  amount,
  currency = "EUR",
  isRemoving = false,
  onRemove,
  isExtracting = false,
  className,
}: FileListItemProps) {
  const formattedAmount =
    amount != null
      ? new Intl.NumberFormat("de-DE", {
          style: "currency",
          currency,
        }).format(amount / 100)
      : null;

  const content = (
    <div
      className={cn(
        "flex items-center justify-between gap-2 p-2 -mx-2 rounded hover:bg-muted/50 transition-colors group overflow-hidden",
        className
      )}
      onClick={href ? undefined : onClick}
    >
      <div className="min-w-0 flex-1 overflow-hidden w-0">
        <p className="text-sm truncate">{fileName}</p>
        {date && <p className="text-xs text-muted-foreground">{date}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isExtracting ? (
          <span className="h-4 w-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
        ) : (
          formattedAmount && (
            <span className="text-sm font-medium tabular-nums text-foreground">
              {formattedAmount}
            </span>
          )
        )}
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }}
            disabled={isRemoving}
            className="p-1 rounded hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            {isRemoving ? (
              <span className="h-4 w-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin block" />
            ) : (
              <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
            )}
          </button>
        )}
        <svg
          className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </div>
  );

  if (href) {
    return <Link href={href}>{content}</Link>;
  }

  return content;
}
