"use client";

import { useState } from "react";
import {
  Search,
  Plus,
  Trash2,
  Edit,
  Upload,
  Download,
  Check,
  X,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Building2,
  CreditCard,
  Mail,
  Calendar,
  Filter,
  MoreHorizontal,
  Eye,
  Link2,
  AlertCircle,
  Info,
  Sparkles,
  Loader2,
  History,
  Globe,
  AlertTriangle,
  Receipt,
  ExternalLink,
} from "lucide-react";

// UI Primitives
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pill } from "@/components/ui/pill";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";

// Detail Panel Primitives (CANONICAL)
import {
  PanelHeader,
  PanelContainer,
  PanelContent,
  PanelFooter,
  FieldRow,
  SectionHeader,
  CollapsibleListSection,
  ListItem,
  EmptyState,
  SectionDivider,
} from "@/components/ui/detail-panel-primitives";

// Complex UI
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ContentOverlay } from "@/components/ui/content-overlay";
import { AmountMatchDisplay } from "@/components/ui/amount-match-display";

// Navigation sections
const sections = [
  { id: "foundations", label: "Foundations", children: [
    { id: "colors", label: "Colors" },
    { id: "typography", label: "Typography" },
    { id: "spacing", label: "Spacing" },
  ]},
  { id: "primitives", label: "Primitives", children: [
    { id: "buttons", label: "Buttons" },
    { id: "badges-pills", label: "Badges & Pills" },
    { id: "inputs", label: "Form Inputs" },
    { id: "selections", label: "Selections" },
  ]},
  { id: "layout", label: "Layout", children: [
    { id: "cards", label: "Cards" },
    { id: "panels", label: "Detail Panels" },
    { id: "tables", label: "Data Tables" },
  ]},
  { id: "overlays", label: "Overlays", children: [
    { id: "dialogs", label: "Dialogs" },
    { id: "sheets", label: "Sheets" },
    { id: "popovers", label: "Popovers" },
    { id: "content-overlay", label: "Content Overlay" },
  ]},
  { id: "patterns", label: "Patterns", children: [
    { id: "transaction-detail", label: "Transaction Detail" },
    { id: "toolbar-filters", label: "Toolbar & Filters" },
    { id: "amount-display", label: "Amount Display" },
    { id: "file-connection", label: "File Connection" },
  ]},
  { id: "consolidation", label: "Consolidation", children: [
    { id: "redundancies", label: "Identified Redundancies" },
  ]},
];

function Section({
  id,
  title,
  description,
  canonical,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  canonical?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 pb-12 border-b last:border-0">
      <div className="mb-6">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
        {canonical && (
          <code className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded mt-2 inline-block">
            {canonical}
          </code>
        )}
      </div>
      <div className="space-y-8">{children}</div>
    </section>
  );
}

function ComponentGroup({
  title,
  code,
  children,
}: {
  title: string;
  code?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {code && (
          <code className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
            {code}
          </code>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </div>
  );
}

function RedundancyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md p-3 text-sm">
      <div className="flex gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="text-amber-800 dark:text-amber-200">{children}</div>
      </div>
    </div>
  );
}

function CanonicalNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-md p-3 text-sm">
      <div className="flex gap-2">
        <Check className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
        <div className="text-green-800 dark:text-green-200">{children}</div>
      </div>
    </div>
  );
}

