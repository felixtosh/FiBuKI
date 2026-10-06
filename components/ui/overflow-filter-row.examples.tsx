"use client";

import { useState } from "react";
import { FileText, Tag, Wallet } from "lucide-react";
import { ChoiceFilter } from "@/components/ui/choice-filter";
import { DateRangeFilter } from "@/components/ui/date-range-filter";
import { OverflowFilterRow } from "@/components/ui/overflow-filter-row";
import { SearchButton } from "@/components/ui/search-button";
import type { ComponentDoc } from "@/lib/design-system/types";

const yesNo = [
  { value: "yes" as const, label: "Yes" },
  { value: "no" as const, label: "No" },
];

function Toolbar() {
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState<Date | undefined>();
  const [to, setTo] = useState<Date | undefined>();
  const [type, setType] = useState<"yes" | "no" | undefined>("yes");
  const [account, setAccount] = useState<"yes" | "no" | undefined>();
  const [category, setCategory] = useState<"yes" | "no" | undefined>();
  const clearAll = () => {
    setFrom(undefined);
    setTo(undefined);
    setType(undefined);
    setAccount(undefined);
    setCategory(undefined);
  };
  return (
    // Narrow on purpose, so some chips move behind "More".
    <div className="max-w-xl resize-x overflow-hidden border rounded-md p-2">
      <OverflowFilterRow
        leading={<SearchButton value={search} onSearch={setSearch} placeholder="Search..." />}
        moreLabel="More"
        panelTitle="Filters"
        clearLabel="Clear all"
        onClearAll={clearAll}
        items={[
          { key: "date", active: Boolean(from || to), node: <DateRangeFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /> },
          { key: "type", active: type !== undefined, node: <ChoiceFilter label="File" icon={<FileText className="h-4 w-4" />} allLabel="All" options={yesNo} value={type} onChange={setType} /> },
          { key: "account", active: account !== undefined, node: <ChoiceFilter label="Account" icon={<Wallet className="h-4 w-4" />} allLabel="All" options={yesNo} value={account} onChange={setAccount} /> },
          { key: "category", active: category !== undefined, node: <ChoiceFilter label="Category" icon={<Tag className="h-4 w-4" />} allLabel="All" options={yesNo} value={category} onChange={setCategory} /> },
        ]}
      />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "OverflowFilterRow",
  purpose: "A list page's filter toolbar: search first, one chip per column, the rest behind \"More\".",
  layer: "pattern",
  examples: [{ name: "List toolbar (drag the corner to narrow it)", Example: Toolbar }],
};
export default doc;
