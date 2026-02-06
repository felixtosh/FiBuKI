"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";
import { PLANS, type PlanId } from "@/types/billing";
import { useSubscription } from "@/hooks/use-subscription";
import { createCheckoutSessionCallable } from "@/lib/firebase/callable";
import { cn } from "@/lib/utils";

const planOrder: PlanId[] = ["free", "starter", "business", "pro"];

export function BillingPlanComparison() {
  const { plan: currentPlan } = useSubscription();
  const [loading, setLoading] = useState<PlanId | null>(null);

  const handleUpgrade = async (planId: PlanId) => {
    setLoading(planId);
    try {
      const result = await createCheckoutSessionCallable({
        plan: planId,
        billingPeriod: "monthly",
        successUrl: `${window.location.origin}/settings/billing?upgrade=success`,
        cancelUrl: `${window.location.origin}/settings/billing`,
      });
      window.location.href = result.checkoutUrl;
    } catch (err) {
      console.error("Failed to start checkout:", err);
      setLoading(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Plan Comparison</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {planOrder.map((planId) => {
            const config = PLANS[planId];
            const isCurrent = planId === currentPlan;
            const isUpgrade = planOrder.indexOf(planId) > planOrder.indexOf(currentPlan);

            return (
              <div
                key={planId}
                className={cn(
                  "rounded-lg border p-4 space-y-3",
                  isCurrent && "border-primary bg-primary/5"
                )}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{config.name}</h3>
                    {isCurrent && (
                      <Badge variant="secondary" className="text-xs">
                        Current
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1">
                    {config.monthlyPriceEur > 0 ? (
                      <span className="text-xl font-bold">
                        {config.monthlyPriceEur} EUR
                        <span className="text-sm font-normal text-muted-foreground">
                          /mo
                        </span>
                      </span>
                    ) : (
                      <span className="text-xl font-bold">Free</span>
                    )}
                  </div>
                </div>

                <ul className="space-y-1.5 text-sm">
                  {config.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-1.5">
                      <Check className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {isUpgrade && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => handleUpgrade(planId)}
                    disabled={loading !== null}
                  >
                    {loading === planId ? "Redirecting..." : "Upgrade"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
