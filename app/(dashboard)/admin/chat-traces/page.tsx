"use client";

/**
 * BuKI's chat traces for admins (docs/buki-rubric.md): every turn with its
 * tool calls, reply, the rubric's verdicts and the user's thumbs. This is the
 * page to read before changing the prompt, a tool or the model. Served by the
 * admin-only listChatTraces callable.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callFunction } from "@/lib/firebase/callable";

type Filter = "all" | "feedback" | "failing";

interface TraceStep {
  tool: string;
  args: string;
  result: string;
  guard?: string;
  awaitingUser?: boolean;
  failed?: boolean;
}

interface TraceRow {
  id: string;
  createdAt: string | null;
  model: string;
  userMessage: string;
  finalText: string;
  steps: TraceStep[];
  verdicts: Verdicts;
  passRate: number | null;
  feedback: { rating: string; comment: string | null } | null;
  error: string | null;
}

/** Check id to verdict. An interface, not a Record, so the UI-string check reads no generic as text. */
interface Verdicts {
  [checkId: string]: string;
}

const FILTERS: Filter[] = ["all", "feedback", "failing"];

export default function ChatTracesPage() {
  const t = useTranslations("admin.chatTraces");
  const [filter, setFilter] = useState("all" as Filter);
  const [rows, setRows] = useState(null as TraceRow[] | null);
  const [error, setError] = useState(null as string | null);
  const [open, setOpen] = useState(null as string | null);

  useEffect(() => {
    let cancelled = false;
    callFunction<{ filter: Filter; limit: number }, { traces: TraceRow[] }>("listChatTraces", { filter, limit: 200 })
      .then((res) => {
        if (!cancelled) setRows(res.traces);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const choose = (next: Filter) => {
    setFilter(next);
    setRows(null);
    setError(null);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
          <div className="flex gap-2 pt-2">
            {FILTERS.map((f) => (
              <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => choose(f)}>
                {t(filterLabel(f))}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {error ? <p className="text-sm text-destructive">{t("error", { message: error })}</p> : null}
          {!rows && !error ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("loading")}
            </p>
          ) : null}
          {rows && rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}
          {rows && rows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colWhen")}</TableHead>
                  <TableHead>{t("colQuestion")}</TableHead>
                  <TableHead>{t("colTools")}</TableHead>
                  <TableHead>{t("colReply")}</TableHead>
                  <TableHead>{t("colScore")}</TableHead>
                  <TableHead>{t("colFeedback")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TraceTableRow key={row.id} row={row} open={open === row.id} onToggle={() => setOpen(open === row.id ? null : row.id)} />
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function TraceTableRow({ row, open, onToggle }: { row: TraceRow; open: boolean; onToggle: () => void }) {
  const t = useTranslations("admin.chatTraces");
  const failing = failingChecks(row.verdicts);
  return (
    <>
      <TableRow className="cursor-pointer align-top" onClick={onToggle}>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatWhen(row.createdAt)}</TableCell>
        <TableCell className="max-w-xs text-sm">{row.userMessage}</TableCell>
        <TableCell className="max-w-xs">
          <div className="flex flex-wrap gap-1">
            {row.steps.map((step, i) => (
              <Badge key={i} variant={step.guard || step.failed ? "destructive" : "secondary"} className="text-xs">
                {step.tool}
              </Badge>
            ))}
          </div>
        </TableCell>
        <TableCell className="max-w-sm text-sm">{row.finalText || t("noReply")}</TableCell>
        <TableCell className="whitespace-nowrap text-sm">{formatRate(row.passRate)}</TableCell>
        <TableCell>{feedbackIcon(row.feedback?.rating)}</TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/30">
            <div className="flex flex-col gap-3 text-xs">
              <p>
                {t("model")}: {row.model}
              </p>
              {row.error ? <p className="text-destructive">{row.error}</p> : null}
              {failing.length > 0 ? (
                <div>
                  <p className="font-medium">{t("failingChecks")}</p>
                  <ul className="list-disc pl-4">
                    {failing.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {row.feedback?.comment ? (
                <p>
                  {t("comment")}: {row.feedback.comment}
                </p>
              ) : null}
              <div>
                <p className="font-medium">{t("steps")}</p>
                <ol className="flex flex-col gap-2 pl-4">
                  {row.steps.map((step, i) => (
                    <li key={i} className="list-decimal">
                      <span className="font-mono">{step.tool}</span> {stepNote(step, t)}
                      <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-background p-2">{step.args}</pre>
                      <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-background p-2">{step.result}</pre>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function filterLabel(filter: Filter): "filterAll" | "filterFeedback" | "filterFailing" {
  return filter === "feedback" ? "filterFeedback" : filter === "failing" ? "filterFailing" : "filterAll";
}

function failingChecks(verdicts: Verdicts): string[] {
  return Object.entries(verdicts)
    .filter(([, verdict]) => verdict === "fail")
    .map(([id]) => id);
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

function formatRate(rate: number | null): string {
  return rate === null ? "" : `${Math.round(rate * 100)}%`;
}

function feedbackIcon(rating: string | undefined) {
  if (rating === "up") {
    return <ThumbsUp className="h-4 w-4 text-green-600" />;
  }
  if (rating === "down") {
    return <ThumbsDown className="h-4 w-4 text-destructive" />;
  }
  return null;
}

function stepNote(step: TraceStep, t: ReturnType<typeof useTranslations>): string {
  if (step.guard) return t("refused", { guard: step.guard });
  if (step.awaitingUser) return t("waiting");
  if (step.failed) return t("failed");
  return "";
}
