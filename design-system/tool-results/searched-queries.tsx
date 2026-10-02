"use client";

interface SearchedQueriesProps {
  queries: string[];
  /** How many queries to show before collapsing the rest into "+N more" */
  max?: number;
}

/**
 * "Searched:" row of a search tool result. A Gmail query can be long
 * (date range plus a list of -from: exclusions), so each query wraps
 * inside its own box instead of overflowing a fixed-height pill.
 */
export function SearchedQueries({ queries, max = 3 }: SearchedQueriesProps) {
  if (queries.length === 0) return null;

  return (
    <div className="px-3 py-1.5 bg-muted/20 border-b flex items-start gap-1.5">
      <span className="text-[10px] leading-4 text-muted-foreground shrink-0">Searched:</span>
      <div className="flex flex-wrap gap-1 min-w-0">
        {queries.slice(0, max).map((query, idx) => (
          <code
            key={idx}
            title={query}
            className="min-w-0 max-w-full rounded border bg-background px-1.5 py-px text-[10px] leading-4 font-mono font-normal text-foreground break-words [overflow-wrap:anywhere]"
          >
            {query}
          </code>
        ))}
        {queries.length > max && (
          <span className="text-[10px] leading-4 text-muted-foreground">
            +{queries.length - max} more
          </span>
        )}
      </div>
    </div>
  );
}
