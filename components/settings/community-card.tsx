"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTelegramLink } from "@/hooks/use-telegram-link";

/** Settings → Community: link a Telegram account to get into the private chat. */
export function CommunityCard() {
  const t = useTranslations("settings.community");
  const { status, busy, error, url, connect, disconnect } = useTelegramLink();

  let body: React.ReactNode = <Loader2 className="h-4 w-4 animate-spin" />;
  if (status && !status.available) {
    body = <p className="text-sm text-muted-foreground">{t("unavailable")}</p>;
  } else if (status?.linked) {
    body = (
      <div className="flex items-center gap-3">
        <p className="text-sm">
          {status.username ? t("connectedAs", { name: `@${status.username}` }) : t("connectedAnonymous")}
        </p>
        <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
          {t("disconnect")}
        </Button>
      </div>
    );
  } else if (status) {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        <Button onClick={connect} disabled={busy}>
          {busy ? t("connecting") : t("connect")}
        </Button>
        {url ? (
          <p className="text-xs text-muted-foreground">
            {t("openBot")}{" "}
            <a className="underline" href={url} target="_blank" rel="noopener noreferrer">
              {url}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cardTitle")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {body}
        {status?.announcementsUrl ? (
          <p className="text-sm">
            <a className="underline" href={status.announcementsUrl} target="_blank" rel="noopener noreferrer">
              {t("announcements")}
            </a>
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{t("failed")}</p> : null}
      </CardContent>
    </Card>
  );
}
