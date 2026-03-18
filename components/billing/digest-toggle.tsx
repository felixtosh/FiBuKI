"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Mail, Loader2 } from "lucide-react";
import { callFunction } from "@/lib/firebase/callable";
import type { Subscription } from "@/types/billing";

interface DigestToggleProps {
  subscription: Subscription | null;
}

export function DigestToggle({ subscription }: DigestToggleProps) {
  // Default to enabled (opt-out model)
  const currentValue = subscription?.digestEnabled !== false;
  const [enabled, setEnabled] = useState(currentValue);
  const [saving, setSaving] = useState(false);

  const handleToggle = async () => {
    const newValue = !enabled;
    setEnabled(newValue);
    setSaving(true);

    try {
      await callFunction<{ enabled: boolean }, { success: boolean }>(
        "updateDigestPreference",
        { enabled: newValue }
      );
    } catch (err) {
      console.error("[DigestToggle] Failed to update:", err);
      setEnabled(!newValue);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4" />
          Email Preferences
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Weekly digest email</p>
            <p className="text-xs text-muted-foreground">
              Get a summary of your transactions and matching progress every Monday
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggle}
            disabled={saving}
            className="shrink-0"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : enabled ? (
              "Enabled"
            ) : (
              "Disabled"
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
