"use client";

import { useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/components/auth";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Play,
  CheckCircle,
  XCircle,
  Clock,
  ExternalLink,
  Terminal,
  MessageSquare,
  RefreshCw,
  Wrench,
  MessageCircle,
  AlertTriangle,
  MessagesSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TestCaseResult {
  testCase: {
    id: string;
    name: string;
    category: string;
    tags?: string[];
  };
  passed: boolean;
  duration: number;
  response?: string;
  toolsCalled?: string[];
  evaluation: {
    toolCallsCorrect: boolean;
    containsExpected: boolean;
    noUnexpectedContent: boolean;
    details: string[];
  };
  error?: string;
  langfuseTraceId?: string;
}

interface TestRunResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  passRate: number;
  results: TestCaseResult[];
  langfuseUrl?: string;
}

type TestCategory = "all" | "tool-calling" | "response-quality" | "error-handling" | "conversation";

const chatTestCategories = [
  { id: "all" as TestCategory, label: "All Tests", icon: MessageSquare },
  { id: "tool-calling" as TestCategory, label: "Tool Calling", icon: Wrench },
  { id: "response-quality" as TestCategory, label: "Response Quality", icon: MessageCircle },
  { id: "error-handling" as TestCategory, label: "Error Handling", icon: AlertTriangle },
  { id: "conversation" as TestCategory, label: "Conversation", icon: MessagesSquare },
];

