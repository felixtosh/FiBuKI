"use client";

import { CheckCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Shown after a sign-in was turned away for lack of an invite or seat and an access request
 * was filed. When the person was connecting an assistant, it also says how to finish once
 * they are approved: the authorize request is gone, so the app has to start the connection again.
 */
export function AccessRequestedNotice({ connecting }: { connecting: boolean }) {
  const t = useTranslations("auth.accessRequested");
  return (
    <Alert className="border-green-200 bg-green-50 text-green-900">
      <CheckCircle className="h-4 w-4 text-green-600" />
      <AlertDescription>
        {connecting ? (
          <>
            <strong>{t("connectingTitle")}</strong> {t("connectingBody")}
          </>
        ) : (
          t("default")
        )}
      </AlertDescription>
    </Alert>
  );
}
