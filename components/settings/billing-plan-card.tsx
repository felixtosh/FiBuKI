"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Crown, ExternalLink } from "lucide-react";
import { useSubscription } from "@/hooks/use-subscription";
import { createPortalSessionCallable } from "@/lib/firebase/callable";
import { useState } from "react";
import type { PlanId } from "@/types/billing";

export function BillingPlanCard() {
  const { plan, planConfig, subscription, isActive, isPastDue, cancelAtPeriodEnd } =
    useSubscription();
  const [loading, setLoading] = useState(false);

  const handleManageSubscription = async () => {
    setLoading(true);
    try {
      const result = await createPortalSessionCallable({
        returnUrl: window.location.href,
      });
      window.location.href = result.portalUrl;
    } catch (err) {
      console.error("Failed to open billing portal:", err);
    } finally {
      setLoading(false);
    }
  };

  const periodEnd = subscription?.currentPeriodEnd;
  const renewalDate = periodEnd
    ? new Date(
        typeof periodEnd === "object" && "seconds" in periodEnd
          ? (periodEnd as { seconds: number }).seconds * 1000
          : periodEnd as unknown as number
      ).toLocaleDateString("de-AT", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Crown className="h-5 w-5 text-yellow-500" />
          <CardTitle className="text-base">Current Plan</CardTitle>
        </div>
        {isPastDue && (
          <Badge variant="destructive">Payment Overdue</Badge>
        )}
        {cancelAtPeriodEnd && (
          <Badge variant="secondary">Cancels at period end</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold">{planConfig.name}</span>
          {planConfig.monthlyPriceEur > 0 && (
            <span className="text-muted-foreground">
              {planConfig.monthlyPriceEur} EUR/month
            </span>
          )}
        </div>

        {renewalDate && plan !== "free" && (
          <p className="text-sm text-muted-foreground">
            {cancelAtPeriodEnd ? "Access until" : "Renews"}: {renewalDate}
          </p>
        )}

        {plan !== "free" && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleManageSubscription}
            disabled={loading}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            {loading ? "Opening..." : "Manage Subscription"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