export default function TestingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const activeCategory = (searchParams.get("category") as TestCategory) || "all";
  const showCloudFunctions = searchParams.get("type") === "cloud-functions";

  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedTest, setExpandedTest] = useState<string | null>(null);

  const setActiveCategory = (category: TestCategory) => {
    router.push(`/admin/testing?category=${category}`);
  };

  const showCloudFunctionsView = () => {
    router.push(`/admin/testing?type=cloud-functions`);
    setResult(null);
    setError(null);
  };

  const runTests = useCallback(async (category: TestCategory) => {
    if (!user) {
      setError("Not authenticated");
      return;
    }

    setRunning(category);
    setError(null);
    setResult(null);

    // Navigate to show we're running this category
    router.push(`/admin/testing?category=${category}`);

    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/admin/tests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          suite: "chat",
          category: category === "all" ? undefined : category,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to run tests");
      }

      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRunning(null);
    }
  }, [router, user]);

  return (
    <div className="h-full flex overflow-hidden">
      {/* Sidebar */}
      <nav className="w-56 border-r bg-muted/30 p-4 shrink-0 overflow-y-auto">
        <h1 className="text-lg font-semibold mb-4">Tests</h1>

        {/* Chat Test Categories */}
        <div className="mb-6">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 px-3">
            Chat / AI
          </h2>
          <ul className="space-y-1">
            {chatTestCategories.map((item) => {
              const Icon = item.icon;
              const isActive = !showCloudFunctions && activeCategory === item.id;
              const isRunning = running === item.id;
              return (
                <li key={item.id}>
                  <div
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <button
                      onClick={() => setActiveCategory(item.id)}
                      className="flex items-center gap-2 flex-1 text-left"
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </button>
                    <Button
                      size="icon"
                      variant={isActive ? "secondary" : "ghost"}
                      className="h-6 w-6 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        runTests(item.id);
                      }}
                      disabled={running !== null}
                    >
                      {isRunning ? (
                        <RefreshCw className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Cloud Functions */}
        <div>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 px-3">
            Backend
          </h2>
          <ul className="space-y-1">
            <li>
              <button
                onClick={showCloudFunctionsView}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2",
                  showCloudFunctions
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                <Terminal className="h-4 w-4" />
                Cloud Functions
              </button>
            </li>
          </ul>
        </div>
      </nav>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6">
          {/* Chat Tests */}
          {!showCloudFunctions && (
            <>
              {/* Error Display */}
              {error && (
                <Card className="border-destructive">
                  <CardContent className="py-3">
                    <p className="text-destructive text-sm">{error}</p>
                  </CardContent>
                </Card>
              )}

              {/* Results */}
              {result && (
                <>
                  {/* Summary Row */}
                  <div className="flex items-center gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Total:</span>
                      <span className="font-semibold">{result.totalTests}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      <span className="font-semibold text-green-600">{result.passedTests}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <XCircle className="h-4 w-4 text-red-600" />
                      <span className={cn(
                        "font-semibold",
                        result.failedTests > 0 ? "text-red-600" : "text-muted-foreground"
                      )}>
                        {result.failedTests}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Pass Rate:</span>
                      <span className={cn(
                        "font-semibold",
                        result.passRate >= 0.8 ? "text-green-600" :
                        result.passRate >= 0.5 ? "text-yellow-600" : "text-red-600"
                      )}>
                        {(result.passRate * 100).toFixed(0)}%
                      </span>
                    </div>
                    {result.langfuseUrl && (
                      <a
                        href={result.langfuseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-primary hover:underline ml-auto"
                      >
                        <ExternalLink className="h-3 w-3" />
                        LangFuse
                      </a>
                    )}
                  </div>

                  {/* Results Table */}
                  <Card>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10"></TableHead>
                          <TableHead>Test</TableHead>
                          <TableHead>Category</TableHead>
                          <TableHead>Tools Called</TableHead>
                          <TableHead className="text-right w-24">Duration</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.results.map((testResult) => (
                          <>
                            <TableRow
                              key={testResult.testCase.id}
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => setExpandedTest(
                                expandedTest === testResult.testCase.id
                                  ? null
                                  : testResult.testCase.id
                              )}
                            >
                              <TableCell>
                                {testResult.passed ? (
                                  <CheckCircle className="h-4 w-4 text-green-600" />
                                ) : (
                                  <XCircle className="h-4 w-4 text-red-600" />
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="font-medium text-sm">{testResult.testCase.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  {testResult.testCase.id}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="secondary" className="text-xs">
                                  {testResult.testCase.category}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {testResult.toolsCalled?.map((tool) => (
                                    <Badge key={tool} variant="outline" className="text-xs">
                                      {tool}
                                    </Badge>
                                  ))}
                                  {(!testResult.toolsCalled || testResult.toolsCalled.length === 0) && (
                                    <span className="text-muted-foreground text-xs">None</span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-1 text-muted-foreground">
                                  <Clock className="h-3 w-3" />
                                  <span className="font-mono text-xs">
                                    {testResult.duration}ms
                                  </span>
                                </div>
                              </TableCell>
                            </TableRow>
                            {expandedTest === testResult.testCase.id && (
                              <TableRow>
                                <TableCell colSpan={5} className="bg-muted/30">
                                  <div className="p-4 space-y-3">
                                    <div>
                                      <h4 className="font-medium text-sm mb-2">Evaluation Details</h4>
                                      <ul className="space-y-1 text-sm">
                                        {testResult.evaluation.details.map((detail, i) => (
                                          <li key={i}>{detail}</li>
                                        ))}
                                      </ul>
                                    </div>
                                    {testResult.error && (
                                      <div>
                                        <h4 className="font-medium text-sm mb-2 text-destructive">Error</h4>
                                        <p className="text-sm text-destructive">{testResult.error}</p>
                                      </div>
                                    )}
                                    {testResult.response && (
                                      <div>
                                        <h4 className="font-medium text-sm mb-2">Response (truncated)</h4>
                                        <p className="text-sm text-muted-foreground bg-muted p-2 rounded max-h-32 overflow-auto">
                                          {testResult.response.slice(0, 500)}
                                          {testResult.response.length > 500 && "..."}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                </>
              )}

              {/* Empty state */}
              {!result && !error && !running && (
                <div className="text-center py-12 text-muted-foreground">
                  <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p className="text-sm">Select a test category and click the play button to run tests.</p>
                  <p className="text-xs mt-1">Results are logged to LangFuse for detailed analysis.</p>
                </div>
              )}

              {/* Running state */}
              {running && (
                <div className="text-center py-12 text-muted-foreground">
                  <RefreshCw className="h-12 w-12 mx-auto mb-4 animate-spin opacity-50" />
                  <p className="text-sm">Running tests...</p>
                </div>
              )}
            </>
          )}

          {/* Cloud Functions Tests */}
          {showCloudFunctions && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Unit and integration tests for the backend (functions/). Run via CLI.
              </p>
              <div className="p-4 bg-muted rounded-lg font-mono text-sm space-y-2">
                <div className="text-muted-foreground"># Run tests</div>
                <div className="text-foreground">cd functions && npm test</div>
                <div className="text-muted-foreground mt-3"># Self-host suite</div>
                <div className="text-foreground">npm run test:selfhost</div>
              </div>
              <p className="text-xs text-muted-foreground">
                Uses Vitest. On a small host, run one file at a time (see CLAUDE.md).
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
