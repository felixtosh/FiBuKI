"use client";

import { useEffect, ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ContentOverlayProps {
  /** Whether the overlay is open */
  open: boolean;
  /** Called when the overlay should close */
  onClose: () => void;
  /** Title shown in the header */
  title?: string;
  /** Subtitle shown below title */
  subtitle?: ReactNode;
  /** Content to render in the overlay */
  children: ReactNode;
  /** Additional header actions (rendered to the right of close button) */
  headerActions?: ReactNode;
  /** Additional class name for the overlay container */
  className?: string;
  /** Whether to show the backdrop (default: true) */
  showBackdrop?: boolean;
}

/**
 * A reusable overlay component that appears over the main content area.
 * Used for file viewers, connect dialogs, etc.
 *
 * Should be placed inside a relative-positioned container.
 * Has a minimum width of 600px to prevent content from being squished.
 */
export function ContentOverlay({
  open,
  onClose,
  title,
  subtitle,
  children,
  headerActions,
  className,
  showBackdrop = true,
}: ContentOverlayProps) {
  // Handle escape key
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center">
      {/* Backdrop */}
      {showBackdrop && (
        <div
          className="absolute inset-0 bg-black/60 animate-in fade-in-0 duration-200 ease-slide"
          onClick={onClose}
        />
      )}

      {/* Overlay container */}
      <div
        className={cn(
          "ease-slide relative bg-background rounded-lg shadow-2xl flex flex-col max-w-[95%] max-h-[95%] min-w-[480px] w-full h-full overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-200",
          className
        )}
      >
        {/* Header */}
        {(title || headerActions) && (
          <header className="flex items-center justify-between px-4 py-3 border-b bg-background shrink-0">
            {/* Left: Close + title */}
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-8 w-8 flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
              {title && (
                <div className="min-w-0">
                  <span className="text-base font-medium truncate block">{title}</span>
                  {subtitle && (
                    <span className="text-sm text-muted-foreground truncate block">
                      {subtitle}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Right: Custom actions */}
            {headerActions && (
              <div className="flex items-center gap-1 flex-shrink-0">
                {headerActions}
              </div>
            )}
          </header>
        )}

        {/* Content area */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
