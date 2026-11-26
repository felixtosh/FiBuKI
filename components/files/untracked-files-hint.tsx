"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { CalendarX, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { joinYears } from "@/components/import/untracked-import-choice";
import { callFunction } from "@/lib/firebase/callable";
import type { UntrackedFilesHint as Hint } from "@/types/fiscal-years";

type Shown = Hint | null;

/**
 * Documents dated before Tracked From (#805, ADR-0018). A File is never
 * skipped, because its date is known only after extraction: it is kept, left
 * out of the work lists, and named once here ("3 documents from 2021, a year
 * you don't track"). Dismissing stores what was shown, on the server, so it
 * comes back only for documents that arrive later.
 */
export function UntrackedFilesHint() {
  const t = useTranslations("settings.fiscalYears.untrackedFiles");
  const locale = useLocale();
  const [hint, setHint] = useState<Shown>(null);

  useEffect(() => {
    let cancelled = false;
    callFunction<Record<string, never>, Hint>("getUntrackedFilesHint", {})
      .then((answer) => !cancelled && setHint(answer))
      .catch((err) => console.error("Failed to read the untracked documents hint:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!hint || !(hint.count > 0) || !hint.byFiscalYear) return null;
  const years = Object.keys(hint.byFiscalYear);

  const dismiss = () => {
    setHint(null);
    callFunction("dismissUntrackedFilesHint", {}).catch((err) =>
      console.error("Failed to dismiss the untracked documents hint:", err)
    );
  };

  return (
    <Alert role="status" className="mx-4 mt-3 w-auto pr-12">
      <CalendarX className="h-4 w-4" />
      <AlertTitle>{t("title", { count: hint.count, yearCount: years.length, years: joinYears(years, locale) })}</AlertTitle>
      <AlertDescription>
        <p>{t("body")}</p>
        <Link href="/settings/fiscal-years" className="text-primary underline-offset-4 hover:underline">
          {t("link")}
        </Link>
      </AlertDescription>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={dismiss}
        aria-label={t("dismiss")}
        className="absolute right-2 top-2 h-7 w-7"
      >
        <X className="h-4 w-4" />
      </Button>
    </Alert>
  );
}