export default function DesignSystemPage() {
  const [searchValue, setSearchValue] = useState("");
  const [showOverlay, setShowOverlay] = useState(false);
  const [activeSection, setActiveSection] = useState("colors");
  const [demoSheetOpen, setDemoSheetOpen] = useState(false);

  const scrollToSection = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <TooltipProvider>
      <div className="flex h-full">
        {/* Sidebar Navigation */}
        <nav className="w-52 border-r bg-muted/20 overflow-y-auto shrink-0">
          <div className="p-4 border-b">
            <h1 className="font-semibold">Design System</h1>
            <p className="text-xs text-muted-foreground mt-0.5">FiBuKI Stylekit v1.0</p>
          </div>
          <div className="p-2">
            {sections.map((group) => (
              <div key={group.id} className="mb-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.children.map((section) => (
                    <button
                      key={section.id}
                      onClick={() => scrollToSection(section.id)}
                      className={`w-full text-left px-2 py-1 rounded text-sm transition-colors ${
                        activeSection === section.id
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto p-8 space-y-12">

            {/* ============================================================
                FOUNDATIONS
            ============================================================ */}

            <Section
              id="colors"
              title="Color Tokens"
              description="Semantic color system using CSS variables"
            >
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { name: "background", class: "bg-background border" },
                  { name: "foreground", class: "bg-foreground" },
                  { name: "primary", class: "bg-primary" },
                  { name: "secondary", class: "bg-secondary" },
                  { name: "muted", class: "bg-muted" },
                  { name: "accent", class: "bg-accent" },
                  { name: "destructive", class: "bg-destructive" },
                  { name: "border", class: "border-2 border-border bg-transparent" },
                ].map((color) => (
                  <div key={color.name} className="space-y-1.5">
                    <div className={`h-12 rounded-md ${color.class}`} />
                    <p className="text-xs font-mono text-muted-foreground">{color.name}</p>
                  </div>
                ))}
              </div>

              <ComponentGroup title="Semantic Amount Colors">
                <div className="flex gap-6 text-sm">
                  <div>
                    <span className="font-mono text-green-600 dark:text-green-400">+€1,234.56</span>
                    <p className="text-xs text-muted-foreground mt-0.5">Income (green-600)</p>
                  </div>
                  <div>
                    <span className="font-mono text-red-600 dark:text-red-400">-€567.89</span>
                    <p className="text-xs text-muted-foreground mt-0.5">Expense (red-600)</p>
                  </div>
                  <div>
                    <span className="font-mono text-amber-600 dark:text-amber-400">-€12.50</span>
                    <p className="text-xs text-muted-foreground mt-0.5">Mismatch (amber-600)</p>
                  </div>
                </div>
              </ComponentGroup>

              <ComponentGroup title="Info/Suggestion Colors">
                <div className="flex gap-4">
                  <div className="bg-info border-info-border text-info-foreground px-3 py-1.5 rounded-md text-sm border">
                    AI Suggestion
                  </div>
                  <div className="text-xs text-muted-foreground self-center">
                    Used for AI/ML suggestions throughout
                  </div>
                </div>
              </ComponentGroup>
            </Section>

            <Section id="typography" title="Typography Scale">
              <div className="space-y-4 border rounded-md p-4">
                <div className="flex items-baseline gap-4">
                  <span className="w-24 text-xs text-muted-foreground font-mono">2xl/bold</span>
                  <h1 className="text-2xl font-bold">Page Title</h1>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="w-24 text-xs text-muted-foreground font-mono">lg/semibold</span>
                  <h2 className="text-lg font-semibold">Panel Title</h2>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="w-24 text-xs text-muted-foreground font-mono">base/medium</span>
                  <h3 className="text-base font-medium">Card Title</h3>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="w-24 text-xs text-muted-foreground font-mono">sm</span>
                  <p className="text-sm">Body text and field values</p>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="w-24 text-xs text-muted-foreground font-mono">sm/muted</span>
                  <p className="text-sm text-muted-foreground">Labels and descriptions</p>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="w-24 text-xs text-muted-foreground font-mono">xs/upper</span>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Section Header</p>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="w-24 text-xs text-muted-foreground font-mono">mono</span>
                  <p className="font-mono text-sm">€1,234.56 / AT12345678</p>
                </div>
              </div>
            </Section>

            <Section id="spacing" title="Spacing System">
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <span className="w-20 text-xs font-mono text-muted-foreground">gap-1</span>
                  <div className="flex gap-1">
                    <div className="w-4 h-4 bg-primary rounded" />
                    <div className="w-4 h-4 bg-primary rounded" />
                  </div>
                  <span className="text-xs text-muted-foreground">Icon groups, tight elements</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="w-20 text-xs font-mono text-muted-foreground">gap-2</span>
                  <div className="flex gap-2">
                    <div className="w-4 h-4 bg-primary rounded" />
                    <div className="w-4 h-4 bg-primary rounded" />
                  </div>
                  <span className="text-xs text-muted-foreground">Button groups, toolbar items</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="w-20 text-xs font-mono text-muted-foreground">gap-3</span>
                  <div className="flex gap-3">
                    <div className="w-4 h-4 bg-primary rounded" />
                    <div className="w-4 h-4 bg-primary rounded" />
                  </div>
                  <span className="text-xs text-muted-foreground">Field rows, list items</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="w-20 text-xs font-mono text-muted-foreground">gap-4</span>
                  <div className="flex gap-4">
                    <div className="w-4 h-4 bg-primary rounded" />
                    <div className="w-4 h-4 bg-primary rounded" />
                  </div>
                  <span className="text-xs text-muted-foreground">Card spacing, section gaps</span>
                </div>
              </div>
            </Section>

            {/* ============================================================
                PRIMITIVES
            ============================================================ */}

            <Section
              id="buttons"
              title="Buttons"
              description="Interactive controls with variants and sizes"
              canonical="components/ui/button.tsx"
            >
              <ComponentGroup title="Variants" code="variant=">
                <Button variant="default">Default</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="link">Link</Button>
                <Button variant="destructive">Destructive</Button>
              </ComponentGroup>

              <ComponentGroup title="Sizes" code="size=">
                <Button size="lg">Large</Button>
                <Button size="default">Default</Button>
                <Button size="sm">Small</Button>
                <Button size="icon"><Plus className="h-4 w-4" /></Button>
              </ComponentGroup>

              <ComponentGroup title="With Icons (Standard Pattern)">
                <Button><Plus className="h-4 w-4 mr-2" />Add Item</Button>
                <Button variant="outline"><Upload className="h-4 w-4 mr-2" />Upload</Button>
                <Button variant="destructive"><Trash2 className="h-4 w-4 mr-2" />Delete</Button>
              </ComponentGroup>

              <ComponentGroup title="States">
                <Button disabled>Disabled</Button>
                <Button disabled><Loader2 className="h-4 w-4 mr-2 animate-spin" />Loading</Button>
              </ComponentGroup>

              <ComponentGroup title="Toolbar Icon Buttons">
                <div className="flex items-center gap-1 p-1 border rounded-md bg-muted/30">
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Separator orientation="vertical" className="h-6 mx-1" />
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </ComponentGroup>
            </Section>

            <Section
              id="badges-pills"
              title="Badges & Pills"
              description="Status indicators and interactive tags"
            >
              <ComponentGroup title="Badge Variants" code="components/ui/badge.tsx">
                <Badge>Default</Badge>
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="muted">Muted</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="destructive">Destructive</Badge>
              </ComponentGroup>

              <ComponentGroup title="Contextual Badges">
                <Badge className="bg-green-50 text-green-900 border-green-300 dark:bg-green-900/50 dark:text-green-200">Complete</Badge>
                <Badge className="bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/50 dark:text-amber-200">Pending</Badge>
                <Badge className="bg-blue-50 text-blue-900 border-blue-300 dark:bg-blue-900/50 dark:text-blue-200">Processing</Badge>
              </ComponentGroup>

              <CanonicalNote>
                <strong>Pill Component</strong> - Use <code>components/ui/pill.tsx</code> for interactive tags with icons, confidence scores, and remove actions.
              </CanonicalNote>

              <ComponentGroup title="Pill (Default)" code="components/ui/pill.tsx">
                <Pill label="Amazon.de" icon={Building2} />
                <Pill label="Bank Transfer" icon={CreditCard} />
                <Pill label="With Remove" icon={FileText} onRemove={() => {}} />
              </ComponentGroup>

              <ComponentGroup title="Pill (Suggestion/AI)" code='variant="suggestion"'>
                <Pill label="Amazon.de" icon={Sparkles} variant="suggestion" confidence={95} />
                <Pill label="Suggested Partner" variant="suggestion" confidence={87} onClick={() => {}} />
                <Pill label="Auto-matched" variant="suggestion" confidence={72} onRemove={() => {}} />
              </ComponentGroup>

              <RedundancyNote>
                <strong>PartnerPill redundancy:</strong> <code>components/partners/partner-pill.tsx</code> duplicates 80% of Pill logic. Should be consolidated by adding a <code>partnerType</code> prop to Pill.
              </RedundancyNote>
            </Section>

            <Section
              id="inputs"
              title="Form Inputs"
              description="Text inputs, search fields, and form controls"
            >
              <ComponentGroup title="Basic Input" code="components/ui/input.tsx">
                <div className="w-64"><Input placeholder="Enter text..." /></div>
                <div className="w-64"><Input placeholder="Disabled" disabled /></div>
              </ComponentGroup>

              <ComponentGroup title="Input with Label">
                <div className="w-64 space-y-2">
                  <Label htmlFor="demo">Label Text</Label>
                  <Input id="demo" placeholder="Input value" />
                  <p className="text-xs text-muted-foreground">Helper text</p>
                </div>
              </ComponentGroup>

              <ComponentGroup title="Search Input" code="components/ui/search-input.tsx">
                <div className="w-64">
                  <SearchInput value={searchValue} onChange={setSearchValue} placeholder="Search..." />
                </div>
              </ComponentGroup>

              <ComponentGroup title="Error State">
                <div className="w-64">
                  <Input className="border-destructive focus-visible:ring-destructive" placeholder="Error state" />
                  <p className="text-xs text-destructive mt-1">This field is required</p>
                </div>
              </ComponentGroup>
            </Section>

            <Section id="selections" title="Selection Controls">
              <ComponentGroup title="Checkbox" code="components/ui/checkbox.tsx">
                <div className="flex items-center gap-2">
                  <Checkbox id="c1" /><Label htmlFor="c1">Unchecked</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id="c2" defaultChecked /><Label htmlFor="c2">Checked</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id="c3" disabled /><Label htmlFor="c3" className="text-muted-foreground">Disabled</Label>
                </div>
              </ComponentGroup>

              <ComponentGroup title="Select" code="components/ui/select.tsx">
                <Select>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Option 1</SelectItem>
                    <SelectItem value="2">Option 2</SelectItem>
                    <SelectItem value="3">Option 3</SelectItem>
                  </SelectContent>
                </Select>
              </ComponentGroup>

              <ComponentGroup title="Filter Pill Pattern (Active/Inactive)">
                <Button variant="outline" size="sm"><Filter className="h-4 w-4 mr-2" />All</Button>
                <Button variant="secondary" size="sm">
                  <Check className="h-4 w-4 mr-2" />Has Receipt
                  <X className="h-3 w-3 ml-2" />
                </Button>
                <Button variant="outline" size="sm">Income</Button>
              </ComponentGroup>
            </Section>

            {/* ============================================================
                LAYOUT
            ============================================================ */}

            <Section
              id="cards"
              title="Cards"
              description="Container components for grouped content"
              canonical="components/ui/card.tsx"
            >
              <div className="grid md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Card Title</CardTitle>
                    <CardDescription>Card description</CardDescription>
                  </CardHeader>
                  <CardContent><p className="text-sm">Card content</p></CardContent>
                </Card>

                <Card className="border-dashed">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Debug Section</CardTitle>
                    <CardDescription>Dashed border for dev tools</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button variant="outline" size="sm">Action</Button>
                  </CardContent>
                </Card>
              </div>

              <ComponentGroup title="Interactive Card (clickable)">
                <Card className="w-64 cursor-pointer hover:border-primary transition-colors">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-muted-foreground" />
                      <CardTitle className="text-base">Main Account</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground font-mono">AT12 3456 7890 1234</p>
                    <p className="text-sm mt-1">245 transactions</p>
                  </CardContent>
                </Card>
              </ComponentGroup>
            </Section>

            <Section
              id="panels"
              title="Detail Panel Primitives"
              description="Canonical components for all detail panels (Transaction, File, Partner, Category)"
              canonical="components/ui/detail-panel-primitives.tsx"
            >
              <CanonicalNote>
                <strong>Use these primitives</strong> for all detail panels. They provide consistent header navigation, field layouts, collapsible sections, and empty states.
              </CanonicalNote>

              <ComponentGroup title="PanelHeader">
                <div className="w-full border rounded-md">
                  <PanelHeader
                    title="Transaction Details"
                    onClose={() => {}}
                    onNavigatePrevious={() => {}}
                    onNavigateNext={() => {}}
                    hasPrevious={true}
                    hasNext={true}
                  />
                </div>
              </ComponentGroup>

              <ComponentGroup title="FieldRow" code="labelWidth prop for alignment">
                <div className="w-full border rounded-md p-4 space-y-2">
                  <FieldRow label="Date" labelWidth="w-24">January 15, 2024</FieldRow>
                  <FieldRow label="Amount" labelWidth="w-24">
                    <span className="font-mono text-red-600">-€149.99</span>
                  </FieldRow>
                  <FieldRow label="Partner" labelWidth="w-24">
                    <Pill label="Amazon.de" icon={Building2} />
                  </FieldRow>
                </div>
              </ComponentGroup>

              <ComponentGroup title="SectionHeader">
                <SectionHeader>Connected Files</SectionHeader>
              </ComponentGroup>

              <ComponentGroup title="CollapsibleListSection">
                <div className="w-full border rounded-md p-4">
                  <CollapsibleListSection
                    title="Transactions"
                    icon={<Receipt className="h-4 w-4" />}
                    count={3}
                    defaultOpen={true}
                  >
                    <ListItem
                      title="Amazon Marketplace"
                      subtitle="Jan 15, 2024"
                      amount={-14999}
                      isNegative={true}
                    />
                    <ListItem
                      title="Salary Payment"
                      subtitle="Jan 14, 2024"
                      amount={350000}
                      isNegative={false}
                    />
                  </CollapsibleListSection>
                </div>
              </ComponentGroup>

              <ComponentGroup title="EmptyState">
                <div className="w-full border rounded-md">
                  <EmptyState
                    icon={<FileText className="h-8 w-8" />}
                    title="No files connected"
                    description="Upload or search for a receipt"
                    action={<Button size="sm"><Search className="h-4 w-4 mr-2" />Find Receipt</Button>}
                  />
                </div>
              </ComponentGroup>

              <CanonicalNote>
                <strong>FieldRow consolidated.</strong> All detail panels (transaction-details, file-detail-panel, partner-detail-panel) now use the shared <code>FieldRow</code> from <code>detail-panel-primitives.tsx</code>.
              </CanonicalNote>
            </Section>

            <Section
              id="tables"
              title="Data Tables"
              description="Virtualized tables with sortable columns"
            >
              <CanonicalNote>
                <strong>Column Factories:</strong> Use <code>components/ui/column-factories.tsx</code> for consistent date, currency, text, and action columns. Provides sorting, formatting, and color coding.
              </CanonicalNote>

              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"><Checkbox /></TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Partner</TableHead>
                      <TableHead>File</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell><Checkbox /></TableCell>
                      <TableCell className="text-muted-foreground text-sm">Jan 15</TableCell>
                      <TableCell className="text-sm">Amazon Marketplace</TableCell>
                      <TableCell><Pill label="Amazon.de" icon={Building2} /></TableCell>
                      <TableCell>
                        <AmountMatchDisplay
                          count={1}
                          countType="file"
                          primaryAmount={-14999}
                          primaryCurrency="EUR"
                          secondaryAmounts={[{ amount: 14999, currency: "EUR" }]}
                        />
                      </TableCell>
                      <TableCell className="text-right font-mono text-red-600">-€149.99</TableCell>
                    </TableRow>
                    <TableRow className="bg-muted/50" data-state="selected">
                      <TableCell><Checkbox checked /></TableCell>
                      <TableCell className="text-muted-foreground text-sm">Jan 14</TableCell>
                      <TableCell className="text-sm">Salary Payment</TableCell>
                      <TableCell><Pill label="Employer GmbH" icon={Building2} /></TableCell>
                      <TableCell>
                        <AmountMatchDisplay
                          count={0}
                          countType="file"
                          primaryAmount={350000}
                          primaryCurrency="EUR"
                          secondaryAmounts={[]}
                        />
                      </TableCell>
                      <TableCell className="text-right font-mono text-green-600">+€3,500.00</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell><Checkbox /></TableCell>
                      <TableCell className="text-muted-foreground text-sm">Jan 13</TableCell>
                      <TableCell className="text-sm">Office Supplies</TableCell>
                      <TableCell>
                        <Pill label="Staples" icon={Sparkles} variant="suggestion" confidence={85} />
                      </TableCell>
                      <TableCell>
                        <AmountMatchDisplay
                          count={1}
                          countType="file"
                          primaryAmount={-12750}
                          primaryCurrency="EUR"
                          secondaryAmounts={[{ amount: 10000, currency: "EUR" }]}
                        />
                      </TableCell>
                      <TableCell className="text-right font-mono text-red-600">-€127.50</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              <RedundancyNote>
                <strong>Column factories underutilized.</strong> Transaction and File columns implement inline formatting instead of using <code>dateColumn()</code> and <code>currencyColumn()</code> factories. ~150 lines could be removed.
              </RedundancyNote>
            </Section>

            {/* ============================================================
                OVERLAYS
            ============================================================ */}

            <Section
              id="dialogs"
              title="Dialogs"
              description="Modal windows for focused interactions"
              canonical="components/ui/dialog.tsx"
            >
              <ComponentGroup title="Standard Dialog">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">Open Dialog</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Dialog Title</DialogTitle>
                      <DialogDescription>Dialog description</DialogDescription>
                    </DialogHeader>
                    <div className="py-4"><Input placeholder="Enter value" /></div>
                    <DialogFooter>
                      <Button variant="outline">Cancel</Button>
                      <Button>Save</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </ComponentGroup>

              <ComponentGroup title="Alert Dialog (Destructive Confirmation)">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive">Delete</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                      <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </ComponentGroup>
            </Section>

            <Section
              id="sheets"
              title="Sheets (Side Panels)"
              description="Slide-in panels for detail views"
              canonical="components/ui/sheet.tsx"
            >
              <ComponentGroup title="Right Sheet (Detail Panel)">
                <Sheet open={demoSheetOpen} onOpenChange={setDemoSheetOpen}>
                  <SheetTrigger asChild>
                    <Button variant="outline">Open Sheet</Button>
                  </SheetTrigger>
                  <SheetContent>
                    <SheetHeader>
                      <SheetTitle>Transaction Details</SheetTitle>
                      <SheetDescription>View and edit</SheetDescription>
                    </SheetHeader>
                    <div className="py-4 space-y-4">
                      <FieldRow label="Amount" labelWidth="w-20">
                        <span className="font-mono text-lg">-€149.99</span>
                      </FieldRow>
                      <FieldRow label="Date" labelWidth="w-20">January 15, 2024</FieldRow>
                      <FieldRow label="Partner" labelWidth="w-20">
                        <Pill label="Amazon.de" icon={Building2} />
                      </FieldRow>
                    </div>
                  </SheetContent>
                </Sheet>
              </ComponentGroup>
            </Section>

            <Section
              id="popovers"
              title="Popovers & Dropdowns"
              description="Floating UI for contextual content"
            >
              <ComponentGroup title="Popover">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline"><Calendar className="h-4 w-4 mr-2" />Date Range</Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64">
                    <div className="space-y-2">
                      <h4 className="font-medium text-sm">Select Range</h4>
                      <div className="flex flex-wrap gap-1">
                        <Button variant="outline" size="sm">30 days</Button>
                        <Button variant="outline" size="sm">This month</Button>
                        <Button variant="outline" size="sm">This year</Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </ComponentGroup>

              <ComponentGroup title="Dropdown Menu">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem><Eye className="h-4 w-4 mr-2" />View</DropdownMenuItem>
                    <DropdownMenuItem><Edit className="h-4 w-4 mr-2" />Edit</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive"><Trash2 className="h-4 w-4 mr-2" />Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ComponentGroup>

              <ComponentGroup title="Tooltip">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon"><Info className="h-4 w-4" /></Button>
                  </TooltipTrigger>
                  <TooltipContent>Helpful tooltip</TooltipContent>
                </Tooltip>
              </ComponentGroup>
            </Section>

            <Section
              id="content-overlay"
              title="Content Overlay"
              description="Full-screen overlay for complex interactions (file viewer, connect dialog)"
              canonical="components/ui/content-overlay.tsx"
            >
              <ComponentGroup title="Content Overlay Demo">
                <Button variant="outline" onClick={() => setShowOverlay(true)}>Open Overlay</Button>
              </ComponentGroup>

              <div className="text-sm text-muted-foreground space-y-1">
                <p>Used for:</p>
                <ul className="list-disc list-inside">
                  <li>Connect File to Transaction (4-tab interface)</li>
                  <li>File Viewer (PDF/image preview)</li>
                  <li>Transaction History (edit log)</li>
                </ul>
              </div>
            </Section>

            {/* ============================================================
                PATTERNS (Transaction-first)
            ============================================================ */}

            <Section
              id="transaction-detail"
              title="Transaction Detail Pattern"
              description="Canonical layout for transaction detail panel"
            >
              <Card>
                <CardContent className="p-0">
                  {/* Header */}
                  <div className="flex items-center justify-between py-3 px-4 border-b">
                    <h2 className="text-lg font-semibold">Transaction Details</h2>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8"><ChevronUp className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><ChevronDown className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><X className="h-4 w-4" /></Button>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="p-4 space-y-4">
                    {/* Amount (prominent) */}
                    <div className="space-y-1">
                      <p className="text-2xl font-mono text-red-600">-€149.99</p>
                      <p className="text-sm text-muted-foreground">January 15, 2024</p>
                    </div>

                    <Separator />

                    {/* Fields */}
                    <div className="space-y-3">
                      <FieldRow label="Description" labelWidth="w-24">Amazon Marketplace Order #123-456</FieldRow>
                      <FieldRow label="Reference" labelWidth="w-24" className="text-muted-foreground">SEPA-2024-001</FieldRow>
                      <FieldRow label="Account" labelWidth="w-24">
                        <div className="flex items-center gap-2">
                          <span>Main Account</span>
                          <Tooltip>
                            <TooltipTrigger>
                              <span className="text-xs text-muted-foreground font-mono">...5678</span>
                            </TooltipTrigger>
                            <TooltipContent>AT12 3456 7890 1234 5678</TooltipContent>
                          </Tooltip>
                        </div>
                      </FieldRow>
                    </div>

                    <Separator />

                    {/* Partner Section */}
                    <div className="space-y-2">
                      <SectionHeader>Partner</SectionHeader>
                      <div className="flex items-center gap-2">
                        <Pill label="Amazon.de" icon={Building2} onRemove={() => {}} />
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    <Separator />

                    {/* Files Section */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <SectionHeader>Connected Files</SectionHeader>
                        <Button variant="ghost" size="sm" className="h-7">
                          <Search className="h-3.5 w-3.5 mr-1.5" />Find Receipt
                        </Button>
                      </div>
                      <div className="border rounded-md p-3 flex items-center gap-3 hover:bg-muted/50 cursor-pointer">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">invoice-2024-001.pdf</p>
                          <p className="text-xs text-muted-foreground">€149.99 incl. 20% VAT</p>
                        </div>
                        <Badge variant="outline" className="text-green-600 border-green-200">
                          <Check className="h-3 w-3 mr-1" />Match
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="border-t px-4 py-2 flex justify-end">
                    <Button variant="ghost" size="sm"><History className="h-4 w-4 mr-2" />Edit History</Button>
                  </div>
                </CardContent>
              </Card>
            </Section>

            <Section
              id="toolbar-filters"
              title="Toolbar & Filter Pattern"
              description="Consistent filter toolbar used on table pages"
            >
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SearchInput value="" onChange={() => {}} placeholder="Search..." className="w-48" />

                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Calendar className="h-4 w-4 mr-2" />Date Range
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent>Date picker</PopoverContent>
                    </Popover>

                    <Button variant="secondary" size="sm">
                      Has Receipt<X className="h-3 w-3 ml-2" />
                    </Button>

                    <Button variant="outline" size="sm">
                      <Filter className="h-4 w-4 mr-2" />More
                    </Button>

                    <div className="flex-1" />

                    <Button size="sm"><Plus className="h-4 w-4 mr-2" />Add</Button>
                  </div>
                </CardContent>
              </Card>

              <RedundancyNote>
                <strong>4 different toolbar implementations</strong> with varying complexity. Transaction toolbar is 520 lines. Consider extracting reusable <code>FilterPill</code> and <code>DateRangeFilter</code> components.
              </RedundancyNote>
            </Section>

            <Section
              id="amount-display"
              title="Amount Match Display"
              description="Shows file/transaction matching status with currency handling"
              canonical="components/ui/amount-match-display.tsx"
            >
              <ComponentGroup title="Match States">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-4">
                    <AmountMatchDisplay count={1} countType="file" primaryAmount={-14999} primaryCurrency="EUR" secondaryAmounts={[{ amount: 14999, currency: "EUR" }]} />
                    <span className="text-sm text-muted-foreground">Exact match (green check)</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <AmountMatchDisplay count={1} countType="file" primaryAmount={-14999} primaryCurrency="EUR" secondaryAmounts={[{ amount: 12000, currency: "EUR" }]} />
                    <span className="text-sm text-muted-foreground">Underpaid (red, shows difference)</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <AmountMatchDisplay count={2} countType="file" primaryAmount={-14999} primaryCurrency="EUR" secondaryAmounts={[{ amount: 10000, currency: "EUR" }, { amount: 7000, currency: "EUR" }]} />
                    <span className="text-sm text-muted-foreground">Overpaid (amber, shows excess)</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <AmountMatchDisplay count={0} countType="file" primaryAmount={-14999} primaryCurrency="EUR" secondaryAmounts={[]} />
                    <span className="text-sm text-muted-foreground">No files (icon only)</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <AmountMatchDisplay count={1} countType="file" primaryAmount={-14999} primaryCurrency="EUR" secondaryAmounts={[]} isExtracting />
                    <span className="text-sm text-muted-foreground">Extracting (spinner)</span>
                  </div>
                </div>
              </ComponentGroup>
            </Section>

            <Section
              id="file-connection"
              title="File Connection Pattern"
              description="4-tab overlay for connecting receipts to transactions"
            >
              <Card>
                <CardContent className="p-4">
                  <Tabs defaultValue="files">
                    <TabsList>
                      <TabsTrigger value="files">Files</TabsTrigger>
                      <TabsTrigger value="gmail">Gmail</TabsTrigger>
                      <TabsTrigger value="email">Email-to-PDF</TabsTrigger>
                      <TabsTrigger value="browser">Browser</TabsTrigger>
                    </TabsList>
                    <TabsContent value="files" className="mt-4">
                      <SearchInput value="" onChange={() => {}} placeholder="Search files..." />
                      <div className="mt-3 space-y-2">
                        <div className="p-3 border rounded-md hover:bg-muted/50 cursor-pointer">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm">invoice-amazon.pdf</span>
                            <Badge variant="outline" className="ml-auto text-xs">95%</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">€149.99 - Amount match</p>
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </Section>

            {/* ============================================================
                CONSOLIDATION
            ============================================================ */}

            <Section
              id="redundancies"
              title="Identified Redundancies"
              description="Components that should be consolidated"
            >
              <div className="space-y-4">
                <Card className="border-green-200 dark:border-green-800">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-green-800 dark:text-green-200 flex items-center gap-2">
                      <Check className="h-4 w-4" />
                      1. FieldRow Implementations (DONE)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <p><strong>Files updated:</strong> transaction-details.tsx, file-detail-panel.tsx, partner-detail-panel.tsx</p>
                    <p><strong>Impact:</strong> ~50 lines removed, now using shared primitive</p>
                    <p><strong>Solution:</strong> All now use <code>FieldRow</code> from <code>detail-panel-primitives.tsx</code></p>
                  </CardContent>
                </Card>

                <Card className="border-amber-200 dark:border-amber-800">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-amber-800 dark:text-amber-200">2. Pill vs PartnerPill (HIGH)</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <p><strong>Files:</strong> pill.tsx, partner-pill.tsx</p>
                    <p><strong>Impact:</strong> 80% code duplication (~80 lines)</p>
                    <p><strong>Solution:</strong> Add <code>partnerType</code> prop to Pill, deprecate PartnerPill</p>
                  </CardContent>
                </Card>

                <Card className="border-amber-200 dark:border-amber-800">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-amber-800 dark:text-amber-200">3. Amount Formatting (HIGH)</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <p><strong>Files:</strong> transaction-columns, file-columns, amount-match-display</p>
                    <p><strong>Impact:</strong> Inconsistent formatting, ~100 duplicate lines</p>
                    <p><strong>Solution:</strong> Use <code>currencyColumn()</code> factory and <code>formatCurrency()</code> utility</p>
                  </CardContent>
                </Card>

                <Card className="border-yellow-200 dark:border-yellow-800">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-yellow-800 dark:text-yellow-200">4. Column Factories Not Adopted (MEDIUM)</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <p><strong>Available:</strong> dateColumn(), currencyColumn(), textColumn(), actionsColumn()</p>
                    <p><strong>Not using:</strong> transaction-columns.tsx, file-columns.tsx</p>
                    <p><strong>Impact:</strong> ~150 lines could be removed</p>
                  </CardContent>
                </Card>

                <Card className="border-yellow-200 dark:border-yellow-800">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-yellow-800 dark:text-yellow-200">5. File Upload Zones (MEDIUM)</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <p><strong>Files:</strong> files/file-upload-zone.tsx, sidebar/file-upload-zone.tsx</p>
                    <p><strong>Issue:</strong> Different integration patterns for same functionality</p>
                    <p><strong>Solution:</strong> Unify with <code>mode</code> prop or shared hook</p>
                  </CardContent>
                </Card>

                <Card className="border-gray-200 dark:border-gray-700">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">6. Suggestion Styling (LOW)</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <p><strong>Issue:</strong> Mixed use of info (blue) and amber for suggestions</p>
                    <p><strong>Solution:</strong> Standardize on <code>info</code> semantic color</p>
                  </CardContent>
                </Card>
              </div>
            </Section>

          </div>

          {/* Content Overlay Demo */}
          <ContentOverlay
            open={showOverlay}
            onClose={() => setShowOverlay(false)}
            title="Connect Receipt"
            subtitle="Transaction: Amazon -€149.99"
            headerActions={<Button variant="ghost" size="sm"><Mail className="h-4 w-4 mr-2" />Search Email</Button>}
          >
            <div className="flex h-full">
              <div className="w-80 border-r p-4">
                <Tabs defaultValue="files">
                  <TabsList className="w-full">
                    <TabsTrigger value="files" className="flex-1">Files</TabsTrigger>
                    <TabsTrigger value="email" className="flex-1">Gmail</TabsTrigger>
                  </TabsList>
                  <TabsContent value="files" className="mt-4">
                    <SearchInput value="" onChange={() => {}} placeholder="Search..." />
                    <div className="mt-4 space-y-2">
                      <div className="p-3 border rounded-md hover:bg-muted/50 cursor-pointer">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">invoice-amazon.pdf</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">€149.99 - 95% match</p>
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
              <div className="flex-1 flex items-center justify-center bg-muted/30">
                <div className="text-center text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>Select a file to preview</p>
                </div>
              </div>
            </div>
          </ContentOverlay>
        </main>
      </div>
    </TooltipProvider>
  );
}
