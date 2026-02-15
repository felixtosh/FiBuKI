"use client";

import { useState } from "react";
import { Tag, Search, AlertTriangle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { UserNoReceiptCategory, CategorySuggestion } from "@/types/no-receipt-category";
import { Transaction } from "@/types/transaction";
import { cn } from "@/lib/utils";

interface NoReceiptCategoryPopoverProps {
  categories: UserNoReceiptCategory[];
  transaction: Transaction;
  onSelect: (categoryId: string) => void;
  disabled?: boolean;
}

export function NoReceiptCategoryPopover({
  categories,
  transaction,
  onSelect,
  disabled,
}: NoReceiptCategoryPopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Get suggestions from transaction if available
  const suggestions = transaction.categorySuggestions || [];
  const suggestionMap = new Map(suggestions.map((s) => [s.categoryId, s]));

  // Filter categories by search
  const filteredCategories = categories.filter((category) => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      category.name.toLowerCase().includes(searchLower) ||
      category.description.toLowerCase().includes(searchLower) ||
      category.helperText.toLowerCase().includes(searchLower)
    );
  });

  // Sort: suggestions first, then alphabetical
  const sortedCategories = [...filteredCategories].sort((a, b) => {
    const aIsSuggested = suggestionMap.has(a.id);
    const bIsSuggested = suggestionMap.has(b.id);

    if (aIsSuggested && !bIsSuggested) return -1;
    if (!aIsSuggested && bIsSuggested) return 1;

    // If both are suggestions, sort by confidence
    if (aIsSuggested && bIsSuggested) {
      const aConfidence = suggestionMap.get(a.id)?.confidence || 0;
      const bConfidence = suggestionMap.get(b.id)?.confidence || 0;
      return bConfidence - aConfidence;
    }

    return a.name.localeCompare(b.name);
  });

  const handleSelect = (categoryId: string) => {
    onSelect(categoryId);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3"
          disabled={disabled}
        >
          <Plus className="h-3 w-3 mr-1" />
          Select
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="end"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search categories..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
        </div>

        <div className="max-h-[300px] overflow-y-auto">
          <div className="p-1">
            {sortedCategories.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No categories found
              </div>
            ) : (
              sortedCategories.map((category) => {
                const suggestion = suggestionMap.get(category.id);
                const isReceiptLost = category.templateId === "receipt-lost";

                return (
                  <button
                    key={category.id}
                    onClick={() => handleSelect(category.id)}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors",
                      suggestion && "bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/30 dark:hover:bg-amber-950/50"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {isReceiptLost ? (
                        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                      ) : (
                        <Tag className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "text-sm font-medium",
                              isReceiptLost && "text-amber-600 dark:text-amber-400"
                            )}
                          >
                            {category.name}
                          </span>
                          {suggestion && (
                            <Badge
                              variant="outline"
                              className="text-xs px-1.5 py-0 h-5 bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-700"
                            >
                              {Math.round(suggestion.confidence)}%
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                          {category.helperText}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {suggestions.length > 0 && (
          <div className="p-2 border-t bg-muted/30">
            <p className="text-xs text-muted-foreground text-center">
              Highlighted categories are suggested matches
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
