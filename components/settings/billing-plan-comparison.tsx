"use client";

import { useState, useEffect } from "react";
import { collection, query, where, onSnapshot, doc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Heart, ExternalLink, Calendar } from "lucide-react";
import { format } from "date-fns";
import { PLANS, type PlanId } from "@/types/billing";
import { usePlanPricing, formatMinor } from "@/hooks/use-plan-pricing";
import { useSubscription } from "@/hooks/use-subscription";
import { useAuth } from "@/components/auth/auth-provider";
import {
  createCheckoutSessionCallable,
  createPortalSessionCallable,
  switchPlanCallable,
} from "@/lib/firebase/callable";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/config";
import { cn } from "@/lib/utils";
import { EXPANDABLE_COUNTRIES } from "@/types/expand";
import type { CountryExpansion } from "@/types/expand";

// Main grid: Free, Data, Smart — Pro is shown as addon below
const planOrder: PlanId[] = ["free", "data", "smart"];

// Plan tier ordering for upgrade/downgrade comparison
const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  data: 1,
  smart: 2,
  pro: 3,
  // Legacy
  starter: 1,
  business: 2,
};

export function BillingPlanComparison() {
  const {
    plan: currentPlan,
    planConfig,
    subscription,
    isPlanTester,
    isFreePlanOverride,
  } = useSubscription();
  const { user } = useAuth();
  // Prices from Stripe, so the displayed figure is the billed figure.
  // See hooks/use-plan-pricing.ts.
  const pricing = usePlanPricing();

  const [loading, setLoading] = useState<PlanId | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [userBackings, setUserBackings] = useState<{ countryCode: string }[]>(
    []
  );
  const [expansionData, setExpansionData] = useState<
    Map<string, CountryExpansion>
  >(new Map());

  // Fetch user's country backings
  useEffect(() => {
    if (!user?.email) return;
    const q = query(
      collection(db, "countryBackers"),
      where("email", "==", user.email),
      where("status", "==", "paid")
    );
    return onSnapshot(q, (snap) => {
      setUserBackings(
        snap.docs.map((d) => ({ countryCode: d.data().countryCode }))
      );
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
            next.set(snap.id, {
              ...snap.data(),
              countryCode: snap.id,
            } as CountryExpansion);
            return next;
          });
        }
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [userBackings]);

  const hasActiveSubscription = !!subscription?.stripeSubscriptionId;

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const result = await createPortalSessionCallable({
        returnUrl: window.location.href,
      });
      window.location.href = result.portalUrl;
    } catch (err) {
      console.error("Failed to open billing portal:", err);
    } finally {
      setPortalLoading(false);
    }
  };

  const handlePlanAction = async (planId: PlanId) => {
    setLoading(planId);
    try {
      // Plan testers: use admin switch
      if (isPlanTester) {
        const switchFn = httpsCallable(functions, "switchTesterPlan");
        await switchFn({ plan: planId });
        setLoading(null);
        return;
      }

      // User has an active Stripe subscription — switch directly
      if (hasActiveSubscription) {
        await switchPlanCallable({ plan: planId });
        setLoading(null);
        return;
      }

      // No subscription yet — redirect to checkout (needs payment info)
      if (planId === "free") {
        // Already free, nothing to do
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
      console.error("Failed to switch plan:", err);
      setLoading(null);
    }
  };

  // Show a friendly card for admin-gifted users
  if (isFreePlanOverride) {
    return (
      <Card>
        <CardContent className="py-8 text-center space-y-2">
          <div className="flex items-center justify-center gap-2">
            <Heart className="h-5 w-5 text-green-600 fill-green-600" />
            <h3 className="text-lg font-semibold">{planConfig.name} Plan</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Gifted by admin &mdash; enjoy testing!
          </p>
        </CardContent>
      </Card>
    );
  }

  // For plan ordering comparison, map legacy plans to new equivalents
  const effectivePlan =
    currentPlan === "starter"
      ? "data"
      : currentPlan === "business"
        ? "smart"
        : currentPlan;

  const currentRank = PLAN_RANK[effectivePlan] ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Plan Comparison</CardTitle>
        {hasActiveSubscription && !isPlanTester && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleManageSubscription}
            disabled={portalLoading}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
            {portalLoading ? "Opening..." : "Manage Subscription"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Main grid: Free | Data | Smart */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {planOrder.map((planId) => {
            const config = PLANS[planId];
            const isCurrent =
              planId === effectivePlan || planId === currentPlan;
            const planRank = PLAN_RANK[planId] ?? 0;
            const isUpgrade = planRank > currentRank;
            const isDowngrade = planRank < currentRank;

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
                  {isCurrent && subscription?.currentPeriodEnd && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      Renews {format(subscription.currentPeriodEnd.toDate(), "MMM d, yyyy")}
                      {subscription.cancelAtPeriodEnd && " (cancels)"}
                    </p>
                  )}
                  <div className="mt-1">
                    <span className="text-xl font-bold">
                      {/* From Stripe, which is what actually charges the card.
                          formatMinor works in minor units so money never goes
                          through float arithmetic. Falls back to the plan config
                          only when Stripe and its cache are both unavailable. */}
                      {config.monthlyPriceEur === 0
                        ? "Free"
                        : formatMinor(pricing.plans[planId]?.monthly) ??
                          `${config.monthlyPriceEur} EUR`}
                      {config.monthlyPriceEur > 0 && (
                        <span className="text-sm font-normal text-muted-foreground">
                          /mo
                        </span>
                      )}
                    </span>
                  </div>
                  {isCurrent && config.monthlyPriceEur > 0 && (() => {
                    // Active addons are LISTED but no longer priced. Their
                    // activation callables (bmdExportAddon.ts and siblings) carry
                    // "TODO: integrate Stripe subscription item for billing" and make
                    // no Stripe calls at all, so nothing is charged for them and no
                    // Stripe price object exists. This previously rendered
                    // "+ Priority Support: 50 EUR" and folded it into a total,
                    // stating a charge that never happened. Restore the amounts once
                    // the addons are genuinely billed.
                    const addons = subscription?.addons;
                    const active: string[] = [];
                    if (addons?.bmdExport?.active) active.push("BMD Export");
                    if (addons?.investments?.active) active.push("Investments");
                    if (addons?.prioritySupport?.active) active.push("Priority Support");
                    if (active.length === 0) return null;
                    return (
                      <div className="text-xs text-muted-foreground space-y-0.5 mt-1">
                        <div>Included add-ons:</div>
                        {active.map((label) => (
                          <div key={label}>+ {label}</div>
                        ))}
                      </div>
                    );
                  })()}
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
                    {[...new Set(userBackings.map((b) => b.countryCode))].map(
                      (code) => {
                        const expansion = expansionData.get(code);
                        const meta = EXPANDABLE_COUNTRIES.find(
                          (c) => c.code === code
                        );
                        const name = meta?.name || code;
                        const flag = meta?.flag || "";
                        return (
                          <div
                            key={code}
                            className="flex items-center gap-1.5 text-xs"
                          >
                            <Heart className="h-3 w-3 text-blue-600 dark:text-blue-400 shrink-0 fill-current" />
                            <span className="text-blue-900 dark:text-blue-200">
                              Backing {flag} {name}
                              {expansion && (
                                <span className="text-blue-600 dark:text-blue-400 ml-1">
                                  ({expansion.currentBackers}/
                                  {expansion.targetBackers} backers)
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      }
                    )}
                    <p className="text-[11px] text-blue-700/70 dark:text-blue-400/70">
                      Your €10 becomes account credit when you subscribe
                    </p>
                  </div>
                )}

                <div className="mt-auto">
                  {isCurrent ? null : isUpgrade ? (
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => handlePlanAction(planId)}
                      disabled={loading !== null}
                    >
                      {loading === planId
                        ? "Switching..."
                        : isPlanTester
                          ? "Switch"
                          : hasActiveSubscription
                            ? "Upgrade"
                            : "Get started"}
                    </Button>
                  ) : isDowngrade ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={() => handlePlanAction(planId)}
                      disabled={loading !== null}
                    >
                      {loading === planId ? "Switching..." : "Downgrade"}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

      </CardContent>
    </Card>
  );
}
