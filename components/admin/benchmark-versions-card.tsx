"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Database, Download, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/components/auth";
import { callFunction } from "@/lib/firebase/callable";

interface VersionSummary {
  id: string;
  version: string;
  builtAt: string;
  checksum: string;
  sizeBytes: number;
  accounts: Array<{ uid: string; label: string; transactions: number; files: number }>;
  newHandDecisions?: number;
}

/**
 * The shared benchmark data (docs/benchmarking.md): the versions built from
 * the accounts in the benchmark, a button that builds the next one, and the
 * download, which the server allows only to people with the switch.
 */
export function BenchmarkVersionsCard() {
  const t = useTranslations("admin.benchmark");
  const { user } = useAuth();
  const [versions, setVersions] = useState(null as VersionSummary[] | null);
  const [busy, setBusy] = useState(null as string | null);
  const [message, setMessage] = useState(null as string | null);

  const load = useCallback(async () => {
    try {
      const result = await callFunction<Record<string, never>, { versions: VersionSummary[] }>("listBenchmarkVersions", {});
      setVersions(result.versions);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setVersions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const build = async () => {
    setBusy("build");
    setMessage(null);
    try {
      await callFunction<Record<string, never>, unknown>("buildBenchmarkVersion", {});
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(t("deleteConfirm", { version: id }))) return;
    setBusy(id);
    try {
      await callFunction<{ versionId: string }, unknown>("deleteBenchmarkVersion", { versionId: id });
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const download = async (id: string) => {
    if (!user) return;
    setBusy(`dl-${id}`);
    setMessage(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/benchmark?version=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setMessage(res.status === 403 ? t("downloadNotAllowed") : t("downloadFailed"));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  const newest = versions?.[0];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4" />
            {t("versionsTitle")}
          </CardTitle>
          <CardDescription>{t("versionsHint")}</CardDescription>
        </div>
        <Button size="sm" onClick={build} disabled={busy !== null}>
          {busy === "build" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
          {t("build")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {message ? <p className="text-sm text-destructive">{message}</p> : null}
        {newest && newest.newHandDecisions !== undefined ? (
          <p className="text-sm text-muted-foreground">
            {t("sinceNewest", { n: newest.newHandDecisions, version: newest.version })}
          </p>
        ) : null}
        {versions === null ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {versions !== null && versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noVersions")}</p>
        ) : null}
        {versions !== null && versions.length !== 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("version")}</TableHead>
                <TableHead>{t("builtAt")}</TableHead>
                <TableHead>{t("accounts")}</TableHead>
                <TableHead>{t("checksum")}</TableHead>
                <TableHead className="text-right">{t("size")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium">{v.version}</TableCell>
                  <TableCell>{new Date(v.builtAt).toLocaleString("de-AT")}</TableCell>
                  <TableCell>{v.accounts.map((a) => a.label).join(", ")}</TableCell>
                  <TableCell className="font-mono text-xs">{v.checksum.slice(0, 12)}</TableCell>
                  <TableCell className="text-right tabular-nums">{(v.sizeBytes / 1_000_000).toFixed(1)} MB</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => download(v.id)} disabled={busy !== null} aria-label={t("downloadVersion")}>
                      {busy === `dl-${v.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(v.id)} disabled={busy !== null} aria-label={t("deleteVersion")}>
                      {busy === v.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
