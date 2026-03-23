"use client";

import { useState, useEffect } from "react";
import { collection, query, where, onSnapshot, doc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Heart } from "lucide-react";
import { PLANS, type PlanId } from "@/types/billing";
import { useSubscription } from "@/hooks/use-subscription";
import { useAuth } from "@/components/auth/auth-provider";
import { createCheckoutSessionCallable } from "@/lib/firebase/callable";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/config";
import { cn } from "@/lib/utils";
import { EXPANDABLE_COUNTRIES } from "@/types/expand";
import type { CountryExpansion } from "@/types/expand";

// Only show new tiers in comparison (hide free and legacy)
const planOrder: PlanId[] = ["data", "smart", "pro"];

export function BillingPlanComparison() {
  const { plan: currentPlan, isPlanTester, isFreePlanOverride } = useSubscription();
  const { user } = useAuth();
  const [loading, setLoading] = useState<PlanId | null>(null);
  const [userBackings, setUserBackings] = useState<{ countryCode: string }[]>([]);
  const [expansionData, setExpansionData] = useState<Map<string, CountryExpansion>>(new Map());

  // Fetch user's country backings
  useEffect(() => {
    if (!user?.email) return;
    const q = query(
      collection(db, "countryBackers"),
      where("email", "==", user.email),
      where("status", "==", "paid")
    );
    return onSnapshot(q, (snap) => {
      setUserBackings(snap.docs.map((d) => ({ countryCode: d.data().countryCode })));
    });
  }, [user?.email]);

  // Fetch expansion data for backed countries
  useEffect(() => {
    if (userBackings.length === 0) return;
    const codes = [...new Set(userBackings.map((b) => b.countryCode))];
    const unsubs = codes.map((code) =>
      onSnapshot(doc(db, "countryExpansion", code), (snap) => {
        if (snap.exists()) {
          setExpansionData((prev) => {
            const next = new Map(prev);
            next.set(snap.id, { ...snap.data(), countryCode: snap.id } as CountryExpansion);
            return next;
          });
        }
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [userBackings]);

  const handleUpgrade = async (planId: PlanId) => {
    setLoading(planId);
    try {
      if (isPlanTester) {
        const switchFn = httpsCallable(functions, "switchTesterPlan");
        await switchFn({ plan: planId });
        setLoading(null);
        return;
      }
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

  // Hide plan comparison for free_plan override users
  if (isFreePlanOverride) return null;

  // For plan ordering comparison, map legacy plans to new equivalents
  const effectivePlan = currentPlan === "starter" ? "data" : currentPlan === "business" ? "smart" : currentPlan;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Plan Comparison</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {planOrder.map((planId) => {
            const config = PLANS[planId];
            const isCurrent = planId === effectivePlan || planId === currentPlan;
            const isUpgrade = isPlanTester
              ? planId !== effectivePlan
              : planOrder.indexOf(planId) > planOrder.indexOf(effectivePlan as PlanId);

            return (
              <div
                key={planId}
                className={cn(
                  "rounded-lg border p-4 space-y-3 flex flex-col",
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
                    <span className="text-xl font-bold">
                      {config.monthlyPriceEur} EUR
                      <span className="text-sm font-normal text-muted-foreground">
                        /mo
                      </span>
                    </span>
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

                {/* Country backing indicator on Data plan */}
                {planId === "data" && userBackings.length > 0 && (
                  <div className="rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-2.5 space-y-1">
                    {[...new Set(userBackings.map((b) => b.countryCode))].map((code) => {
                      const expansion = expansionData.get(code);
                      const meta = EXPANDABLE_COUNTRIES.find((c) => c.code === code);
                      const name = meta?.name || code;
                      const flag = meta?.flag || "";
                      return (
                        <div key={code} className="flex items-center gap-1.5 text-xs">
                          <Heart className="h-3 w-3 text-blue-600 dark:text-blue-400 shrink-0 fill-current" />
                          <span className="text-blue-900 dark:text-blue-200">
                            Backing {flag} {name}
                            {expansion && (
                              <span className="text-blue-600 dark:text-blue-400 ml-1">
                                ({expansion.currentBackers}/{expansion.targetBackers} backers)
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    <p className="text-[11px] text-blue-700/70 dark:text-blue-400/70">
                      Your €10 covers the first month once enough backers join
                    </p>
                  </div>
                )}

                {isUpgrade && (
                  <Button
                    size="sm"
                    className="w-full mt-auto"
                    onClick={() => handleUpgrade(planId)}
                    disabled={loading !== null}
                  >
                    {loading === planId
                      ? isPlanTester ? "Switching..." : "Redirecting..."
                      : isPlanTester ? "Switch" : "Upgrade"}
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
