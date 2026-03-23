"use client";

import { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TableEmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  /** Primary action button */
  action?: {
    label: string;
    onClick: () => void;
    icon?: ReactNode;
    /** Data attributes for the button (e.g., for onboarding) */
    dataAttributes?: Record<string, string>;
  };
  /** Secondary/alternative action */
  secondaryAction?: {
    label: string;
    onClick: () => void;
    icon?: ReactNode;
    /** Data attributes for the button (e.g., for onboarding) */
    dataAttributes?: Record<string, string>;
  };
  /** Additional content below the actions */
  footer?: ReactNode;
  className?: string;
  /** Size variant */
  size?: "sm" | "default" | "lg";
}

/**
 * Animated empty state for tables and lists.
 * Features subtle animations and clear CTAs.
 */
export function TableEmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  footer,
  className,
  size = "default",
}: TableEmptyStateProps) {
  const sizeStyles = {
    sm: {
      container: "py-8",
      icon: "h-10 w-10",
      title: "text-sm",
      description: "text-xs",
    },
    default: {
      container: "py-12",
      icon: "h-12 w-12",
      title: "text-base",
      description: "text-sm",
    },
    lg: {
      container: "py-16",
      icon: "h-16 w-16",
      title: "text-lg",
      description: "text-sm",
    },
  };

  const styles = sizeStyles[size];

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center animate-in fade-in-0 duration-500",
        styles.container,
        className
      )}
    >
      {/* Animated icon container */}
      <div className="relative mb-4">
        {/* Subtle pulse ring behind icon */}
        <div className="absolute inset-0 rounded-full bg-muted/50 animate-pulse" />

        {/* Icon with float animation */}
        <div
          className={cn(
            "relative text-muted-foreground animate-in zoom-in-50 duration-500 animate-float-medium",
            styles.icon
          )}
        >
          {icon}
        </div>
      </div>

      {/* Title */}
      <h3
        className={cn(
          "font-medium text-foreground mb-1.5 animate-in slide-in-from-bottom-2 duration-500 delay-100",
          styles.title
        )}
      >
        {title}
      </h3>

      {/* Description */}
      {description && (
        <p
          className={cn(
            "text-muted-foreground max-w-sm mx-auto mb-5 animate-in slide-in-from-bottom-2 duration-500 delay-150",
            styles.description
          )}
        >
          {description}
        </p>
      )}

      {/* Actions */}
      {(action || secondaryAction) && (
        <div className="flex items-center gap-3 animate-in slide-in-from-bottom-2 duration-500 delay-200">
          {action && (
            <Button
              onClick={action.onClick}
              size={size === "sm" ? "sm" : "default"}
              {...(action.dataAttributes ? Object.fromEntries(
                Object.entries(action.dataAttributes).map(([k, v]) => [`data-${k}`, v])
              ) : {})}
            >
              {action.icon && <span className="mr-2">{action.icon}</span>}
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button
              variant="outline"
              onClick={secondaryAction.onClick}
              size={size === "sm" ? "sm" : "default"}
              {...(secondaryAction.dataAttributes ? Object.fromEntries(
                Object.entries(secondaryAction.dataAttributes).map(([k, v]) => [`data-${k}`, v])
              ) : {})}
            >
              {secondaryAction.icon && <span className="mr-2">{secondaryAction.icon}</span>}
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}

      {/* Footer */}
      {footer && (
        <div className="mt-4 text-xs text-muted-foreground animate-in fade-in duration-500 delay-300">
          {footer}
        </div>
      )}

    </div>
  );
}

/**
 * Preset empty states for common scenarios.
 * Each preset includes title, description, and optional actionLabel/actionHref for CTAs.
 */
export const emptyStatePresets = {
  transactions: {
    noData: {
      title: "No transactions yet",
      description: "Connect a bank account to import transactions and start matching receipts.",
      actionLabel: "Add Account",
      actionHref: "/sources",
    },
    noResults: {
      title: "No transactions match your filters",
      description: "Try adjusting your search or filter criteria.",
      actionLabel: "Clear Filters",
    },
  },
  files: {
    noData: {
      title: "No files uploaded",
      description: "Upload invoices and receipts, or connect your email to automatically import them.",
      actionLabel: "Upload Files",
    },
    noResults: {
      title: "No files match your search",
      description: "Try different keywords or adjust your filters.",
      actionLabel: "Clear Filters",
    },
  },
  partners: {
    noData: {
      title: "No partners yet",
      description: "Partners are automatically created when you match transactions. You can also add them manually.",
      actionLabel: "Add Partner",
    },
    noResults: {
      title: "No partners found",
      description: "Try a different search term.",
      actionLabel: "Clear Search",
    },
  },
  categories: {
    noData: {
      title: "No categories set up",
      description: "Categories help you organize transactions that don't require receipts.",
    },
    noResults: {
      title: "No categories match your filters",
      description: "Try adjusting your filter criteria.",
      actionLabel: "Clear Filters",
    },
  },
};
