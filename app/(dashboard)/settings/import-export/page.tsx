"use client";

import { ExportSection } from "@/components/settings/export-section";
import { ImportSection } from "@/components/settings/import-section";

export default function ImportExportPage() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">Import / Export</h2>
        <p className="text-sm text-muted-foreground">
          Backup your data or restore from a previous export.
        </p>
      </div>

      <ExportSection />
      <ImportSection />
    </div>
  );
}
