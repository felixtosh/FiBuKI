"use client";

import { UserUsageDashboard } from "@/components/settings";
import { SmartFeatureGuard } from "@/components/auth";

export default function UsagePage() {
  return (
    <SmartFeatureGuard feature="aiMatching">
      <UserUsageDashboard />
    </SmartFeatureGuard>
  );
}
