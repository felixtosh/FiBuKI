"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Globe,
  Plus,
  Trash2,
  Pause,
  Play,
  ExternalLink,
  AlertCircle,
  Clock,
  Calendar,
  Loader2,
  ChevronDown,
  ChevronUp,
  Link as LinkIcon,
  Lock,
  CheckCircle2,
  XCircle,
  Zap,
  Bookmark,
  MousePointerClick,
  Navigation,
  Type,
  ArrowDown,
  FileDown,
  Tag,
} from "lucide-react";
import {
  UserPartner,
  InvoiceSourceStatus,
  BrowserRecipe,
  RecordedAction,
} from "@/types/partner";
import { formatDistanceToNow } from "date-fns";
import { Timestamp } from "firebase/firestore";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface BrowserAutomationsSectionProps {
  partner: UserPartner;
  onAddBookmark: (url: string, label?: string) => Promise<string | void>;
  onDeleteRecipe: (recipeId: string) => Promise<void>;
  onToggleStatus: (recipeId: string, newStatus: "active" | "paused") => Promise<void>;
  onToggleAutoRun: (recipeId: string, autoRun: boolean) => Promise<void>;
  onPromoteLink?: (linkIndex: number) => Promise<string | void>;
  onInferFrequency?: (recipeId: string) => Promise<void>;
  onReplayRecipe?: (recipeId: string) => void;
  isLoading?: boolean;
}

/**
 * Get a human-readable label for frequency in days
 */
function getFrequencyLabel(days: number): string {
  if (days === 7) return "Weekly";
  if (days === 14) return "Bi-weekly";
  if (days >= 28 && days <= 31) return "Monthly";
  if (days >= 89 && days <= 92) return "Quarterly";
  if (days >= 180 && days <= 183) return "Semi-annually";
  if (days >= 364 && days <= 366) return "Yearly";
  return `Every ${days} days`;
}

/**
 * Get badge variant based on recipe status
 */
