"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { callFunction } from "@/lib/firebase/callable";

export interface UserBenchmark {
  inBenchmark: boolean;
  contractNote: string | null;
  mayDownload: boolean;
}

interface UserBenchmarkSectionProps {
  uid: string;
  benchmark: UserBenchmark;
  onChanged: (uid: string, benchmark: UserBenchmark) => void;
}

/**
 * The two benchmark switches for one user (docs/benchmarking.md): whether
 * their account is in the shared benchmark data, which needs the contract
 * that allows it, and whether they may download that data.
 */
export function UserBenchmarkSection({ uid, benchmark, onChanged }: UserBenchmarkSectionProps) {
  const t = useTranslations("admin.benchmark");
  const [note, setNote] = useState(benchmark.contractNote ?? "");
  const [askingForNote, setAskingForNote] = useState(false);
  const [saving, setSaving] = useState(null as "in" | "download" | null);
  const [error, setError] = useState(null as string | null);

  const save = async (
    which: "in" | "download",
    request: { inBenchmark?: boolean; contractNote?: string | null; mayDownload?: boolean }
  ) => {
    setSaving(which);
    setError(null);
    try {
      const result = await callFunction<Record<string, unknown>, { member: UserBenchmark }>("setBenchmarkMember", {
        targetUid: uid,
        ...request,
      });
      onChanged(uid, {
        inBenchmark: result.member.inBenchmark,
        contractNote: result.member.contractNote,
        mayDownload: result.member.mayDownload,
      });
      setAskingForNote(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const toggleIn = (on: boolean) => {
    if (on && !note.trim()) {
      setAskingForNote(true);
      return;
    }
    void save("in", { inBenchmark: on, contractNote: note.trim() || null });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <FlaskConical className="h-3 w-3 inline mr-1" />
        {t("title")}
      </h3>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={`bench-in-${uid}`}>{t("inBenchmark")}</Label>
          <p className="text-xs text-muted-foreground">
            {benchmark.inBenchmark && benchmark.contractNote
              ? t("inBenchmarkBecause", { note: benchmark.contractNote })
              : t("inBenchmarkHint")}
          </p>
        </div>
        {saving === "in" ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Switch id={`bench-in-${uid}`} checked={benchmark.inBenchmark} onCheckedChange={toggleIn} />
        )}
      </div>

      {askingForNote ? (
        <div className="space-y-2 rounded-md border p-3">
          <Label htmlFor={`bench-note-${uid}`}>{t("contractNote")}</Label>
          <Input
            id={`bench-note-${uid}`}
            value={note}
            placeholder={t("contractNotePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!note.trim() || saving !== null}
              onClick={() => void save("in", { inBenchmark: true, contractNote: note.trim() })}
            >
              {t("addToBenchmark")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAskingForNote(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={`bench-dl-${uid}`}>{t("mayDownload")}</Label>
          <p className="text-xs text-muted-foreground">{t("mayDownloadHint")}</p>
        </div>
        {saving === "download" ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Switch
            id={`bench-dl-${uid}`}
            checked={benchmark.mayDownload}
            onCheckedChange={(on) => void save("download", { mayDownload: on })}
          />
        )}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
