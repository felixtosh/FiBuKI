"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MergeUserPartnersResponse, UserPartner } from "@/types/partner";
import { usePartners } from "@/hooks/use-partners";
import {
  findVatIdConflicts,
  fieldGains,
  newEntryCount,
} from "@/lib/partners/merge-preview";

interface MergePartnersDialogProps {
  open: boolean;
  onClose: () => void;
  /** The Partners selected on the list. Length must be at least two. */
  partners: UserPartner[];
  /** Called once the merge has committed, so the caller can clear its selection. */
  onMerged?: () => void;
}

interface PreviewCounts {
  transactions: number;
  files: number;
  invoices: number;
}

// Firestore's `in` operator tops out at 30 values.
const IN_QUERY_CHUNK_SIZE = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function countByField(
  collectionName: string,
  field: string,
  userId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  let total = 0;
  for (const batch of chunk(ids, IN_QUERY_CHUNK_SIZE)) {
    const snapshot = await getDocs(
      query(
        collection(db, collectionName),
        where("userId", "==", userId),
        where(field, "in", batch),
      ),
    );
    total += snapshot.size;
  }
  return total;
}

export function MergePartnersDialog({
  open,
  onClose,
  partners,
  onMerged,
}: MergePartnersDialogProps) {
  const { userId } = useAuth();
  const { mergePartners } = usePartners();

  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [confirmVatConflict, setConfirmVatConflict] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeUserPartnersResponse | null>(null);
  // The survivor's name as it stood when the merge was submitted. The
  // `partners` prop is live, and the losers leave it the moment the merge
  // commits (they are no longer `isActive`), so the result view cannot read
  // the merge back off it — it reports what the callable returned (#263 AC5).
  const [survivorNameAtSubmit, setSurvivorNameAtSubmit] = useState("");
  const [previewCounts, setPreviewCounts] = useState<PreviewCounts | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  // The count query failed. Said out loud rather than left as a spinner that
  // never resolves: the confirmation has to state what will move, and "we
  // could not count it" is the honest version of that (#263 AC3).
  const [previewFailed, setPreviewFailed] = useState(false);

  // Reset whenever the dialog opens. Deliberately keyed on `open` alone: the
  // `partners` prop can get a new array identity from a live Firestore update
  // while the dialog is already open, and that must not wipe out a survivor
  // the user already picked. Nothing preselects the survivor.
  useEffect(() => {
    if (!open) return;
    setSurvivorId(null);
    setConfirmVatConflict(false);
    setIsSubmitting(false);
    setError(null);
    setResult(null);
    setSurvivorNameAtSubmit("");
    setPreviewCounts(null);
    setPreviewFailed(false);
  }, [open]);

  const survivor = useMemo(
    () => partners.find((p) => p.id === survivorId) || null,
    [partners, survivorId],
  );
  const losers = useMemo(
    () => partners.filter((p) => p.id !== survivorId),
    [partners, survivorId],
  );

  const vatConflicts = useMemo(
    () => findVatIdConflicts(partners.map((p) => ({ id: p.id, name: p.name, vatId: p.vatId }))),
    [partners],
  );
  const hasVatConflict = vatConflicts.length > 0;

  const gains = useMemo(
    () => (survivor ? fieldGains(survivor, losers) : []),
    [survivor, losers],
  );

  const newAliasCount = useMemo(() => {
    if (!survivor) return 0;
    return newEntryCount(
      survivor.aliases,
      losers.map((l) => l.aliases),
      (v) => String(v).trim().toLowerCase(),
    );
  }, [survivor, losers]);

  const newIbanCount = useMemo(() => {
    if (!survivor) return 0;
    return newEntryCount(
      survivor.ibans,
      losers.map((l) => l.ibans),
      (v) => String(v).replace(/\s/g, "").toUpperCase(),
    );
  }, [survivor, losers]);

  // Fetch how many Transactions, Files and Invoices reference the losers —
  // the "what will move" half of the confirmation (#263 AC3).
  useEffect(() => {
    if (!survivorId || !userId) {
      setPreviewCounts(null);
      setPreviewFailed(false);
      return;
    }
    let cancelled = false;
    const loserIds = losers.map((l) => l.id);
    setIsLoadingPreview(true);
    setPreviewFailed(false);
    Promise.all([
      countByField("transactions", "partnerId", userId, loserIds),
      countByField("files", "partnerId", userId, loserIds),
      countByField("invoices", "recipient.partnerId", userId, loserIds),
    ])
      .then(([transactions, files, invoices]) => {
        if (!cancelled) setPreviewCounts({ transactions, files, invoices });
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewCounts(null);
        setPreviewFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [survivorId, userId, losers]);

  const canConfirm =
    !!survivorId && !isSubmitting && (!hasVatConflict || confirmVatConflict);

  const handleConfirm = async () => {
    if (!survivor) return;
    setIsSubmitting(true);
    setError(null);
    setSurvivorNameAtSubmit(survivor.name);
    try {
      const response = await mergePartners({
        survivorId: survivor.id,
        loserIds: losers.map((l) => l.id),
        confirmVatIdConflict: hasVatConflict ? true : undefined,
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to merge partners.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (isSubmitting) return;
    onClose();
    if (result) onMerged?.();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent className="max-w-lg">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Partners merged</DialogTitle>
              <DialogDescription>
                {result.mergedPartnerIds.length} partner
                {result.mergedPartnerIds.length === 1 ? "" : "s"} merged into &quot;
                {survivorNameAtSubmit}&quot;.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p>
                {result.repointed.transactions} transaction
                {result.repointed.transactions === 1 ? "" : "s"},{" "}
                {result.repointed.files} file{result.repointed.files === 1 ? "" : "s"} and{" "}
                {result.repointed.invoices} invoice
                {result.repointed.invoices === 1 ? "" : "s"} now point to &quot;
                {survivorNameAtSubmit}&quot;.
              </p>
              <p className="text-muted-foreground">
                {result.rematchPreview.newlyMatchable > 0
                  ? `${result.rematchPreview.newlyMatchable} previously unmatched transaction${
                      result.rematchPreview.newlyMatchable === 1 ? "" : "s"
                    } could now match "${survivorNameAtSubmit}". Review with the partner rematch report.`
                  : `No previously unmatched transactions would now match "${survivorNameAtSubmit}".`}
              </p>
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Merge {partners.length} partners</DialogTitle>
              <DialogDescription>
                Choose which partner survives. The others fold into it and disappear from
                the list. This cannot be undone.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1">
              {partners.map((partner) => {
                const isSurvivor = partner.id === survivorId;
                return (
                  <button
                    key={partner.id}
                    type="button"
                    onClick={() => setSurvivorId(partner.id)}
                    className={`w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      isSurvivor
                        ? "border-primary bg-primary/5"
                        : "border-transparent hover:bg-muted"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        isSurvivor ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground"
                      }`}
                    >
                      {isSurvivor && <Check className="h-3 w-3" />}
                    </span>
                    <span className="truncate">{partner.name}</span>
                  </button>
                );
              })}
            </div>

            {survivor && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                <p>
                  Merging <strong>{losers.map((l) => l.name).join(", ")}</strong> into{" "}
                  <strong>&quot;{survivor.name}&quot;</strong>:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    {previewFailed ? (
                      <span className="text-muted-foreground">
                        Could not count what will move. Everything pointing at{" "}
                        {losers.length === 1 ? "the merged partner" : "the merged partners"}{" "}
                        still moves to &quot;{survivor.name}&quot;.
                      </span>
                    ) : isLoadingPreview || !previewCounts ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Counting what will move…
                      </span>
                    ) : (
                      <>
                        {previewCounts.transactions} transaction
                        {previewCounts.transactions === 1 ? "" : "s"},{" "}
                        {previewCounts.files} file{previewCounts.files === 1 ? "" : "s"} and{" "}
                        {previewCounts.invoices} invoice
                        {previewCounts.invoices === 1 ? "" : "s"} move to &quot;
                        {survivor.name}&quot;.
                      </>
                    )}
                  </li>
                  <li>
                    &quot;{survivor.name}&quot; gains {losers.length} new alias
                    {losers.length === 1 ? "" : "es"} from the merged name
                    {losers.length === 1 ? "" : "s"}
                    {newAliasCount > 0 && ` and ${newAliasCount} more from their existing aliases`}
                    {newIbanCount > 0 && `, plus ${newIbanCount} new IBAN${newIbanCount === 1 ? "" : "s"}`}.
                  </li>
                  {gains.length > 0 && (
                    <li>
                      &quot;{survivor.name}&quot; gains its{" "}
                      {gains.map((g) => g.label).join(", ")} from{" "}
                      {Array.from(new Set(gains.map((g) => g.fromName))).join(", ")}.
                    </li>
                  )}
                </ul>
                <p className="font-medium text-destructive">This cannot be undone.</p>
              </div>
            )}

            {hasVatConflict && (
              <div className="space-y-2 rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/30">
                <p className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  These partners have different VAT IDs
                </p>
                <ul className="space-y-0.5 pl-6 text-muted-foreground">
                  {vatConflicts.map((conflict) => (
                    <li key={`${conflict.a.id}-${conflict.b.id}`}>
                      {conflict.a.name} ({conflict.a.vatId}) vs {conflict.b.name} (
                      {conflict.b.vatId})
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2 pt-1">
                  <Checkbox
                    checked={confirmVatConflict}
                    onCheckedChange={(checked) => setConfirmVatConflict(checked === true)}
                  />
                  <span>
                    I understand these partners have different VAT IDs and want to merge
                    them anyway.
                  </span>
                </label>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button onClick={handleConfirm} disabled={!canConfirm}>
                {isSubmitting ? "Merging…" : "Merge"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