function getStatusBadge(status: InvoiceSourceStatus | undefined) {
  switch (status) {
    case "active":
      return (
        <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">
          Active
        </Badge>
      );
    case "paused":
      return (
        <Badge variant="outline" className="text-yellow-600 border-yellow-300 text-[10px]">
          Paused
        </Badge>
      );
    case "error":
      return (
        <Badge variant="outline" className="text-red-600 border-red-300 text-[10px]">
          Error
        </Badge>
      );
    case "needs_login":
      return (
        <Badge variant="outline" className="text-orange-600 border-orange-300 text-[10px]">
          Login Required
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * Format a Firestore Timestamp for display
 */
function formatTimestamp(ts: Timestamp | undefined): string {
  if (!ts) return "Never";
  try {
    return formatDistanceToNow(ts.toDate(), { addSuffix: true });
  } catch {
    return "Unknown";
  }
}

/**
 * Get badge for replay result status
 */
function getReplayStatusBadge(recipe: BrowserRecipe) {
  const result = recipe.lastReplayResult;
  if (!result) return null;
  if (result.status === "success") {
    return (
      <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">
        <CheckCircle2 className="h-3 w-3 mr-0.5" />
        Success
      </Badge>
    );
  }
  const labels: Record<string, string> = {
    failed_element: "Element not found",
    failed_match: "No match",
    failed_auth: "Auth required",
    failed_timeout: "Timeout",
  };
  return (
    <Badge variant="outline" className="text-red-600 border-red-300 text-[10px]">
      <XCircle className="h-3 w-3 mr-0.5" />
      {labels[result.status] || "Failed"}
    </Badge>
  );
}

/**
 * Icon + label for a recorded action type
 */
function getActionIcon(actionType: RecordedAction["actionType"]) {
  switch (actionType) {
    case "navigate":
      return <Navigation className="h-3 w-3 text-blue-500" />;
    case "click":
      return <MousePointerClick className="h-3 w-3 text-amber-500" />;
    case "type":
      return <Type className="h-3 w-3 text-purple-500" />;
    case "scroll":
      return <ArrowDown className="h-3 w-3 text-muted-foreground" />;
    case "pdf_detected":
      return <FileDown className="h-3 w-3 text-green-500" />;
    case "mark_invoice_page":
      return <Tag className="h-3 w-3 text-green-500" />;
    default:
      return <Globe className="h-3 w-3 text-muted-foreground" />;
  }
}

/**
 * Human-readable description for a recorded action
 */
function describeAction(action: RecordedAction): string {
  switch (action.actionType) {
    case "navigate": {
      if (action.targetUrl) {
        try {
          const url = new URL(action.targetUrl);
          return url.pathname + (url.search ? url.search.slice(0, 30) : "");
        } catch {
          return action.targetUrl.slice(0, 60);
        }
      }
      return "Navigate";
    }
    case "click": {
      const t = action.clickTarget;
      if (!t) return "Click";
      const label = t.text?.trim().slice(0, 40) || t.ariaLabel?.slice(0, 40) || "";
      const tag = t.tagName ? `<${t.tagName}>` : "";
      return label ? `${label} ${tag}` : tag || "Click element";
    }
    case "type": {
      const val = action.inputValue || "";
      const display = val.length > 30 ? val.slice(0, 30) + "..." : val;
      return display ? `"${display}"` : "Type text";
    }
    case "scroll":
      return "Scroll page";
    case "pdf_detected":
      return "PDF detected";
    case "mark_invoice_page":
      return "Marked as invoice page";
    default:
      return action.actionType;
  }
}

/**
 * Whether a recipe is a simple bookmark (no recorded navigation steps)
 */
function isBookmark(recipe: BrowserRecipe): boolean {
  return !recipe.recordedActions || recipe.recordedActions.length === 0;
}

/**
 * Single recipe/bookmark item in the unified list
 */
function RecipeItem({
  recipe,
  onDelete,
  onToggleStatus,
  onToggleAutoRun,
  onReplay,
  onInferFrequency,
}: {
  recipe: BrowserRecipe;
  onDelete: () => void;
  onToggleStatus: () => void;
  onToggleAutoRun?: (autoRun: boolean) => void;
  onReplay?: () => void;
  onInferFrequency?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const bookmark = isBookmark(recipe);

  return (
    <div className="border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <img
              src={`https://www.google.com/s2/favicons?domain=${recipe.domain}&sz=16`}
              alt=""
              className="h-4 w-4 flex-shrink-0"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <span className="font-medium truncate text-sm">
              {recipe.label || recipe.domain}
            </span>
            {recipe.requiresAuth && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Lock className="h-3 w-3 text-orange-500 flex-shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent>Login required</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            {bookmark ? (
              <Badge variant="secondary" className="text-[10px]">
                <Bookmark className="h-2.5 w-2.5 mr-0.5" />
                Bookmark
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]">
                {recipe.recordedActions.length} steps
              </Badge>
            )}
            {getStatusBadge(recipe.status)}
            {!bookmark && getReplayStatusBadge(recipe)}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {!bookmark && onReplay && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={onReplay}
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Replay recipe</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={onToggleStatus}
                >
                  {recipe.status === "paused" ? (
                    <Play className="h-4 w-4" />
                  ) : (
                    <Pause className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {recipe.status === "paused" ? "Resume" : "Pause"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Quick stats row */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex gap-3">
          {recipe.inferredFrequencyDays && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {getFrequencyLabel(recipe.inferredFrequencyDays)}
            </span>
          )}
          {(recipe.useCount || 0) > 0 && (
            <span>Used {recipe.useCount}x</span>
          )}
          {recipe.lastUsedAt && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTimestamp(recipe.lastUsedAt)}
            </span>
          )}
        </div>
        {!bookmark && onToggleAutoRun && (
          <button
            onClick={() => onToggleAutoRun(!recipe.autoRun)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
              recipe.autoRun
                ? "bg-green-50 text-green-900 border border-green-300 hover:bg-green-100"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            <Zap className="h-3 w-3" />
            {recipe.autoRun ? "Auto" : "Manual"}
          </button>
        )}
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className="pt-2 border-t space-y-2 text-sm">
          {recipe.lastError && (
            <div className="flex items-start gap-2 text-red-600 bg-red-50 p-2 rounded">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span className="text-xs">{recipe.lastError}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Domain:</span>{" "}
              <a
                href={recipe.startUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                {recipe.domain}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {recipe.sourceType && (
              <div>
                <span className="text-muted-foreground">Source:</span>{" "}
                {recipe.sourceType === "manual"
                  ? "Manual"
                  : recipe.sourceType === "email_link"
                  ? "Email"
                  : recipe.sourceType === "learn_mode"
                  ? "Learn Mode"
                  : "Browser"}
              </div>
            )}
            {(recipe.successfulFetches ?? 0) > 0 && (
              <div>
                <span className="text-muted-foreground">Successful:</span>{" "}
                {recipe.successfulFetches}
              </div>
            )}
            {(recipe.failedFetches ?? 0) > 0 && (
              <div>
                <span className="text-muted-foreground">Failed:</span>{" "}
                {recipe.failedFetches}
              </div>
            )}
            {recipe.nextExpectedAt && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Next fetch:</span>{" "}
                {formatTimestamp(recipe.nextExpectedAt)}
              </div>
            )}
          </div>

          {/* Recorded steps */}
          {!bookmark && recipe.recordedActions.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                Recorded Steps
              </span>
              <ol className="space-y-0.5">
                {recipe.recordedActions.map((action, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-xs py-1 px-2 rounded hover:bg-muted/50"
                  >
                    <span className="flex-shrink-0 mt-0.5 w-4 text-center text-muted-foreground font-mono text-[10px]">
                      {i + 1}
                    </span>
                    <span className="flex-shrink-0 mt-0.5">
                      {getActionIcon(action.actionType)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="font-medium">{describeAction(action)}</span>
                      {action.clickTarget?.href && (
                        <span className="block text-[10px] text-muted-foreground truncate">
                          {action.clickTarget.href}
                        </span>
                      )}
                      {action.pageContext?.title && (
                        <span className="block text-[10px] text-muted-foreground truncate">
                          on: {action.pageContext.title}
                        </span>
                      )}
                    </span>
                    {action.source === "agent" && (
                      <Badge variant="outline" className="text-[9px] flex-shrink-0">
                        AI
                      </Badge>
                    )}
                  </li>
                ))}
              </ol>
              {(recipe.agentActions?.length ?? 0) > 0 && (
                <>
                  <span className="text-xs font-medium text-muted-foreground mt-2 block">
                    Agent-Learned Steps ({recipe.agentActions!.length})
                  </span>
                  <ol className="space-y-0.5">
                    {recipe.agentActions!.map((action, i) => (
                      <li
                        key={`agent-${i}`}
                        className="flex items-start gap-2 text-xs py-1 px-2 rounded hover:bg-muted/50"
                      >
                        <span className="flex-shrink-0 mt-0.5 w-4 text-center text-muted-foreground font-mono text-[10px]">
                          {i + 1}
                        </span>
                        <span className="flex-shrink-0 mt-0.5">
                          {getActionIcon(action.actionType)}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="font-medium">{describeAction(action)}</span>
                          {action.clickTarget?.href && (
                            <span className="block text-[10px] text-muted-foreground truncate">
                              {action.clickTarget.href}
                            </span>
                          )}
                        </span>
                        <Badge variant="outline" className="text-[9px] flex-shrink-0">
                          AI
                        </Badge>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            {onInferFrequency && !recipe.inferredFrequencyDays && (
              <Button
                variant="outline"
                size="sm"
                onClick={onInferFrequency}
                className="text-xs"
              >
                <Calendar className="h-3 w-3 mr-1" />
                Infer Frequency
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={onDelete}
              className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Add source form (creates a bookmark recipe)
 */
function AddSourceForm({
  onAdd,
  isLoading,
}: {
  onAdd: (url: string, label?: string) => void;
  isLoading?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    onAdd(url.trim(), label.trim() || undefined);
    setUrl("");
    setLabel("");
    setIsExpanded(false);
  };

  if (!isExpanded) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsExpanded(true)}
        className="w-full"
      >
        <Plus className="h-4 w-4 mr-2" />
        Add Source
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="border rounded-lg p-3 space-y-3">
      <div className="space-y-2">
        <Label htmlFor="source-url" className="text-xs">
          Invoice Portal URL
        </Label>
        <Input
          id="source-url"
          type="url"
          placeholder="https://billing.example.com/invoices"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="source-label" className="text-xs">
          Label (optional)
        </Label>
        <Input
          id="source-label"
          type="text"
          placeholder="e.g., Google Admin Billing"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isLoading || !url.trim()}>
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Plus className="h-4 w-4 mr-2" />
          )}
          Add
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Promotable invoice links from emails
 */
function InvoiceLinksSection({
  partner,
  onPromote,
}: {
  partner: UserPartner;
  onPromote: (index: number) => void;
}) {
  const invoiceLinks = partner.invoiceLinks || [];
  const [isExpanded, setIsExpanded] = useState(false);

  if (invoiceLinks.length === 0) return null;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-between text-xs text-muted-foreground"
        >
          <span className="flex items-center gap-2">
            <LinkIcon className="h-3 w-3" />
            {invoiceLinks.length} discovered link
            {invoiceLinks.length !== 1 ? "s" : ""} from emails
          </span>
          {isExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {invoiceLinks.slice(0, 5).map((link, index) => (
          <div
            key={index}
            className="flex items-center justify-between gap-2 p-2 border rounded text-xs"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                {link.anchorText || "Invoice Link"}
              </div>
              <div className="text-muted-foreground truncate">{link.url}</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPromote(index)}
              className="flex-shrink-0"
            >
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          </div>
        ))}
        {invoiceLinks.length > 5 && (
          <div className="text-xs text-muted-foreground text-center">
            And {invoiceLinks.length - 5} more...
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Unified Browser Automations Section — single list of BrowserRecipes
 * (recipes with steps + bookmarks with empty recordedActions)
 */
export function BrowserAutomationsSection({
  partner,
  onAddBookmark,
  onDeleteRecipe,
  onToggleStatus,
  onToggleAutoRun,
  onPromoteLink,
  onInferFrequency,
  onReplayRecipe,
  isLoading,
}: BrowserAutomationsSectionProps) {
  const [addingSource, setAddingSource] = useState(false);

  const recipes = partner.browserRecipes || [];

  const handleAddBookmark = useCallback(
    async (url: string, label?: string) => {
      setAddingSource(true);
      try {
        await onAddBookmark(url, label);
      } finally {
        setAddingSource(false);
      }
    },
    [onAddBookmark]
  );

  const handleToggleStatus = useCallback(
    (recipeId: string, currentStatus: InvoiceSourceStatus | undefined) => {
      const newStatus = currentStatus === "paused" ? "active" : "paused";
      onToggleStatus(recipeId, newStatus);
    },
    [onToggleStatus]
  );

  return (
    <div className="space-y-3">
      {recipes.length === 0 && !isLoading && (
        <div className="text-xs text-muted-foreground py-2">
          No browser automations configured. Add a URL or use Learn Mode from a
          transaction to create one.
        </div>
      )}

      {/* Recipe/bookmark list */}
      <div className="space-y-2">
        {recipes.map((recipe) => (
          <RecipeItem
            key={recipe.id}
            recipe={recipe}
            onDelete={() => onDeleteRecipe(recipe.id)}
            onToggleStatus={() => handleToggleStatus(recipe.id, recipe.status)}
            onToggleAutoRun={(autoRun) => onToggleAutoRun(recipe.id, autoRun)}
            onReplay={
              onReplayRecipe ? () => onReplayRecipe(recipe.id) : undefined
            }
            onInferFrequency={
              onInferFrequency
                ? () => onInferFrequency(recipe.id)
                : undefined
            }
          />
        ))}
      </div>

      {/* Add source form */}
      <AddSourceForm onAdd={handleAddBookmark} isLoading={addingSource} />

      {/* Discovered invoice links from emails */}
      {onPromoteLink && (
        <InvoiceLinksSection partner={partner} onPromote={onPromoteLink} />
      )}
    </div>
  );
}
