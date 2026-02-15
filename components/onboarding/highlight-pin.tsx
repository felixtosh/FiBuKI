"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface Position {
  top: number;
  left: number;
  width: number;
  height: number;
}

type LabelPositionType = "top" | "bottom" | "left" | "right";

interface HighlightPinProps {
  /** CSS selector for target element(s) - can match multiple elements */
  target: string;
  /** Whether this pin is active (should show) */
  active: boolean;
  /** Label to show next to the highlight */
  label?: string;
  /** Preferred position of the label relative to target */
  labelPosition?: LabelPositionType;
  /** Whether to scroll target into view */
  scrollIntoView?: boolean;
  /** When true, dismiss the highlight when the user focuses any element inside the target */
  dismissOnInteraction?: boolean;
}

interface TargetState {
  element: Element;
  position: Position;
  isVisible: boolean;
}

// Estimated label dimensions for viewport calculations
const LABEL_WIDTH_ESTIMATE = 140;
const LABEL_HEIGHT_ESTIMATE = 36;
const VIEWPORT_PADDING = 16;

/**
 * Calculate the best label position that fits within the viewport
 */
function getBestLabelPosition(
  targetRect: Position,
  preferred: LabelPositionType,
  padding: number
): LabelPositionType {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Check available space in each direction
  const spaceRight = viewportWidth - (targetRect.left + targetRect.width + padding);
  const spaceLeft = targetRect.left - padding;
  const spaceBottom = viewportHeight - (targetRect.top + targetRect.height + padding);
  const spaceTop = targetRect.top - padding;

  // Check if preferred position fits
  const fitsRight = spaceRight >= LABEL_WIDTH_ESTIMATE + VIEWPORT_PADDING;
  const fitsLeft = spaceLeft >= LABEL_WIDTH_ESTIMATE + VIEWPORT_PADDING;
  const fitsBottom = spaceBottom >= LABEL_HEIGHT_ESTIMATE + VIEWPORT_PADDING;
  const fitsTop = spaceTop >= LABEL_HEIGHT_ESTIMATE + VIEWPORT_PADDING;

  // Try preferred position first
  if (preferred === "right" && fitsRight) return "right";
  if (preferred === "left" && fitsLeft) return "left";
  if (preferred === "bottom" && fitsBottom) return "bottom";
  if (preferred === "top" && fitsTop) return "top";

  // Fallback order: right -> left -> bottom -> top
  if (fitsRight) return "right";
  if (fitsLeft) return "left";
  if (fitsBottom) return "bottom";
  if (fitsTop) return "top";

  // If nothing fits well, use left (will be clamped to viewport)
  return "left";
}

// Helper to check if an element is obscured
function isElementObscured(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  const topElement = document.elementFromPoint(centerX, centerY);
  if (!topElement) return true;

  return !element.contains(topElement) && topElement !== element;
}

// Helper to check if an element is in viewport
function isElementInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const isHorizontallyVisible = rect.right > 0 && rect.left < viewportWidth;
  const isVerticallyVisible = rect.bottom > 0 && rect.top < viewportHeight;

  return isHorizontallyVisible && isVerticallyVisible;
}

