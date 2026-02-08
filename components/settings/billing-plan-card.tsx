"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Crown, ExternalLink, TestTube, Gift } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSubscription } from "@/hooks/use-subscription";
import { createPortalSessionCallable } from "@/lib/firebase/callable";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/config";
import type { PlanId } from "@/types/billing";

export function BillingPlanCard() {
  const {
    plan, planConfig, subscription, isActive, isPastDue, cancelAtPeriodEnd,
    isFreePlanOverride, isPlanTester,
  } = useSubscription();
  const [loading, setLoading] = useState(false);
  const [switchingPlan, setSwitchingPlan] = useState(false);

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

  const handleSwitchTesterPlan = async (newPlan: PlanId) => {
    setSwitchingPlan(true);
    try {
      const switchFn = httpsCallable(functions, "switchTesterPlan");
      await switchFn({ plan: newPlan });
    } catch (err) {
      console.error("Failed to switch plan:", err);
    } finally {
      setSwitchingPlan(false);
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
        <div className="flex items-center gap-2">
          {isFreePlanOverride && (
            <Badge variant="outline" className="bg-green-100 text-green-700">
              <Gift className="h-3 w-3 mr-1" />
              Free Plan (Admin)
            </Badge>
          )}
          {isPlanTester && (
            <Badge variant="outline" className="bg-blue-100 text-blue-700">
              <TestTube className="h-3 w-3 mr-1" />
              Plan Tester Mode
            </Badge>
          )}
          {isPastDue && (
            <Badge variant="destructive">Payment Overdue</Badge>
          )}
          {cancelAtPeriodEnd && (
            <Badge variant="secondary">Cancels at period end</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold">{planConfig.name}</span>
          {planConfig.monthlyPriceEur > 0 && !isFreePlanOverride && !isPlanTester && (
            <span className="text-muted-foreground">
              {planConfig.monthlyPriceEur} EUR/month
            </span>
          )}
        </div>

        {renewalDate && plan !== "free" && !isFreePlanOverride && !isPlanTester && (
          <p className="text-sm text-muted-foreground">
            {cancelAtPeriodEnd ? "Access until" : "Renews"}: {renewalDate}
          </p>
        )}

        {isPlanTester && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Switch plan:</span>
            <Select
              value={plan}
              onValueChange={(v) => handleSwitchTesterPlan(v as PlanId)}
              disabled={switchingPlan}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">Free</SelectItem>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="business">Business</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {!isFreePlanOverride && !isPlanTester && plan !== "free" && (
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
