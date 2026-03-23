"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mail, Bell, ShieldCheck, Loader2 } from "lucide-react";
import { callFunction } from "@/lib/firebase/callable";
import type { Subscription } from "@/types/billing";

interface EmailPreferencesProps {
  subscription: Subscription | null;
}

type EmailPreference = "digest" | "budgetWarnings";

export function EmailPreferences({ subscription }: EmailPreferencesProps) {
  // Defaults: both opt-out (enabled unless explicitly false)
  const [digestEnabled, setDigestEnabled] = useState(
    subscription?.digestEnabled !== false
  );
  const [budgetWarningsEnabled, setBudgetWarningsEnabled] = useState(
    subscription?.budgetWarningsEnabled !== false
  );
  const [savingDigest, setSavingDigest] = useState(false);
  const [savingBudget, setSavingBudget] = useState(false);

  const togglePreference = async (
    preference: EmailPreference,
    currentValue: boolean,
    setter: (v: boolean) => void,
    setSaving: (v: boolean) => void
  ) => {
    const newValue = !currentValue;
    setter(newValue);
    setSaving(true);

    try {
      await callFunction<
        { preference: EmailPreference; enabled: boolean },
        { success: boolean }
      >("updateEmailPreference", { preference, enabled: newValue });
    } catch (err) {
      console.error("[EmailPreferences] Failed to update:", err);
      setter(!newValue); // revert
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Transactional */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            Transactional
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Account emails</p>
              <p className="text-xs text-muted-foreground">
                Invitations, password resets, and security alerts
              </p>
            </div>
            <Badge variant="secondary">Always on</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Weekly Digest */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" />
            Weekly Digest
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Weekly summary email</p>
              <p className="text-xs text-muted-foreground">
                Transaction stats and matching progress, every Monday
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                togglePreference(
                  "digest",
                  digestEnabled,
                  setDigestEnabled,
                  setSavingDigest
                )
              }
              disabled={savingDigest}
              className="shrink-0"
            >
              {savingDigest ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : digestEnabled ? (
                "Enabled"
              ) : (
                "Disabled"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Budget Warnings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4" />
            Budget Warnings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">AI budget warning emails</p>
              <p className="text-xs text-muted-foreground">
                Notified at 90% and 100% of your AI budget
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                togglePreference(
                  "budgetWarnings",
                  budgetWarningsEnabled,
                  setBudgetWarningsEnabled,
                  setSavingBudget
                )
              }
              disabled={savingBudget}
              className="shrink-0"
            >
              {savingBudget ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : budgetWarningsEnabled ? (
                "Enabled"
              ) : (
                "Disabled"
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            In-app notifications are always shown regardless of this setting.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
