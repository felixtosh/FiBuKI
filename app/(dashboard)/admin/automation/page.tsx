"use client";

import { useState, useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bot,
  Building2,
  ChevronDown,
  Download,
  Edit,
  FileSearch,
  FileText,
  Files,
  FolderOpen,
  Globe,
  HelpCircle,
  Layers,
  List,
  Loader2,
  Mail,
  Monitor,
  Receipt,
  Search,
  Settings2,
  Sparkles,
  Tag,
  Users,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProtectedRoute } from "@/components/auth";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { callFunction } from "@/lib/firebase/callable";
import useSWR from "swr";

// =============================================================================
// TYPES (matching functions/src/automation/types.ts)
// =============================================================================

interface TriggerCondition {
  field: string;
  from?: unknown;
  to: unknown;
}

interface AutomationEffect {
  entity: string;
  fields: string[];
  action: "create" | "update" | "delete";
}

interface AutomationLearning {
  entity: string;
  fields: string[];
  description: string;
}

type AutomationCategory = "matching" | "learning" | "sync" | "search" | "cleanup";

interface FirestoreTrigger {
  type: "document_create" | "document_update" | "document_delete";
  collection: string;
  conditions?: TriggerCondition[];
}

interface CallableTrigger {
  type: "callable";
  regions?: string[];
}

interface ScheduledTrigger {
  type: "scheduled";
  schedule: string;
}

type AutomationTrigger = FirestoreTrigger | CallableTrigger | ScheduledTrigger;

interface AutomationData {
  id: string;
  name: string;
  description: string;
  trigger: AutomationTrigger;
  effects: AutomationEffect[];
  learns?: AutomationLearning[];
  config?: Record<string, number | string | boolean>;
  chains?: string[];
  icon?: string;
  category: AutomationCategory;
  aiPowered?: boolean;
}

interface AutomationGraph {
  nodes: { id: string; label: string; category: string; collection?: string }[];
  edges: { source: string; target: string }[];
}

interface GetAutomationsResponse {
  automations: AutomationData[];
  collections: string[];
  graph?: AutomationGraph;
  validation?: { valid: boolean; errors: string[] };
}

// =============================================================================
// ICON MAPPING
// =============================================================================

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Building2,
  Sparkles,
  Receipt,
  Globe,
  Tag,
  Search,
  Bot,
  FileSearch,
  Mail,
  FolderOpen,
  FileText,
  Monitor,
  Edit,
  Download,
  Zap,
  Layers,
};

function getIcon(iconName?: string) {
  if (!iconName) return HelpCircle;
  return iconMap[iconName] || HelpCircle;
}

// =============================================================================
// CATEGORY COLORS
// =============================================================================

const categoryColors: Record<AutomationCategory, string> = {
  matching: "#3b82f6",   // blue
  learning: "#8b5cf6",   // violet
  sync: "#22c55e",       // green
  search: "#f59e0b",     // amber
  cleanup: "#6b7280",    // gray
};

const categoryLabels: Record<AutomationCategory, string> = {
  matching: "Matching",
  learning: "Learning",
  sync: "Sync",
  search: "Search",
  cleanup: "Cleanup",
};

// =============================================================================
// ENTITY CONFIG (for graph nodes)
// =============================================================================

interface EntityConfig {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  label: string;
}

const entityConfig: Record<string, EntityConfig> = {
  transactions: { icon: Receipt, color: "#22c55e", label: "Transactions" },
  files: { icon: Files, color: "#3b82f6", label: "Files" },
  partners: { icon: Users, color: "#f59e0b", label: "Partners" },
  categories: { icon: Tag, color: "#8b5cf6", label: "Categories" },
  noReceiptCategories: { icon: Tag, color: "#6b7280", label: "No-Receipt Categories" },
};

// =============================================================================
// REACT FLOW CUSTOM NODES
// =============================================================================