export function HighlightPin({
  target,
  active,
  label,
  labelPosition = "right",
  scrollIntoView = true,
  dismissOnInteraction = false,
}: HighlightPinProps) {
  const [targets, setTargets] = useState<TargetState[]>([]);
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const observerRef = useRef<ResizeObserver | null>(null);
  const hasScrolledRef = useRef(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Reset scroll flag and dismissed state when target changes
  useEffect(() => {
    hasScrolledRef.current = false;
    setDismissed(false);
  }, [target]);

  // Dismiss on focusin when dismissOnInteraction is enabled
  useEffect(() => {
    if (!dismissOnInteraction || !active || dismissed) return;

    const handleFocusIn = () => {
      setDismissed(true);
    };

    // Attach focusin to all matching elements
    const elements = document.querySelectorAll(target);
    elements.forEach((el) => el.addEventListener("focusin", handleFocusIn));

    return () => {
      elements.forEach((el) => el.removeEventListener("focusin", handleFocusIn));
    };
  }, [target, active, dismissOnInteraction, dismissed]);

  // Update all target positions and visibility
  const updateTargets = useCallback(() => {
    const elements = document.querySelectorAll(target);
    const newTargets: TargetState[] = [];

    elements.forEach((element) => {
      const rect = element.getBoundingClientRect();
      const isInViewport = isElementInViewport(element);
      const isObscured = isElementObscured(element);

      newTargets.push({
        element,
        position: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
        isVisible: isInViewport && !isObscured,
      });
    });

    setTargets(newTargets);
  }, [target]);

  useEffect(() => {
    if (!active || !mounted) {
      setTargets([]);
      return;
    }

    // Initial update
    updateTargets();

    // Find first visible element and scroll to it
    if (scrollIntoView && !hasScrolledRef.current) {
      const elements = document.querySelectorAll(target);
      const firstVisible = Array.from(elements).find(
        (el) => isElementInViewport(el) && !isElementObscured(el)
      );
      if (firstVisible) {
        firstVisible.scrollIntoView({ behavior: "smooth", block: "center" });
        hasScrolledRef.current = true;
      } else if (elements.length > 0) {
        elements[0].scrollIntoView({ behavior: "smooth", block: "center" });
        hasScrolledRef.current = true;
      }
    }

    // Track position changes with ResizeObserver
    const elements = document.querySelectorAll(target);
    observerRef.current = new ResizeObserver(updateTargets);
    elements.forEach((el) => observerRef.current?.observe(el));

    // Periodic visibility check + scroll/resize handlers
    const checkInterval = setInterval(updateTargets, 200);
    window.addEventListener("scroll", updateTargets, true);
    window.addEventListener("resize", updateTargets);

    // Click handler on any target - will be detected as obscured
    const handleClick = () => {
      // Force immediate update after click
      setTimeout(updateTargets, 50);
    };
    elements.forEach((el) => el.addEventListener("click", handleClick, true));

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      clearInterval(checkInterval);
      window.removeEventListener("scroll", updateTargets, true);
      window.removeEventListener("resize", updateTargets);
      elements.forEach((el) => el.removeEventListener("click", handleClick, true));
    };
  }, [target, active, mounted, scrollIntoView, updateTargets]);

  // Filter to only visible targets
  const visibleTargets = targets.filter((t) => t.isVisible);

  if (!mounted || !active || dismissed || visibleTargets.length === 0) return null;

  // Calculate combined bounding box for all visible targets
  const combinedPosition: Position = visibleTargets.reduce(
    (acc, t) => {
      const right = Math.max(acc.left + acc.width, t.position.left + t.position.width);
      const bottom = Math.max(acc.top + acc.height, t.position.top + t.position.height);
      const left = Math.min(acc.left, t.position.left);
      const top = Math.min(acc.top, t.position.top);
      return {
        top,
        left,
        width: right - left,
        height: bottom - top,
      };
    },
    {
      top: visibleTargets[0].position.top,
      left: visibleTargets[0].position.left,
      width: visibleTargets[0].position.width,
      height: visibleTargets[0].position.height,
    }
  );

  const padding = 12;
  const labelStyle: React.CSSProperties = {};
  const actualPosition = getBestLabelPosition(combinedPosition, labelPosition, padding);

  switch (actualPosition) {
    case "top":
      labelStyle.bottom = combinedPosition.height + padding;
      labelStyle.left = "50%";
      labelStyle.transform = "translateX(-50%)";
      break;
    case "bottom":
      labelStyle.top = combinedPosition.height + padding;
      labelStyle.left = "50%";
      labelStyle.transform = "translateX(-50%)";
      break;
    case "left":
      labelStyle.right = combinedPosition.width + padding;
      labelStyle.top = "50%";
      labelStyle.transform = "translateY(-50%)";
      break;
    case "right":
    default:
      labelStyle.left = combinedPosition.width + padding;
      labelStyle.top = "50%";
      labelStyle.transform = "translateY(-50%)";
      break;
  }

  return createPortal(
    <div
      className="fixed pointer-events-none"
      style={{
        top: combinedPosition.top,
        left: combinedPosition.left,
        width: combinedPosition.width,
        height: combinedPosition.height,
        zIndex: 100,
      }}
    >
      {/* Pulsing ring around combined targets */}
      <div
        className={cn(
          "absolute inset-0 rounded-lg",
          "border-2 border-primary",
          "animate-pulse"
        )}
        style={{
          top: -4,
          left: -4,
          right: -4,
          bottom: -4,
          width: combinedPosition.width + 8,
          height: combinedPosition.height + 8,
        }}
      />

      {/* Outer glow ring */}
      <div
        className={cn(
          "absolute inset-0 rounded-lg",
          "border border-primary/30",
          "animate-ping"
        )}
        style={{
          top: -8,
          left: -8,
          right: -8,
          bottom: -8,
          width: combinedPosition.width + 16,
          height: combinedPosition.height + 16,
          animationDuration: "1.5s",
        }}
      />

      {/* Label badge */}
      {label && (
        <div
          className={cn(
            "absolute whitespace-nowrap",
            "flex items-center gap-2",
            "bg-primary text-primary-foreground",
            "px-3 py-1.5 rounded-full shadow-lg",
            "text-sm font-medium",
            "animate-in fade-in slide-in-from-left-2 duration-300"
          )}
          style={labelStyle}
        >
          {/* Pulsing dot */}
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-foreground opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-foreground" />
          </span>
          {label}
        </div>
      )}
    </div>,
    document.body
  );
}
