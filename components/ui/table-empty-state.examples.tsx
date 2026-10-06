import { Receipt, SearchX, Upload } from "lucide-react";
import { TableEmptyState, emptyStatePresets } from "@/components/ui/table-empty-state";
import type { ComponentDoc } from "@/lib/design-system/types";

function NoData() {
  const preset = emptyStatePresets.files.noData;
  return (
    <TableEmptyState
      icon={<Receipt className="h-full w-full" />}
      title={preset.title}
      description={preset.description}
      action={{ label: preset.actionLabel, onClick: () => {}, icon: <Upload className="h-4 w-4" /> }}
    />
  );
}

function NoResults() {
  const preset = emptyStatePresets.transactions.noResults;
  return (
    <TableEmptyState
      size="sm"
      icon={<SearchX className="h-full w-full" />}
      title={preset.title}
      description={preset.description}
      secondaryAction={{ label: preset.actionLabel, onClick: () => {} }}
    />
  );
}

const doc: ComponentDoc = {
  title: "TableEmptyState",
  purpose: "What a list shows when it has no rows, or none match the filters.",
  layer: "pattern",
  examples: [
    { name: "No data", Example: NoData },
    { name: "No results", Example: NoResults },
  ],
};
export default doc;
