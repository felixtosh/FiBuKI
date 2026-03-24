"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Building2, Loader2 } from "lucide-react";
import { useSubscription } from "@/hooks/use-subscription";
import { callFunction } from "@/lib/firebase/callable";

export function BillingAddonsSection() {
  const { subscription, hasFeature } = useSubscription();
  const [investmentsLoading, setInvestmentsLoading] = useState(false);

  const investmentsActive =
    subscription?.addons?.investments?.active ?? false;
  const hasBmdExport = hasFeature("bmdExport");

  const handleToggleInvestments = async () => {
    setInvestmentsLoading(true);
    try {
      if (investmentsActive) {
        await callFunction("deactivateInvestmentsAddon", {});
      } else {
        await callFunction("activateInvestmentsAddon", {});
      }
    } catch (err) {
      console.error("Failed to toggle investments addon:", err);
    } finally {
      setInvestmentsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Addons</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* BMD/NTCS Export */}
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-3">
            <Building2 className="h-5 w-5 text-blue-600 shrink-0" />
            <div>
              <p className="text-sm font-medium">BMD/NTCS Export</p>
              <p className="text-xs text-muted-foreground">
                Export transactions for BMD accounting software
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={hasBmdExport ? "default" : "secondary"}>
              {hasBmdExport ? "Included" : "Pro plan"}
            </Badge>
          </div>
        </div>

        <div className="border-t" />

        {/* Investments */}
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-3">
            <TrendingUp className="h-5 w-5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-medium">Investments</p>
              <p className="text-xs text-muted-foreground">
                Track investments, FIFO cost basis, capital gains for AT/DE/CH
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">+5 EUR/mo</span>
            <Button
              variant={investmentsActive ? "outline" : "default"}
              size="sm"
              onClick={handleToggleInvestments}
              disabled={investmentsLoading}
            >
              {investmentsLoading && (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              )}
              {investmentsActive ? "Deactivate" : "Activate"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
