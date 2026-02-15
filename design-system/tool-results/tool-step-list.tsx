import { ToolCallSummary } from "@/types/notification";
import { cn } from "@/lib/utils";

const STATUS_DOT: Record<ToolCallSummary["status"], string> = {
  success: "bg-green-500",
  error: "bg-red-500",
  no_results: "bg-stone-400 dark:bg-stone-500",
  skipped: "bg-stone-300 dark:bg-stone-600",
};

const OUTCOME_COLOR: Record<ToolCallSummary["status"], string> = {
  success: "text-green-600 dark:text-green-400",
  error: "text-red-500 dark:text-red-400",
  no_results: "text-muted-foreground",
  skipped: "text-muted-foreground",
};

/** Deduplicate steps by label, keeping the last occurrence of each */
function dedup(steps: ToolCallSummary[]): ToolCallSummary[] {
  const seen = new Map<string, ToolCallSummary>();
  for (const s of steps) {
    seen.set(s.label, s);
  }
  return Array.from(seen.values());
}

export function ToolStepList({
  steps,
  className,
}: {
  steps: ToolCallSummary[];
  className?: string;
}) {
  const unique = dedup(steps);
  if (unique.length === 0) return null;
  return (
    <div className={cn("space-y-0.5", className)}>
      {unique.map((s, i) => (
        <div key={i} className="flex items-start gap-1.5 text-xs py-0.5 min-w-0">
          <span
            className={cn(
              "h-1.5 w-1.5 mt-[0.3rem] rounded-full flex-shrink-0",
              STATUS_DOT[s.status]
            )}
          />
          <span className="font-medium text-foreground/80 flex-shrink-0">
            {s.label}
          </span>
          <span
            className={cn(
              "ml-auto text-right truncate max-w-[55%]",
              OUTCOME_COLOR[s.status]
            )}
            title={s.outcome}
          >
            {s.outcome}
          </span>
        </div>
      ))}
    </div>
  );
}
