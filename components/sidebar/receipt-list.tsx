"use client";

import { useState, useEffect } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { Receipt } from "@/types/receipt";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileImage, FileText, Download, ExternalLink } from "lucide-react";
import { useFileObjectUrl } from "@/hooks/use-file-object-url";

interface ReceiptListProps {
  receiptIds: string[];
  transactionId: string;
}

function ReceiptPreview({ receiptId }: { receiptId: string }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  // Stored url -> renderable/downloadable url. On the self-host stack it needs an
  // Authorization header, so it cannot be an <img> src or an <a href> directly.
  // See hooks/use-file-object-url.ts.
  const fileUrl = useFileObjectUrl(receipt?.downloadUrl).url;

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, "receipts", receiptId), (snapshot) => {
      if (snapshot.exists()) {
        setReceipt({ id: snapshot.id, ...snapshot.data() } as Receipt);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [receiptId]);

  if (loading) {
    return (
      <Card className="p-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded" />
          <div className="flex-1">
            <Skeleton className="h-4 w-32 mb-2" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </Card>
    );
  }

  if (!receipt) return null;

  const isImage = receipt.fileType.startsWith("image/");
  const isPdf = receipt.fileType === "application/pdf";

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Card className="p-3 hover:bg-muted/50 transition-colors">
      <div className="flex items-start gap-3">
        {/* Thumbnail or icon */}
        <div className="relative h-12 w-12 rounded overflow-hidden bg-muted flex items-center justify-center flex-shrink-0">
          {isImage && !imageError ? (
            <img
              src={fileUrl ?? undefined}
              alt={receipt.fileName}
              className="h-full w-full object-cover"
              onError={() => setImageError(true)}
            />
          ) : isPdf ? (
            <FileText className="h-6 w-6 text-red-500" />
          ) : (
            <FileImage className="h-6 w-6 text-blue-500" />
          )}
        </div>

        {/* File info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{receipt.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {formatFileSize(receipt.fileSize)}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
            <a
              href={fileUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
            <a href={fileUrl ?? undefined} download={receipt.fileName}>
              <Download className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function ReceiptList({ receiptIds, transactionId }: ReceiptListProps) {
  return (
    <div className="space-y-3 mb-4">
      {receiptIds.map((receiptId) => (
        <ReceiptPreview key={receiptId} receiptId={receiptId} />
      ))}
    </div>
  );
}
