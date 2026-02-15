"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  Inbox,
  Loader2,
  Trash2,
  RefreshCw,
  AlertCircle,
  Check,
  Clock,
  Pause,
  Play,
  Copy,
  FileText,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useEmailInbound, useInboundEmailLogs } from "@/hooks/use-email-inbound";
import { cn } from "@/lib/utils";

export default function EmailInboundDetailPage() {
  const router = useRouter();
  const {
    addresses,
    loading,
    error,
    primaryAddress,
    updateAddress,
    regenerateAddress,
    deleteAddress,
    pauseAddress,
    resumeAddress,
  } = useEmailInbound();
  const { logs, loading: logsLoading } = useInboundEmailLogs(primaryAddress?.id || null);

  const [copiedEmail, setCopiedEmail] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);

  const handleCopyEmail = async () => {
    if (primaryAddress?.email) {
      await navigator.clipboard.writeText(primaryAddress.email);
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 2000);
    }
  };

  const handleRegenerate = async () => {
    if (!primaryAddress) return;
    setRegenerating(true);
    try {
      await regenerateAddress(primaryAddress.id);
    } catch {
      // Error handled by hook
    } finally {
      setRegenerating(false);
    }
  };

  const handleDelete = async () => {
    if (!primaryAddress) return;
    setDeleting(true);
    try {
      await deleteAddress(primaryAddress.id);
      router.push("/settings/integrations");
    } catch {
      // Error handled by hook
    } finally {
      setDeleting(false);
    }
  };

  const handlePause = async () => {
    if (!primaryAddress) return;
    setPausing(true);
    try {
      await pauseAddress(primaryAddress.id);
    } catch {
      // Error handled by hook
    } finally {
      setPausing(false);
    }
  };

  const handleResume = async () => {
    if (!primaryAddress) return;
    setResuming(true);
    try {
      await resumeAddress(primaryAddress.id);
    } catch {
      // Error handled by hook
    } finally {
      setResuming(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!primaryAddress) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Button variant="ghost" onClick={() => router.push("/settings/integrations")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Integrations
        </Button>
        <div className="mt-8 text-center text-muted-foreground">
          <Inbox className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>No forwarding address configured</p>
          <Button className="mt-4" onClick={() => router.push("/settings/integrations")}>
            Go to Integrations
          </Button>
        </div>
      </div>
    );
  }

  const isPaused = !primaryAddress.isActive;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" onClick={() => router.push("/settings/integrations")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-purple-100 flex items-center justify-center">
                <Inbox className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <h1 className="text-lg font-semibold">Email Forwarding</h1>
                <p className="text-sm text-muted-foreground">
                  Forward invoices to your unique email address
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isPaused ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleResume}
                disabled={resuming}
              >
                {resuming ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Resume
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handlePause}
                disabled={pausing}
              >
                {pausing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Pause className="h-4 w-4 mr-2" />
                )}
                Pause
              </Button>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Forwarding Address?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete your email forwarding address.
                    Any emails sent to this address will no longer be processed.
                    Existing files will be preserved.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    disabled={deleting}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Email Address Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your Forwarding Address</CardTitle>
            <CardDescription>
              Forward invoices from any email client to this address
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <code className="flex-1 font-medium text-sm bg-muted px-4 py-3 rounded-lg">
                {primaryAddress.email}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyEmail}
              >
                {copiedEmail ? (
                  <>
                    <Check className="h-4 w-4 mr-2 text-green-500" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-2" />
                    Copy
                  </>
                )}
              </Button>
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-2">
                {isPaused ? (
                  <Badge variant="warning" className="text-xs">
                    <Pause className="h-3 w-3 mr-1" />
                    Paused
                  </Badge>
                ) : (
                  <Badge variant="success" className="text-xs">
                    <Check className="h-3 w-3 mr-1" />
                    Active
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  Created {formatDistanceToNow(primaryAddress.createdAt.toDate(), { addSuffix: true })}
                </span>
              </div>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Regenerate Address
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Regenerate Address?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will create a new email address and deactivate the current one.
                      Any emails sent to the old address will no longer be processed.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleRegenerate} disabled={regenerating}>
                      {regenerating ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : null}
                      Regenerate
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>

        {/* Stats Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-2xl font-bold">{primaryAddress.emailsReceived}</div>
                <div className="text-xs text-muted-foreground">Emails Received</div>
              </div>
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-2xl font-bold">{primaryAddress.filesCreated}</div>
                <div className="text-xs text-muted-foreground">Files Created</div>
              </div>
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-2xl font-bold">
                  {primaryAddress.todayDate === new Date().toISOString().split("T")[0]
                    ? primaryAddress.todayCount
                    : 0}
                </div>
                <div className="text-xs text-muted-foreground">Today</div>
              </div>
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-2xl font-bold">{primaryAddress.dailyLimit}</div>
                <div className="text-xs text-muted-foreground">Daily Limit</div>
              </div>
            </div>

            {primaryAddress.lastEmailAt && (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                Last email received {formatDistanceToNow(primaryAddress.lastEmailAt.toDate(), { addSuffix: true })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Emails Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Emails</CardTitle>
            <CardDescription>
              Emails received at your forwarding address
            </CardDescription>
          </CardHeader>
          <CardContent>
            {logsLoading ? (
              <div className="text-center py-8">
                <Loader2 className="h-6 w-6 mx-auto animate-spin text-muted-foreground" />
              </div>
            ) : logs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Mail className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>No emails received yet</p>
                <p className="text-sm mt-1">
                  Forward an invoice to {primaryAddress.email} to get started
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.slice(0, 20).map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium max-w-[200px] truncate">
                        {log.subject}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[150px] truncate">
                        {log.fromName || log.from}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(log.receivedAt.toDate(), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell>
                        {log.status === "completed" ? (
                          <Badge variant="secondary" className="text-xs">
                            <Check className="h-3 w-3 mr-1" />
                            Processed
                          </Badge>
                        ) : log.status === "rejected" ? (
                          <Badge variant="destructive" className="text-xs">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            {log.rejectionReason || "Rejected"}
                          </Badge>
                        ) : log.status === "failed" ? (
                          <Badge variant="destructive" className="text-xs">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            Failed
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            Processing
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-sm">{log.filesCreated.length}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* How to Use Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How to Use</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                1
              </div>
              <div>
                <p className="font-medium">Forward invoices</p>
                <p className="text-sm text-muted-foreground">
                  Forward any invoice email to your unique address above
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                2
              </div>
              <div>
                <p className="font-medium">Automatic processing</p>
                <p className="text-sm text-muted-foreground">
                  Attachments are extracted and the email body is converted to PDF
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                3
              </div>
              <div>
                <p className="font-medium">Match to transactions</p>
                <p className="text-sm text-muted-foreground">
                  Files are automatically matched to your bank transactions
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
