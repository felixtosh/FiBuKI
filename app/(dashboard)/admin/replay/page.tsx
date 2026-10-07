"use client";

/**
 * Replay reports for the signed-in admin's own account (docs/replay.md): one
 * run per PR, and the rows the branch decides differently from its base.
 * Served by /api/admin/replay, which answers for the caller's account only.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Loader2, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/components/auth";
import { pushQuery } from "@/lib/navigation/query-url";
import { BenchmarkVersionsCard } from "@/components/admin/benchmark-versions-card";

type Verdict = "now_agrees" | "now_disagrees" | "contradicts" | "unverified";
type Counts = Record<Verdict, number>;

interface RunEntry {
  pr: number;
  builtAt: string;
  head: string | null;
  base: string | null;
  files: { total: number; changed: number };
  transactions: { total: number; changed: number };
  counts: Counts;
}

interface FileRow {
  kind: "file";
  id: string;
  name: string;
  amount: number | null;
  date: string | null;
  verdict: Verdict;
  because: string;
  before: { autoConnect: string[]; suggestions: string[] };
  after: { autoConnect: string[]; suggestions: string[] };
  truth: { manualConnections: string[]; automatedConnections: string[]; rejected: string[] };
}

interface TransactionRow {
  kind: "transaction";
  id: string;
  name: string;
  amount: number | null;
  date: string | null;
  verdict: Verdict;
  because: string;
  before: { wouldAssign: string | null; top: string | null };
  after: { wouldAssign: string | null; top: string | null };
  truth: { partnerId: string | null; partnerMatchedBy: string | null };
}

interface Diff {
  base: { label: string; gitSha: string | null; builtAt: string };
  head: { label: string; gitSha: string | null; builtAt: string; setLabel: string; setExportedAt: string };
  files: { total: number; unchanged: number; rows: FileRow[] };
  transactions: { total: number; unchanged: number; rows: TransactionRow[] };
  counts: Counts;
}

const MARK: Record<Verdict, string> = {
  now_agrees: "✅",
  now_disagrees: "❌",
  contradicts: "❌",
  unverified: "❓",
};

export default function AdminReplayPage() {
  const t = useTranslations("admin.replay");
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedPr = searchParams.get("pr");

  const [runs, setRuns] = useState(null as RunEntry[] | null);
  const [configured, setConfigured] = useState(true);
  // The diff last loaded, with the PR it belongs to: a report for another PR
  // is never shown while the selected one is still loading.
  const [loaded, setLoaded] = useState(null as { pr: string; diff: Diff } | null);
  const [error, setError] = useState(null as string | null);
  const diff = loaded && loaded.pr === selectedPr ? loaded.diff : null;
  const loadingDiff = selectedPr !== null && diff === null && error === null;

  const authedFetch = useCallback(
    async (url: string) => {
      if (!user) throw new Error("no user");
      const token = await user.getIdToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`${res.status}`);
      return res;
    },
    [user]
  );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    authedFetch("/api/admin/replay")
      .then((res) => res.json())
      .then((data: { runs: RunEntry[]; configured: boolean }) => {
        if (cancelled) return;
        setRuns(data.runs);
        setConfigured(data.configured);
      })
      .catch(() => {
        if (!cancelled) setError(t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [user, authedFetch, t]);

  useEffect(() => {
    if (!user || !selectedPr) return;
    let cancelled = false;
    authedFetch(`/api/admin/replay?pr=${encodeURIComponent(selectedPr)}`)
      .then((res) => res.json())
      .then((data: Diff) => {
        if (!cancelled) setLoaded({ pr: selectedPr, diff: data });
      })
      .catch(() => {
        if (!cancelled) setError(t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [user, selectedPr, authedFetch, t]);

  const openRun = (pr: number) => pushQuery(router, `/admin/replay?pr=${pr}`);

  const downloadMarkdown = async () => {
    if (!selectedPr) return;
    const res = await authedFetch(`/api/admin/replay?pr=${encodeURIComponent(selectedPr)}&format=md`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `replay-${selectedPr}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <Repeat className="h-5 w-5" />
          <h1 className="text-lg font-semibold">{t("title")}</h1>
        </div>
        {selectedPr ? (
          <Button variant="outline" size="sm" onClick={downloadMarkdown}>
            <Download className="h-4 w-4 mr-2" />
            {t("download")}
          </Button>
        ) : null}
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-6">
        <p className="text-sm text-muted-foreground max-w-3xl">{t("intro")}</p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!configured ? <p className="text-sm text-muted-foreground">{t("notConfigured")}</p> : null}

        {selectedPr ? null : <BenchmarkVersionsCard />}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("runs")}</CardTitle>
            <CardDescription>{t("runsHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            {runs === null ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RunsTable runs={runs} selectedPr={selectedPr} onOpen={openRun} t={t} />
            )}
          </CardContent>
        </Card>

        {loadingDiff ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {diff && !loadingDiff ? <DiffView diff={diff} t={t} /> : null}
      </div>
    </div>
  );
}

type T = (key: string, values?: Record<string, string | number>) => string;

function RunsTable({
  runs,
  selectedPr,
  onOpen,
  t,
}: {
  runs: RunEntry[];
  selectedPr: string | null;
  onOpen: (pr: number) => void;
  t: T;
}) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("columns.pr")}</TableHead>
          <TableHead>{t("columns.when")}</TableHead>
          <TableHead>{t("columns.commits")}</TableHead>
          <TableHead className="text-right">{t("columns.filesChanged")}</TableHead>
          <TableHead className="text-right">{t("columns.transactionsChanged")}</TableHead>
          <TableHead className="text-right">{MARK.now_agrees}</TableHead>
          <TableHead className="text-right">{MARK.contradicts}</TableHead>
          <TableHead className="text-right">{MARK.unverified}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow
            key={run.pr}
            className={run.pr === Number(selectedPr) ? "bg-muted/50 cursor-pointer" : "cursor-pointer"}
            onClick={() => onOpen(run.pr)}
          >
            <TableCell className="font-mono">#{run.pr}</TableCell>
            <TableCell>{formatWhen(run.builtAt)}</TableCell>
            <TableCell className="font-mono text-xs">{shortSha(run.base)} → {shortSha(run.head)}</TableCell>
            <TableCell className="text-right">{run.files.changed} / {run.files.total}</TableCell>
            <TableCell className="text-right">{run.transactions.changed} / {run.transactions.total}</TableCell>
            <TableCell className="text-right">{run.counts.now_agrees ?? 0}</TableCell>
            <TableCell className="text-right">{(run.counts.now_disagrees ?? 0) + (run.counts.contradicts ?? 0)}</TableCell>
            <TableCell className="text-right">{run.counts.unverified ?? 0}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DiffView({ diff, t }: { diff: Diff; t: T }) {
  const worse = diff.counts.contradicts + diff.counts.now_disagrees !== 0;
  const changed = diff.files.rows.length + diff.transactions.rows.length !== 0;
  const verdictKey = worse ? "worse" : changed ? "ok" : "none";
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {diff.head.label} {t("versus")} {diff.base.label}
          </CardTitle>
          <CardDescription>
            {t("setLine", { label: diff.head.setLabel, exportedAt: formatWhen(diff.head.setExportedAt) })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium">{t(`verdictLine.${verdictKey}`)}</p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{MARK.now_agrees} {t("verdict.now_agrees")}: {diff.counts.now_agrees}</Badge>
            <Badge variant="outline">{MARK.now_disagrees} {t("verdict.now_disagrees")}: {diff.counts.now_disagrees}</Badge>
            <Badge variant="outline">{MARK.contradicts} {t("verdict.contradicts")}: {diff.counts.contradicts}</Badge>
            <Badge variant="outline">{MARK.unverified} {t("verdict.unverified")}: {diff.counts.unverified}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("totals", {
              files: diff.files.total,
              filesUnchanged: diff.files.unchanged,
              transactions: diff.transactions.total,
              transactionsUnchanged: diff.transactions.unchanged,
            })}
          </p>
        </CardContent>
      </Card>

      {diff.files.rows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("sections.files", { count: diff.files.rows.length })}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead />
                  <TableHead>{t("table.file")}</TableHead>
                  <TableHead className="text-right">{t("table.amount")}</TableHead>
                  <TableHead>{t("table.date")}</TableHead>
                  <TableHead>{t("table.autoConnect")}</TableHead>
                  <TableHead>{t("table.suggestions")}</TableHead>
                  <TableHead>{t("table.hand")}</TableHead>
                  <TableHead>{t("table.why")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.files.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{MARK[r.verdict]}</TableCell>
                    <TableCell>
                      <div>{r.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.id}</div>
                    </TableCell>
                    <TableCell className="text-right">{formatCents(r.amount)}</TableCell>
                    <TableCell>{r.date ?? "?"}</TableCell>
                    <TableCell className="font-mono text-xs">{idList(r.before.autoConnect)} → {idList(r.after.autoConnect)}</TableCell>
                    <TableCell className="font-mono text-xs">{idList(r.before.suggestions)} → {idList(r.after.suggestions)}</TableCell>
                    <TableCell className="font-mono text-xs">{fileHand(r, t)}</TableCell>
                    <TableCell className="text-xs">{r.because}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {diff.transactions.rows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("sections.transactions", { count: diff.transactions.rows.length })}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead />
                  <TableHead>{t("table.transaction")}</TableHead>
                  <TableHead className="text-right">{t("table.amount")}</TableHead>
                  <TableHead>{t("table.date")}</TableHead>
                  <TableHead>{t("table.wouldAssign")}</TableHead>
                  <TableHead>{t("table.topCandidate")}</TableHead>
                  <TableHead>{t("table.storedPartner")}</TableHead>
                  <TableHead>{t("table.why")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.transactions.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{MARK[r.verdict]}</TableCell>
                    <TableCell>
                      <div>{r.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.id}</div>
                    </TableCell>
                    <TableCell className="text-right">{formatCents(r.amount)}</TableCell>
                    <TableCell>{r.date ?? "?"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.before.wouldAssign ?? "–"} → {r.after.wouldAssign ?? "–"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.before.top ?? "–"} → {r.after.top ?? "–"}</TableCell>
                    <TableCell className="font-mono text-xs">{transactionHand(r)}</TableCell>
                    <TableCell className="text-xs">{r.because}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : "?");
const idList = (ids: string[]) => (ids.length === 0 ? "–" : ids.join(", "));
const formatCents = (n: number | null) => (n == null ? "?" : (n / 100).toFixed(2));
const formatWhen = (iso: string) => (iso ? new Date(iso).toLocaleString() : "?");

function fileHand(r: FileRow, t: T): string {
  if (r.truth.manualConnections.length > 0) return t("hand.connected", { ids: r.truth.manualConnections.join(", ") });
  if (r.truth.rejected.length > 0) return t("hand.rejected", { ids: r.truth.rejected.join(", ") });
  return "–";
}

function transactionHand(r: TransactionRow): string {
  return r.truth.partnerId ? `${r.truth.partnerId} (${r.truth.partnerMatchedBy ?? "?"})` : "–";
}