function AutomationNode({ data }: { data: AutomationData }) {
  const Icon = getIcon(data.icon);
  const color = categoryColors[data.category];

  return (
    <div
      className="px-4 py-3 rounded-lg border-2 bg-card shadow-sm min-w-[180px] relative"
      style={{ borderColor: color }}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      {data.aiPowered && (
        <div className="absolute -top-2 -right-2 bg-violet-500 text-white rounded-full p-1" title="AI-powered">
          <Sparkles className="h-3 w-3" />
        </div>
      )}
      <div className="flex items-center gap-2">
        <div
          className="p-1.5 rounded-md"
          style={{ backgroundColor: `${color}20` }}
        >
          <span style={{ color }}><Icon className="h-4 w-4" /></span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{data.name}</div>
          <div className="text-xs text-muted-foreground">
            {data.trigger.type === "document_update" || data.trigger.type === "document_create"
              ? (data.trigger as FirestoreTrigger).collection
              : data.trigger.type}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}

interface EntityNodeData {
  entityId: string;
  label: string;
}

function EntityNode({ data }: { data: EntityNodeData }) {
  const config = entityConfig[data.entityId] || {
    icon: FolderOpen,
    color: "#6b7280",
    label: data.label
  };
  const Icon = config.icon;

  return (
    <div
      className="px-5 py-4 rounded-xl border-2 bg-card shadow-md min-w-[140px]"
      style={{ borderColor: config.color, backgroundColor: `${config.color}08` }}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex flex-col items-center gap-2">
        <div
          className="p-3 rounded-full"
          style={{ backgroundColor: `${config.color}20` }}
        >
          <span style={{ color: config.color }}>
            <Icon className="h-6 w-6" />
          </span>
        </div>
        <div className="font-semibold text-sm">{config.label}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = {
  automation: AutomationNode,
  entity: EntityNode,
};

// =============================================================================
// HELPERS
// =============================================================================

function isFirestoreTrigger(trigger: AutomationTrigger): trigger is FirestoreTrigger {
  return (
    trigger.type === "document_create" ||
    trigger.type === "document_update" ||
    trigger.type === "document_delete"
  );
}

// =============================================================================
// GRAPH VIEW
// =============================================================================

function AutomationGraphView({
  automations,
}: {
  automations: AutomationData[];
}) {
  // Collect all unique entities from triggers and effects
  const entities = useMemo(() => {
    const entitySet = new Set<string>();

    automations.forEach((a) => {
      // Add trigger collection as entity
      if (isFirestoreTrigger(a.trigger)) {
        entitySet.add(a.trigger.collection);
      }
      // Add effect entities
      a.effects.forEach((e) => {
        // Map entity names to collection names
        const collectionName = e.entity === "transaction" ? "transactions"
          : e.entity === "file" ? "files"
          : e.entity === "partner" ? "partners"
          : e.entity === "category" ? "categories"
          : e.entity;
        entitySet.add(collectionName);
      });
    });

    return Array.from(entitySet);
  }, [automations]);

  // Build nodes: entities on left/right, automations in middle
  const { initialNodes, initialEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // Position entities as trigger sources (left column)
    const triggerEntities = new Set<string>();
    automations.forEach((a) => {
      if (isFirestoreTrigger(a.trigger)) {
        triggerEntities.add(a.trigger.collection);
      }
    });

    // Position entities as effect targets (right column)
    const effectEntities = new Set<string>();
    automations.forEach((a) => {
      a.effects.forEach((e) => {
        const collectionName = e.entity === "transaction" ? "transactions"
          : e.entity === "file" ? "files"
          : e.entity === "partner" ? "partners"
          : e.entity === "category" ? "categories"
          : e.entity;
        effectEntities.add(collectionName);
      });
    });

    // Create entity nodes (left side - triggers)
    const leftEntities = Array.from(triggerEntities);
    leftEntities.forEach((entityId, index) => {
      nodes.push({
        id: `entity-trigger-${entityId}`,
        type: "entity",
        position: { x: 0, y: index * 150 },
        data: { entityId, label: entityId } as unknown as Record<string, unknown>,
      });
    });

    // Create automation nodes (middle)
    // Group by trigger collection for better layout
    const automationsByTrigger = new Map<string, AutomationData[]>();
    automations.forEach((a) => {
      const key = isFirestoreTrigger(a.trigger) ? a.trigger.collection : "other";
      if (!automationsByTrigger.has(key)) automationsByTrigger.set(key, []);
      automationsByTrigger.get(key)!.push(a);
    });

    let yOffset = 0;
    automationsByTrigger.forEach((autos) => {
      autos.forEach((automation, index) => {
        nodes.push({
          id: automation.id,
          type: "automation",
          position: { x: 280, y: yOffset + index * 90 },
          data: automation as unknown as Record<string, unknown>,
        });
      });
      yOffset += autos.length * 90 + 30;
    });

    // Create entity nodes (right side - effects)
    const rightEntities = Array.from(effectEntities);
    rightEntities.forEach((entityId, index) => {
      nodes.push({
        id: `entity-effect-${entityId}`,
        type: "entity",
        position: { x: 560, y: index * 150 },
        data: { entityId, label: entityId } as unknown as Record<string, unknown>,
      });
    });

    // Create edges: trigger entity -> automation
    let edgeIndex = 0;
    automations.forEach((a) => {
      if (isFirestoreTrigger(a.trigger)) {
        edges.push({
          id: `trigger-${edgeIndex++}`,
          source: `entity-trigger-${a.trigger.collection}`,
          target: a.id,
          animated: true,
          style: { stroke: "#94a3b8" },
          label: a.trigger.type.replace("document_", ""),
          labelStyle: { fontSize: 10, fill: "#64748b" },
          labelBgStyle: { fill: "white" },
        });
      }
    });

    // Create edges: automation -> effect entity
    automations.forEach((a) => {
      const seenEffects = new Set<string>();
      a.effects.forEach((e) => {
        const collectionName = e.entity === "transaction" ? "transactions"
          : e.entity === "file" ? "files"
          : e.entity === "partner" ? "partners"
          : e.entity === "category" ? "categories"
          : e.entity;
        // Only one edge per automation-entity pair
        if (!seenEffects.has(collectionName)) {
          seenEffects.add(collectionName);
          edges.push({
            id: `effect-${edgeIndex++}`,
            source: a.id,
            target: `entity-effect-${collectionName}`,
            animated: false,
            style: { stroke: "#22c55e", strokeDasharray: "5,5" },
            label: e.action,
            labelStyle: { fontSize: 10, fill: "#16a34a" },
            labelBgStyle: { fill: "white" },
          });
        }
      });
    });

    // Create edges: automation chains (automation -> automation)
    automations.forEach((a) => {
      if (a.chains) {
        a.chains.forEach((chainId) => {
          edges.push({
            id: `chain-${edgeIndex++}`,
            source: a.id,
            target: chainId,
            animated: true,
            style: { stroke: "#8b5cf6" },
            label: "chains",
            labelStyle: { fontSize: 10, fill: "#7c3aed" },
            labelBgStyle: { fill: "white" },
          });
        });
      }
    });

    return { initialNodes: nodes, initialEdges: edges };
  }, [automations, entities]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  return (
    <Card className="h-[700px]">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Layers className="h-5 w-5" />
          Automation Flow
        </CardTitle>
        <CardDescription>
          Entities trigger automations which affect other entities. Drag to rearrange.
        </CardDescription>
      </CardHeader>
      <CardContent className="h-[600px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          attributionPosition="bottom-left"
        >
          <Background />
          <Controls />
        </ReactFlow>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// LIST VIEW
// =============================================================================

function TriggerBadge({ trigger }: { trigger: AutomationTrigger }) {
  const typeLabels: Record<string, { color: string; label: string }> = {
    document_create: { color: "bg-green-100 text-green-800", label: "On Create" },
    document_update: { color: "bg-blue-100 text-blue-800", label: "On Update" },
    document_delete: { color: "bg-red-100 text-red-800", label: "On Delete" },
    callable: { color: "bg-purple-100 text-purple-800", label: "Callable" },
    scheduled: { color: "bg-amber-100 text-amber-800", label: "Scheduled" },
  };

  const v = typeLabels[trigger.type] || { color: "bg-gray-100 text-gray-800", label: trigger.type };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${v.color}`}>
      {v.label}
    </span>
  );
}

function CategoryBadge({ category }: { category: AutomationCategory }) {
  const color = categoryColors[category];
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ backgroundColor: `${color}20`, color }}
    >
      {categoryLabels[category]}
    </span>
  );
}

function AutomationCard({ automation }: { automation: AutomationData }) {
  const [isOpen, setIsOpen] = useState(false);
  const Icon = getIcon(automation.icon);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="border rounded-lg p-4">
        <CollapsibleTrigger className="w-full text-left">
          <div className="flex items-start gap-3">
            <div
              className="p-2 rounded-md shrink-0"
              style={{ backgroundColor: `${categoryColors[automation.category]}20` }}
            >
              <Icon
                className="h-5 w-5"
                style={{ color: categoryColors[automation.category] }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{automation.name}</span>
                <CategoryBadge category={automation.category} />
                <TriggerBadge trigger={automation.trigger} />
                {automation.aiPowered && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-800 inline-flex items-center gap-1">
                    <Sparkles className="h-3 w-3" />
                    AI
                  </span>
                )}
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground transition-transform ml-auto ${
                    isOpen ? "rotate-180" : ""
                  }`}
                />
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {automation.description}
              </p>
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-4 pt-4 border-t space-y-4">
            {/* Trigger Details */}
            {isFirestoreTrigger(automation.trigger) && automation.trigger.conditions && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Conditions
                </div>
                <div className="space-y-1">
                  {automation.trigger.conditions.map((cond, i) => (
                    <div key={i} className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {cond.field}: {String(cond.from ?? "*")} → {String(cond.to)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Effects */}
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                Effects
              </div>
              <div className="flex flex-wrap gap-2">
                {automation.effects.map((effect, i) => (
                  <TooltipProvider key={i}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="text-xs">
                          {effect.action} {effect.entity}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Fields: {effect.fields.join(", ")}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ))}
              </div>
            </div>

            {/* Learns */}
            {automation.learns && automation.learns.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Learns
                </div>
                <div className="space-y-1">
                  {automation.learns.map((learn, i) => (
                    <div key={i} className="text-sm">
                      <span className="font-medium">{learn.entity}.{learn.fields.join(", ")}</span>
                      <span className="text-muted-foreground"> - {learn.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Config */}
            {automation.config && Object.keys(automation.config).length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Configuration
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {Object.entries(automation.config).map(([key, value]) => (
                    <div key={key} className="flex justify-between">
                      <span className="text-muted-foreground">{key}</span>
                      <span className="font-mono">{String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Chains */}
            {automation.chains && automation.chains.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Chains To
                </div>
                <div className="flex flex-wrap gap-1">
                  {automation.chains.map((chain) => (
                    <Badge key={chain} variant="secondary" className="text-xs">
                      → {chain}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function AutomationListView({
  automations,
  collections,
}: {
  automations: AutomationData[];
  collections: string[];
}) {
  const byCollection = useMemo(() => {
    const grouped = new Map<string, AutomationData[]>();

    // Initialize all collections
    collections.forEach((c) => grouped.set(c, []));
    grouped.set("other", []);

    // Group automations
    automations.forEach((a) => {
      if (isFirestoreTrigger(a.trigger)) {
        const collection = a.trigger.collection;
        if (!grouped.has(collection)) grouped.set(collection, []);
        grouped.get(collection)!.push(a);
      } else {
        grouped.get("other")!.push(a);
      }
    });

    // Remove empty groups
    Array.from(grouped.entries()).forEach(([key, value]) => {
      if (value.length === 0) grouped.delete(key);
    });

    return grouped;
  }, [automations, collections]);

  return (
    <div className="space-y-6">
      {Array.from(byCollection.entries()).map(([collection, items]) => (
        <Card key={collection}>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FolderOpen className="h-5 w-5" />
              {collection}
              <Badge variant="secondary" className="ml-2">
                {items.length}
              </Badge>
            </CardTitle>
            <CardDescription>
              Automations triggered by changes to the {collection} collection
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {items.map((automation) => (
              <AutomationCard key={automation.id} automation={automation} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export default function AdminAutomationPage() {
  const [view, setView] = useState<"graph" | "list">("list");

  // Fetch automations from callable
  const { data, error, isLoading } = useSWR<GetAutomationsResponse>(
    "getAutomations",
    () =>
      callFunction("getAutomations", {
        includeGraph: true,
        includeValidation: true,
      }),
    { revalidateOnFocus: false }
  );

  const automations = data?.automations || [];
  const collections = data?.collections || [];
  const graph = data?.graph;
  const validation = data?.validation;

  return (
    <ProtectedRoute requireAdmin>
      <div className="h-full overflow-auto p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold">Automation Registry</h1>
              <p className="text-sm text-muted-foreground mt-1">
                All automations registered in the system
              </p>
            </div>
            <div className="flex items-center gap-4">
              <Tabs value={view} onValueChange={(v) => setView(v as "graph" | "list")}>
                <TabsList>
                  <TabsTrigger value="list" className="gap-2">
                    <List className="h-4 w-4" />
                    List
                  </TabsTrigger>
                  <TabsTrigger value="graph" className="gap-2">
                    <Layers className="h-4 w-4" />
                    Graph
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold">
                  {isLoading ? "..." : automations.length}
                </div>
                <p className="text-xs text-muted-foreground">Automations</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold">
                  {isLoading ? "..." : collections.length}
                </div>
                <p className="text-xs text-muted-foreground">Collections</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold">
                  {isLoading
                    ? "..."
                    : automations.filter((a) => a.category === "matching").length}
                </div>
                <p className="text-xs text-muted-foreground">Matching</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold">
                  {isLoading
                    ? "..."
                    : automations.filter((a) => a.learns && a.learns.length > 0).length}
                </div>
                <p className="text-xs text-muted-foreground">Learning</p>
              </CardContent>
            </Card>
          </div>

          {/* Validation Warning */}
          {validation && !validation.valid && (
            <Card className="border-amber-500 bg-amber-50">
              <CardContent className="pt-6">
                <div className="text-amber-800 font-medium mb-2">
                  Chain Validation Errors
                </div>
                <ul className="text-sm text-amber-700 space-y-1">
                  {validation.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Loading State */}
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Error State */}
          {error && (
            <Card className="border-red-500">
              <CardContent className="pt-6 text-red-600">
                Failed to load automations: {error.message}
              </CardContent>
            </Card>
          )}

          {/* Content */}
          {!isLoading && !error && (
            <>
              {view === "graph" && (
                <AutomationGraphView automations={automations} />
              )}
              {view === "list" && (
                <AutomationListView
                  automations={automations}
                  collections={collections}
                />
              )}
            </>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
}
