"use client";

import { useState, useRef, useEffect } from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileCheck,
  FileText,
  FileX,
  Filter,
  Globe,
  History,
  Inbox,
  Link2,
  Loader2,
  Mail,
  Menu,
  MoreHorizontal,
  Pause,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  User,
  X,
  Building2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  AlertCircle,
  Info,
  Tag,
  Sparkles,
  Receipt,
  Landmark,
  PartyPopper,
} from "lucide-react";

// UI Primitives
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConnectButton } from "@/components/ui/connect-button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Pill } from "@/components/ui/pill";
import { AmountMatchDisplay } from "@/components/ui/amount-match-display";
import { PartnerPill } from "@/components/partners/partner-pill";
import { SearchButton } from "@/components/ui/search-button";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TableEmptyState, emptyStatePresets } from "@/components/ui/table-empty-state";
import { cn } from "@/lib/utils";

// Shared Primitives (Consolidated Patterns)
import {
  PanelHeader,
  PanelContainer,
  PanelContent,
  PanelFooter,
  FieldRow,
  SectionHeader as PanelSectionHeader,
  CollapsibleListSection,
  ListItem,
  EmptyState,
  SectionDivider,
  FileListItem,
} from "@/components/ui/detail-panel-primitives";
import { SettingsPageHeader } from "@/components/ui/settings-page-header";

// Navigation sections - reorganized for clarity
const sections = [
  { id: "colors", label: "Colors" },
  { id: "typography", label: "Typography" },
  { id: "buttons", label: "Buttons" },
  { id: "badges", label: "Badges & Pills" },
  { id: "forms", label: "Form Elements" },
  { id: "cards", label: "Cards & Panels" },
  { id: "table-patterns", label: "Table Patterns" },
  { id: "integrations", label: "Integration Items" },
  { id: "sidebar", label: "Sidebar & Chat" },
  { id: "dialogs", label: "Dialogs & Sheets" },
  { id: "feedback", label: "Feedback & Status" },
  { id: "overlays", label: "Overlays & Popovers" },
];

// Color palette from globals.css — grouped by purpose
const coreColors = [
  { name: "Background", var: "--color-background", className: "bg-background" },
  { name: "Foreground", var: "--color-foreground", className: "bg-foreground" },
  { name: "Primary", var: "--color-primary", className: "bg-primary" },
  { name: "Primary FG", var: "--color-primary-foreground", className: "bg-primary-foreground" },
  { name: "Secondary", var: "--color-secondary", className: "bg-secondary" },
  { name: "Muted", var: "--color-muted", className: "bg-muted" },
  { name: "Muted FG", var: "--color-muted-foreground", className: "bg-muted-foreground" },
  { name: "Destructive", var: "--color-destructive", className: "bg-destructive" },
  { name: "Border", var: "--color-border", className: "bg-border" },
];
const semanticColors = [
  { name: "Complete Row", var: "--color-complete-row", className: "bg-complete-row" },
  { name: "Complete Selected", var: "--color-complete-row-selected", className: "bg-complete-row-selected" },
  { name: "Amount +", var: "--color-amount-positive", className: "bg-amount-positive" },
  { name: "Amount −", var: "--color-amount-negative", className: "bg-amount-negative" },
  { name: "Info", var: "--color-info", className: "bg-info" },
  { name: "Info FG", var: "--color-info-foreground", className: "bg-info-foreground" },
  { name: "Highlight", var: "--color-highlight", className: "bg-highlight" },
];

function SectionHeader({ id, title }: { id: string; title: string }) {
  return (
    <div id={id} className="scroll-mt-20">
      <h2 className="text-2xl font-semibold mb-4 pt-8 border-t">{title}</h2>
    </div>
  );
}

function ComponentGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function ComponentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <span className="text-sm text-muted-foreground w-32 flex-shrink-0">{label}</span>
      <div className="flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}

export default function DesignSystemPage() {
  const [activeSection, setActiveSection] = useState("colors");
  const [searchValue, setSearchValue] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [checkboxChecked, setCheckboxChecked] = useState(false);
  const [selectValue, setSelectValue] = useState("");
  const [tabValue, setTabValue] = useState("tab1");
  const [progress, setProgress] = useState(45);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Use IntersectionObserver for reliable scroll tracking
  useEffect(() => {
    const scrollContainer = scrollAreaRef.current;
    if (!scrollContainer) return;

    const observerOptions = {
      root: scrollContainer,
      rootMargin: "-10% 0px -80% 0px", // Trigger when section enters top 20% of viewport
      threshold: 0,
    };

    const observerCallback: IntersectionObserverCallback = (entries) => {
      // Find entries that are intersecting
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setActiveSection(entry.target.id);
        }
      });
    };

    const observer = new IntersectionObserver(observerCallback, observerOptions);

    // Observe all section elements
    sections.forEach((section) => {
      const element = document.getElementById(section.id);
      if (element) {
        observer.observe(element);
      }
    });

    return () => observer.disconnect();
  }, []);

  const scrollToSection = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    const scrollContainer = scrollAreaRef.current;
    if (element && scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const relativeTop = elementRect.top - containerRect.top + scrollContainer.scrollTop;
      scrollContainer.scrollTo({ top: relativeTop - 20, behavior: "smooth" });
    }
  };

  return (
    <TooltipProvider>
      <div className="h-[calc(100vh-3.5rem)] flex overflow-hidden">
        {/* Fixed Navigation Sidebar */}
        <nav className="w-56 border-r bg-muted/30 p-4 shrink-0 overflow-y-auto">
          <h1 className="text-lg font-semibold mb-4">Design System</h1>
          <ul className="space-y-1">
            {sections.map((section) => (
              <li key={section.id}>
                <button
                  onClick={() => scrollToSection(section.id)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                    activeSection === section.id
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted text-muted-foreground hover:text-foreground"
                  )}
                >
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Main Content - scrollable area */}
        <div
          className="flex-1 overflow-y-auto"
          ref={scrollAreaRef}
        >
          <div className="max-w-5xl mx-auto p-8 space-y-12">
            {/* ===== COLORS ===== */}
            <SectionHeader id="colors" title="Color Palette" />

            <ComponentGroup title="Core Theme">
              <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-3">
                {coreColors.map((color) => (
                  <div key={color.var} className="space-y-1.5">
                    <div className={cn("h-12 rounded-lg border shadow-sm", color.className)} />
                    <div>
                      <p className="text-xs font-medium">{color.name}</p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">{color.var.replace("--color-", "")}</p>
                    </div>
                  </div>
                ))}
              </div>
            </ComponentGroup>

            <ComponentGroup title="Semantic Colors">
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
                {semanticColors.map((color) => (
                  <div key={color.var} className="space-y-1.5">
                    <div className={cn("h-12 rounded-lg border shadow-sm", color.className)} />
                    <div>
                      <p className="text-xs font-medium">{color.name}</p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">{color.var.replace("--color-", "")}</p>
                    </div>
                  </div>
                ))}
              </div>
            </ComponentGroup>

            <ComponentGroup title="Usage Examples">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-primary text-primary-foreground text-sm">
                  Primary: Actions, CTAs
                </div>
                <div className="p-3 rounded-lg bg-muted text-muted-foreground text-sm">
                  Muted: Subtle backgrounds
                </div>
                <div className="p-3 rounded-lg bg-destructive text-destructive-foreground text-sm">
                  Destructive: Errors, deletes
                </div>
                <div className="p-3 rounded-lg bg-complete-row text-foreground text-sm border">
                  Complete: Transaction done
                </div>
                <div className="p-3 rounded-lg bg-info text-info-foreground text-sm border border-info-border">
                  Info: Tips, notifications
                </div>
                <div className="p-3 rounded-lg bg-highlight text-foreground text-sm border">
                  Highlight: Search matches
                </div>
              </div>
            </ComponentGroup>

            {/* ===== TYPOGRAPHY ===== */}
            <SectionHeader id="typography" title="Typography" />
            <ComponentGroup title="Heading Hierarchy">
              <div className="space-y-4">
                <div className="text-4xl font-bold">Heading 1 - 36px Bold</div>
                <div className="text-3xl font-semibold">Heading 2 - 30px Semibold</div>
                <div className="text-2xl font-semibold">Heading 3 - 24px Semibold</div>
                <div className="text-xl font-medium">Heading 4 - 20px Medium</div>
                <div className="text-lg font-medium">Heading 5 - 18px Medium</div>
                <div className="text-base font-medium">Heading 6 - 16px Medium</div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Body Text">
              <div className="space-y-4">
                <p className="text-base">Body (base) - 16px regular - The quick brown fox jumps over the lazy dog.</p>
                <p className="text-sm">Body small - 14px regular - The quick brown fox jumps over the lazy dog.</p>
                <p className="text-xs">Caption - 12px regular - The quick brown fox jumps over the lazy dog.</p>
                <p className="text-sm text-muted-foreground">Muted text - Used for secondary information</p>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Font Weights">
              <div className="space-y-2">
                <p className="font-normal">Normal (400) - Regular body text</p>
                <p className="font-medium">Medium (500) - Emphasis, labels</p>
                <p className="font-semibold">Semibold (600) - Headings, buttons</p>
                <p className="font-bold">Bold (700) - Strong emphasis</p>
              </div>
            </ComponentGroup>

            {/* ===== BUTTONS ===== */}
            <SectionHeader id="buttons" title="Buttons" />
            <ComponentGroup title="Button Variants">
              <ComponentRow label="Default">
                <Button>Default</Button>
                <Button disabled>Disabled</Button>
              </ComponentRow>
              <ComponentRow label="Secondary">
                <Button variant="secondary">Secondary</Button>
                <Button variant="secondary" disabled>Disabled</Button>
              </ComponentRow>
              <ComponentRow label="Outline">
                <Button variant="outline">Outline</Button>
                <Button variant="outline" disabled>Disabled</Button>
              </ComponentRow>
              <ComponentRow label="Ghost">
                <Button variant="ghost">Ghost</Button>
                <Button variant="ghost" disabled>Disabled</Button>
              </ComponentRow>
              <ComponentRow label="Destructive">
                <Button variant="destructive">Destructive</Button>
                <Button variant="destructive" disabled>Disabled</Button>
              </ComponentRow>
              <ComponentRow label="Link">
                <Button variant="link">Link Button</Button>
              </ComponentRow>
            </ComponentGroup>

            <ComponentGroup title="Button Sizes">
              <ComponentRow label="Sizes">
                <Button size="sm">Small</Button>
                <Button size="default">Default</Button>
                <Button size="lg">Large</Button>
                <Button size="icon"><Plus className="h-4 w-4" /></Button>
              </ComponentRow>
            </ComponentGroup>

            <ComponentGroup title="Buttons with Icons">
              <ComponentRow label="Icon Left">
                <Button><Plus className="mr-2 h-4 w-4" /> Add Item</Button>
                <Button variant="outline"><Upload className="mr-2 h-4 w-4" /> Upload</Button>
              </ComponentRow>
              <ComponentRow label="Icon Right">
                <Button>Continue <ChevronRight className="ml-2 h-4 w-4" /></Button>
              </ComponentRow>
              <ComponentRow label="Loading">
                <Button disabled><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading</Button>
              </ComponentRow>
            </ComponentGroup>

            <ComponentGroup title="Connect Button">
              <p className="text-sm text-muted-foreground mb-3">
                Standardized button for opening connect overlays. Shows pressed state when overlay is open.
                Used in TransactionFilesSection and FileConnectionsList.
              </p>
              <ComponentRow label="Inactive">
                <ConnectButton />
                <ConnectButton label="Add" />
              </ComponentRow>
              <ComponentRow label="Active (Open)">
                <ConnectButton isOpen />
                <ConnectButton isOpen label="Add" />
              </ComponentRow>
              <ComponentRow label="Disabled">
                <ConnectButton disabled />
              </ComponentRow>
            </ComponentGroup>

            {/* ===== BADGES & PILLS ===== */}
            <SectionHeader id="badges" title="Badges & Pills" />
            <ComponentGroup title="Badge Variants">
              <ComponentRow label="Default">
                <Badge>Default</Badge>
                <Badge>New</Badge>
                <Badge>3</Badge>
              </ComponentRow>
              <ComponentRow label="Secondary">
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="secondary">Pending</Badge>
              </ComponentRow>
              <ComponentRow label="Outline">
                <Badge variant="outline">Outline</Badge>
                <Badge variant="outline">Draft</Badge>
              </ComponentRow>
              <ComponentRow label="Destructive">
                <Badge variant="destructive">Destructive</Badge>
                <Badge variant="destructive">Error</Badge>
              </ComponentRow>
              <ComponentRow label="Success">
                <Badge variant="success">Connected</Badge>
                <Badge variant="success">Active</Badge>
                <Badge variant="success">95%</Badge>
              </ComponentRow>
              <ComponentRow label="Warning">
                <Badge variant="warning">Paused</Badge>
                <Badge variant="warning">Pending</Badge>
                <Badge variant="warning">78%</Badge>
              </ComponentRow>
              <ComponentRow label="Info">
                <Badge variant="info">Syncing</Badge>
                <Badge variant="info">Processing</Badge>
                <Badge variant="info">Auto</Badge>
              </ComponentRow>
              <ComponentRow label="Muted">
                <Badge variant="muted">Draft</Badge>
                <Badge variant="muted">Inactive</Badge>
              </ComponentRow>
            </ComponentGroup>

            <ComponentGroup title="Score Badges (Confidence)">
              <p className="text-sm text-muted-foreground mb-3">
                Consistent score coloring: green (85%+), amber (50-84%), stone (&lt;50%).
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">classification-badges.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">rule-card.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">transaction-files-section.tsx</code></span>
              </p>
              <ComponentRow label="High (85%+)">
                <Badge className="bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700">95%</Badge>
                <Badge className="bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700">92%</Badge>
              </ComponentRow>
              <ComponentRow label="Medium (50-84%)">
                <Badge className="bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700">78%</Badge>
                <Badge className="bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700">54%</Badge>
              </ComponentRow>
              <ComponentRow label="Low (<50%)">
                <Badge className="bg-stone-50 text-stone-700 border-stone-300 dark:bg-stone-800 dark:text-stone-300">32%</Badge>
                <Badge className="bg-stone-50 text-stone-700 border-stone-300 dark:bg-stone-800 dark:text-stone-300">15%</Badge>
              </ComponentRow>
            </ComponentGroup>

            <ComponentGroup title="Pills (Interactive Tags)">
              <ComponentRow label="Default">
                <Pill label="Category" />
                <Pill label="With Icon" icon={FileText} />
                <Pill label="Removable" onRemove={() => {}} />
              </ComponentRow>
              <ComponentRow label="Suggestion">
                <Pill label="Suggested match" variant="suggestion" />
                <Pill label="REWE" variant="suggestion" confidence={92} />
                <Pill label="Amazon" variant="suggestion" confidence={85} onClick={() => {}} />
              </ComponentRow>
              <ComponentRow label="Interactive">
                <Pill label="Click me" onClick={() => alert("Clicked!")} />
                <Pill label="Disabled" disabled />
              </ComponentRow>
            </ComponentGroup>

            <ComponentGroup title="Partner Pills">
              <p className="text-sm text-muted-foreground mb-3">
                Specialized pill for partner display with match types and confidence levels.
              </p>
              <ComponentRow label="Manual">
                <PartnerPill name="Amazon" matchedBy="manual" />
                <PartnerPill name="Netflix" matchedBy="manual" onRemove={() => {}} />
              </ComponentRow>
              <ComponentRow label="Auto">
                <PartnerPill name="REWE" confidence={95} matchedBy="auto" />
                <PartnerPill name="Spotify" confidence={88} matchedBy="auto" onRemove={() => {}} />
              </ComponentRow>
              <ComponentRow label="Suggestion">
                <PartnerPill name="Client Corp" variant="suggestion" confidence={92} />
                <PartnerPill name="Freelance Inc" variant="suggestion" confidence={78} onClick={() => {}} />
              </ComponentRow>
              <ComponentRow label="With Type Icon">
                <PartnerPill name="My Company" partnerType="user" matchedBy="manual" />
                <PartnerPill name="Global Partner" partnerType="global" confidence={90} matchedBy="auto" />
              </ComponentRow>
            </ComponentGroup>

            <ComponentGroup title="Amount Match Display">
              <p className="text-sm text-muted-foreground mb-3">
                File/transaction count pill with amount matching status.
              </p>
              <ComponentRow label="Matched">
                <AmountMatchDisplay
                  count={1}
                  countType="file"
                  primaryAmount={-12550}
                  primaryCurrency="EUR"
                  secondaryAmounts={[{ amount: 12550, currency: "EUR" }]}
                />
              </ComponentRow>
              <ComponentRow label="Multiple">
                <AmountMatchDisplay
                  count={3}
                  countType="file"
                  primaryAmount={-50000}
                  primaryCurrency="EUR"
                  secondaryAmounts={[
                    { amount: 20000, currency: "EUR" },
                    { amount: 20000, currency: "EUR" },
                    { amount: 10000, currency: "EUR" }
                  ]}
                />
              </ComponentRow>
              <ComponentRow label="Mismatch">
                <AmountMatchDisplay
                  count={1}
                  countType="file"
                  primaryAmount={-10000}
                  primaryCurrency="EUR"
                  secondaryAmounts={[{ amount: 8500, currency: "EUR" }]}
                />
              </ComponentRow>
              <ComponentRow label="Extracting">
                <AmountMatchDisplay
                  count={1}
                  countType="file"
                  primaryAmount={-5000}
                  primaryCurrency="EUR"
                  secondaryAmounts={[]}
                  isExtracting
                />
              </ComponentRow>
              <ComponentRow label="No Amount">
                <AmountMatchDisplay
                  count={2}
                  countType="file"
                  primaryAmount={-3000}
                  primaryCurrency="EUR"
                  secondaryAmounts={[]}
                />
              </ComponentRow>
            </ComponentGroup>

            {/* ===== FORM ELEMENTS ===== */}
            <SectionHeader id="forms" title="Form Elements" />
            <ComponentGroup title="Text Inputs">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
                <div className="space-y-2">
                  <Label htmlFor="default-input">Default Input</Label>
                  <Input id="default-input" placeholder="Enter text..." />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="disabled-input">Disabled Input</Label>
                  <Input id="disabled-input" placeholder="Disabled" disabled />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="with-icon">With Search Icon</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input id="with-icon" placeholder="Search..." className="pl-9" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="error-input" className="text-destructive">Error State</Label>
                  <Input id="error-input" placeholder="Invalid input" className="border-destructive" />
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Search Components">
              <ComponentRow label="Search Button">
                <SearchButton
                  value={searchValue}
                  onSearch={setSearchValue}
                  placeholder="Search transactions..."
                />
              </ComponentRow>
              <div className="max-w-sm">
                <ComponentRow label="Search Input">
                  <SearchInput
                    value={searchValue}
                    onChange={setSearchValue}
                    placeholder="Search partners..."
                  />
                </ComponentRow>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Select">
              <div className="max-w-xs">
                <Select value={selectValue} onValueChange={setSelectValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an option" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opt1">Option 1</SelectItem>
                    <SelectItem value="opt2">Option 2</SelectItem>
                    <SelectItem value="opt3">Option 3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Checkbox">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="checkbox1"
                  checked={checkboxChecked}
                  onCheckedChange={(checked) => setCheckboxChecked(checked === true)}
                />
                <Label htmlFor="checkbox1">Accept terms and conditions</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox id="checkbox2" checked disabled />
                <Label htmlFor="checkbox2" className="text-muted-foreground">Disabled checked</Label>
              </div>
            </ComponentGroup>

            {/* ===== CARDS & PANELS ===== */}
            <SectionHeader id="cards" title="Cards & Panels" />

            <ComponentGroup title="Settings Page Header">
              <p className="text-sm text-muted-foreground mb-4">
                Standard header for all settings pages. Use consistently across /settings/* routes.
              </p>
              <div className="space-y-6 border rounded-lg p-4 bg-background">
                <SettingsPageHeader
                  title="Sign-in & Security"
                  description="Manage how you sign in and protect your account"
                />
                <SettingsPageHeader
                  title="AI Usage"
                  description="Track your AI feature usage and estimated costs"
                >
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm">Export</Button>
                    <Button size="sm">Refresh</Button>
                  </div>
                </SettingsPageHeader>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Card Variants">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Card Title</CardTitle>
                    <CardDescription>Card description text goes here</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm">Card content area with some example text.</p>
                  </CardContent>
                  <CardFooter>
                    <Button size="sm">Action</Button>
                  </CardFooter>
                </Card>

                <Card className="border-l-4 border-l-primary">
                  <CardHeader>
                    <CardTitle className="text-base">Accent Card</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Card with left accent border for emphasis.
                    </p>
                  </CardContent>
                </Card>

                <Card className="bg-muted/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Muted Card</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-bold">2,450</p>
                    <p className="text-xs text-muted-foreground">Total transactions</p>
                  </CardContent>
                </Card>

                <Card className="border-destructive/50 bg-destructive/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-destructive">Error Card</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm">Something went wrong. Please try again.</p>
                  </CardContent>
                </Card>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Detail Panel Pattern">
              <div className="border rounded-lg max-w-md">
                <div className="flex items-center justify-between py-3 border-b px-4">
                  <h3 className="text-lg font-semibold">Panel Header</h3>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Field Label</p>
                    <p className="text-sm">Field Value</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Amount</p>
                    <p className="text-lg font-semibold text-amount-negative">-245.00</p>
                  </div>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Connected Files</p>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <FileText className="h-4 w-4" />
                      <span>invoice_2024.pdf</span>
                    </div>
                  </div>
                </div>
                <div className="border-t px-4 py-2">
                  <Button variant="ghost" size="sm" className="w-full justify-start gap-2">
                    <History className="h-4 w-4" />
                    <span>Edit History</span>
                  </Button>
                </div>
              </div>
            </ComponentGroup>

            {/* ===== TABLE PATTERNS ===== */}
            <SectionHeader id="table-patterns" title="Table Patterns" />
            <p className="text-muted-foreground mb-6">
              Reusable table patterns used across the application for data display.
              Includes headers, cells, row states, and data table components.
            </p>

            <ComponentGroup title="Sortable Headers">
              <p className="text-sm text-muted-foreground mb-3">
                Column headers with sort indicators. Based on <code className="text-xs bg-muted px-1 py-0.5 rounded">SortableHeader</code> component.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">transaction-columns.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">file-columns.tsx</code></span>
              </p>
              <div className="flex gap-4 flex-wrap">
                {/* Unsorted */}
                <Button variant="ghost" className="h-8 px-2 justify-between font-medium">
                  <span>Date</span>
                  <ArrowUpDown className="h-4 w-4 ml-2 text-muted-foreground/50" />
                </Button>
                {/* Sorted Ascending */}
                <Button variant="ghost" className="h-8 px-2 justify-between font-medium">
                  <span>Amount</span>
                  <ArrowUp className="h-4 w-4 ml-2" />
                </Button>
                {/* Sorted Descending */}
                <Button variant="ghost" className="h-8 px-2 justify-between font-medium">
                  <span>Name</span>
                  <ArrowDown className="h-4 w-4 ml-2" />
                </Button>
                {/* Automation Header (Partner/File columns) */}
                <div className="h-8 px-2 flex items-center justify-between font-medium border rounded">
                  <span>Partner</span>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-6 w-6 ml-2">
                          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>View automations</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Cell Patterns">
              <p className="text-sm text-muted-foreground mb-3">
                Standard cell rendering patterns for different data types.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">transaction-columns.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">file-columns.tsx</code></span>
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {/* Date Cell */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">Date Cell</p>
                  <div>
                    <p className="text-sm whitespace-nowrap">Jan 15, 2024</p>
                    <p className="text-sm text-muted-foreground">14:30</p>
                  </div>
                </div>

                {/* Amount Cell - Negative */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">Amount (Expense)</p>
                  <span className="text-sm tabular-nums whitespace-nowrap text-amount-negative">-€125,50</span>
                </div>

                {/* Amount Cell - Positive */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">Amount (Income)</p>
                  <span className="text-sm tabular-nums whitespace-nowrap text-amount-positive">+€2.500,00</span>
                </div>

                {/* Description Cell */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">Description</p>
                  <div className="min-w-0">
                    <p className="text-sm truncate">Amazon</p>
                    <p className="text-sm text-muted-foreground truncate">Office Supplies Purchase</p>
                  </div>
                </div>

                {/* Partner Cell - Manual */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">Partner (Manual)</p>
                  <PartnerPill name="Amazon" matchedBy="manual" />
                </div>

                {/* Partner Cell - Auto */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">Partner (Auto)</p>
                  <PartnerPill name="Netflix" confidence={95} matchedBy="auto" />
                </div>

                {/* Partner Cell - Suggestion */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">Partner (Suggestion)</p>
                  <PartnerPill name="Client Corp" variant="suggestion" confidence={92} />
                </div>

                {/* Partner Cell - Empty */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">Partner (Empty)</p>
                  <span className="text-sm text-muted-foreground">—</span>
                </div>

                {/* File Cell - Matched */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">File (Matched)</p>
                  <AmountMatchDisplay
                    count={1}
                    countType="file"
                    primaryAmount={-12550}
                    primaryCurrency="EUR"
                    secondaryAmounts={[{ amount: 12550, currency: "EUR" }]}
                  />
                </div>

                {/* File Cell - Multiple files */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">File (Multiple)</p>
                  <AmountMatchDisplay
                    count={3}
                    countType="file"
                    primaryAmount={-50000}
                    primaryCurrency="EUR"
                    secondaryAmounts={[
                      { amount: 20000, currency: "EUR" },
                      { amount: 20000, currency: "EUR" },
                      { amount: 10000, currency: "EUR" }
                    ]}
                  />
                </div>

                {/* File Cell - Amount Mismatch */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">File (Mismatch)</p>
                  <AmountMatchDisplay
                    count={1}
                    countType="file"
                    primaryAmount={-10000}
                    primaryCurrency="EUR"
                    secondaryAmounts={[{ amount: 8500, currency: "EUR" }]}
                  />
                </div>

                {/* File Cell - Extracting */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">File (Extracting)</p>
                  <AmountMatchDisplay
                    count={1}
                    countType="file"
                    primaryAmount={-5000}
                    primaryCurrency="EUR"
                    secondaryAmounts={[]}
                    isExtracting
                  />
                </div>

                {/* File Cell - No Receipt Category */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">No Receipt Category</p>
                  <Pill label="Bank Fees" icon={Tag} />
                </div>

                {/* File Cell - Empty */}
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-2 uppercase">File (Empty)</p>
                  <span className="text-sm text-muted-foreground">—</span>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Row States">
              <p className="text-sm text-muted-foreground mb-3">
                Visual states for table rows based on selection, completion, and highlight status.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">transaction-table.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">file-table.tsx</code></span>
              </p>
              <div className="space-y-2">
                <div className="p-3 border rounded flex items-center gap-4">
                  <span className="text-sm w-28 shrink-0">Default</span>
                  <div className="flex-1 h-12 border rounded bg-background flex items-center px-3 text-sm text-muted-foreground">hover:bg-muted/50</div>
                </div>
                <div className="p-3 border rounded flex items-center gap-4">
                  <span className="text-sm w-28 shrink-0">Selected</span>
                  <div className="flex-1 h-12 border rounded bg-muted/50 flex items-center px-3 text-sm">bg-muted/50</div>
                </div>
                <div className="p-3 border rounded flex items-center gap-4">
                  <span className="text-sm w-28 shrink-0">Completed</span>
                  <div className="flex-1 h-12 border rounded bg-complete-row flex items-center px-3 text-sm">bg-complete-row</div>
                </div>
                <div className="p-3 border rounded flex items-center gap-4">
                  <span className="text-sm w-28 shrink-0">Highlight</span>
                  <div className="flex-1 h-12 border rounded bg-primary/10 animate-pulse flex items-center px-3 text-sm">animate-pulse bg-primary/10</div>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Data Table Row Example">
              <p className="text-sm text-muted-foreground mb-3">
                Complete table row showing all cell patterns combined.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">transaction-table.tsx</code></span>
              </p>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead className="w-[110px]">Date</TableHead>
                      <TableHead className="w-[100px]">Amount</TableHead>
                      <TableHead className="w-[220px]">Description</TableHead>
                      <TableHead className="w-[240px]">Partner</TableHead>
                      <TableHead className="w-[140px]">File</TableHead>
                      <TableHead className="w-[120px]">Account</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* Completed transaction (green background) */}
                    <TableRow className="bg-complete-row hover:bg-complete-row-selected">
                      <TableCell>
                        <div>
                          <p className="text-sm whitespace-nowrap">Jan 15, 2024</p>
                          <p className="text-sm text-muted-foreground">14:30</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm tabular-nums whitespace-nowrap text-amount-negative">-€125,50</span>
                      </TableCell>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="text-sm truncate">Amazon</p>
                          <p className="text-sm text-muted-foreground truncate">Office Supplies Purchase</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <PartnerPill name="Amazon" matchedBy="manual" />
                      </TableCell>
                      <TableCell>
                        <AmountMatchDisplay
                          count={1}
                          countType="file"
                          primaryAmount={-12550}
                          primaryCurrency="EUR"
                          secondaryAmounts={[{ amount: 12550, currency: "EUR" }]}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="text-sm truncate">Main Account</span>
                      </TableCell>
                    </TableRow>
                    {/* Transaction with suggestion */}
                    <TableRow className="hover:bg-muted/50">
                      <TableCell>
                        <div>
                          <p className="text-sm whitespace-nowrap">Jan 14, 2024</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm tabular-nums whitespace-nowrap text-amount-positive">+€2.500,00</span>
                      </TableCell>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="text-sm truncate">Client Corp</p>
                          <p className="text-sm text-muted-foreground truncate">Invoice Payment #2024-001</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <PartnerPill name="Client Corp" variant="suggestion" confidence={92} />
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">—</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm truncate">Main Account</span>
                      </TableCell>
                    </TableRow>
                    {/* Selected transaction with no-receipt category */}
                    <TableRow data-state="selected" className="bg-muted/50 hover:bg-muted">
                      <TableCell>
                        <div>
                          <p className="text-sm whitespace-nowrap">Jan 13, 2024</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm tabular-nums whitespace-nowrap text-amount-negative">-€15,99</span>
                      </TableCell>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="text-sm truncate">Netflix</p>
                          <p className="text-sm text-muted-foreground truncate">Monthly Subscription</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <PartnerPill name="Netflix" confidence={95} matchedBy="auto" />
                      </TableCell>
                      <TableCell>
                        <Pill label="Subscription" icon={Tag} />
                      </TableCell>
                      <TableCell>
                        <span className="text-sm truncate">Main Account</span>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Detail Panel Pattern">
              <p className="text-sm text-muted-foreground mb-3">
                Standard detail panel layout with header, field rows, and section headers.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">transaction-detail-panel.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">file-detail-panel.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">partner-detail-panel.tsx</code></span>
              </p>
              <div className="border rounded-lg max-w-md">
                <PanelHeader
                  title="Transaction Details"
                  onClose={() => {}}
                  onNavigatePrevious={() => {}}
                  onNavigateNext={() => {}}
                  hasPrevious={true}
                  hasNext={true}
                />
                <div className="p-4 space-y-4">
                  {/* Amount display */}
                  <div className="text-center py-2">
                    <p className="text-3xl font-bold text-amount-negative">-€125,50</p>
                    <p className="text-sm text-muted-foreground">EUR</p>
                  </div>

                  <Separator />

                  {/* Transaction details - uses labelWidth="w-32" */}
                  <div className="space-y-3">
                    <FieldRow label="Date" labelWidth="w-32">Jan 15, 2024 14:30</FieldRow>
                    <FieldRow label="Amount" labelWidth="w-32">
                      <span className="tabular-nums text-amount-negative">-€125,50</span>
                    </FieldRow>
                    <FieldRow label="Counterparty" labelWidth="w-32">Amazon Marketplace</FieldRow>
                    <FieldRow label="IBAN" labelWidth="w-32">
                      <span className="font-mono text-xs">DE89 3704 0044 0532 0130 00</span>
                    </FieldRow>
                    <FieldRow label="Description" labelWidth="w-32">Office Supplies Purchase</FieldRow>
                    <FieldRow label="Account" labelWidth="w-32">
                      <a href="#" className="text-primary hover:underline inline-flex items-center gap-1">
                        Main Account
                        <ChevronRight className="h-3 w-3" />
                      </a>
                    </FieldRow>
                  </div>

                  {/* Partner section - uses h3 not PanelSectionHeader */}
                  <div className="border-t pt-3 mt-3 -mx-4 px-4">
                    <h3 className="text-sm font-medium mb-2">Partner</h3>
                    <FieldRow label="Connect" labelWidth="w-32">
                      <PartnerPill name="Amazon" matchedBy="manual" onClick={() => {}} onRemove={() => {}} />
                    </FieldRow>
                  </div>

                  {/* File section - uses h3 not PanelSectionHeader */}
                  <div className="border-t pt-3 mt-3 -mx-4 px-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium">File</h3>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-6 w-6">
                          <Info className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6">
                          <History className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Connected files list */}
                    <div className="space-y-0.5">
                      <FileListItem
                        href="/files/123"
                        fileName="amazon_invoice_2024.pdf"
                        date="Jan 15, 2024"
                        amount={12550}
                        onRemove={() => {}}
                      />
                    </div>

                    {/* Sum area - shows file totals vs transaction amount */}
                    <div className="bg-muted/50 rounded-lg p-3 space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Transaction</span>
                        <span className="tabular-nums font-medium">€125,50</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Files (1)</span>
                        <span className="tabular-nums font-medium">€125,50</span>
                      </div>
                      <Separator />
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Difference</span>
                        <span className="tabular-nums font-medium text-amount-positive">€0,00 ✓</span>
                      </div>
                    </div>

                    {/* No Receipt row */}
                    <FieldRow label="No Receipt" labelWidth="w-32">
                      <Button variant="outline" size="sm" className="h-7 px-3">
                        <Plus className="h-3 w-3 mr-1" />
                        Select
                      </Button>
                    </FieldRow>
                  </div>
                </div>
                <PanelFooter>
                  <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground">
                    <History className="h-4 w-4" />
                    <span>Edit History</span>
                  </Button>
                </PanelFooter>
              </div>
            </ComponentGroup>

            <ComponentGroup title="File Suggestion Row">
              <p className="text-sm text-muted-foreground mb-3">
                Row pattern for displaying file suggestions with confidence scores and accept/decline actions.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">transaction-files-section.tsx</code></span>
              </p>
              <div className="space-y-2 max-w-md">
                {/* High confidence suggestion */}
                <div className="flex items-center justify-between gap-2 p-2 rounded bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30 group overflow-hidden">
                  <div className="min-w-0 flex-1 overflow-hidden w-0">
                    <p className="text-sm truncate">amazon_invoice_2024.pdf</p>
                    <p className="text-xs text-muted-foreground">Jan 15, 2024</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm font-medium tabular-nums text-foreground">€125,50</span>
                    <Badge
                      variant="outline"
                      className="text-xs px-1.5 py-0 cursor-help bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300"
                    >
                      92%
                    </Badge>
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-destructive/10 transition-colors"
                      title="Decline suggestion"
                    >
                      <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                    </button>
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
                      title="Connect file"
                    >
                      <Check className="h-4 w-4 text-muted-foreground hover:text-green-600" />
                    </button>
                  </div>
                </div>

                {/* Medium confidence suggestion */}
                <div className="flex items-center justify-between gap-2 p-2 rounded bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30 group overflow-hidden">
                  <div className="min-w-0 flex-1 overflow-hidden w-0">
                    <p className="text-sm truncate">receipt_jan_2024.pdf</p>
                    <p className="text-xs text-muted-foreground">Jan 14, 2024</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm font-medium tabular-nums text-foreground">€120,00</span>
                    <Badge
                      variant="outline"
                      className="text-xs px-1.5 py-0 cursor-help bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700"
                    >
                      75%
                    </Badge>
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-destructive/10 transition-colors"
                    >
                      <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                    </button>
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
                    >
                      <Check className="h-4 w-4 text-muted-foreground hover:text-green-600" />
                    </button>
                  </div>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Category Suggestion Pill">
              <p className="text-sm text-muted-foreground mb-3">
                Clickable pill for no-receipt category suggestions with confidence scores.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">transaction-files-section.tsx</code></span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className="inline-flex items-center h-7 px-3 gap-2 rounded-md border text-sm bg-info border-info-border text-info-foreground cursor-pointer hover:bg-info/80 transition-colors"
                >
                  <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate max-w-[120px]">Bank Fees</span>
                  <span className="text-xs opacity-75">95%</span>
                </button>
                <button
                  type="button"
                  className="inline-flex items-center h-7 px-3 gap-2 rounded-md border text-sm bg-info border-info-border text-info-foreground cursor-pointer hover:bg-info/80 transition-colors"
                >
                  <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate max-w-[120px]">Subscription</span>
                  <span className="text-xs opacity-75">82%</span>
                </button>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Toolbar Pattern">
              <p className="text-sm text-muted-foreground mb-3">
                Filter toolbar using Popover/Button for search and filtering. Active filters use secondary variant with X to clear.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">transaction-toolbar.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">file-toolbar.tsx</code></span>
              </p>
              <div className="flex items-center gap-2 px-4 py-2 border-b bg-background flex-wrap rounded-t-lg border-x border-t">
                <SearchButton
                  value=""
                  onSearch={() => {}}
                  placeholder="Search..."
                />

                {/* Date filter - active state */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="secondary" size="sm" className="h-9 gap-2">
                      <CalendarDays className="h-4 w-4" />
                      <span>Jan 1 - Mar 31</span>
                      <span
                        role="button"
                        className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="flex flex-col gap-1">
                      <Button variant="ghost" size="sm" className="justify-start h-8">All time</Button>
                      <Button variant="ghost" size="sm" className="justify-start h-8">Last 30 days</Button>
                      <Button variant="secondary" size="sm" className="justify-start h-8">This year</Button>
                      <Button variant="ghost" size="sm" className="justify-start h-8">Last year</Button>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* File filter - active state */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="secondary" size="sm" className="h-9 gap-2">
                      <FileText className="h-4 w-4" />
                      <span>No file</span>
                      <span
                        role="button"
                        className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="flex flex-col gap-1">
                      <Button variant="ghost" size="sm" className="justify-start h-8">All</Button>
                      <Button variant="ghost" size="sm" className="justify-start h-8">Has file</Button>
                      <Button variant="secondary" size="sm" className="justify-start h-8">No file</Button>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Type filter - inactive state */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 gap-2">
                      <ArrowUpDown className="h-4 w-4" />
                      <span>Type</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="flex flex-col gap-1">
                      <Button variant="secondary" size="sm" className="justify-start h-8">All</Button>
                      <Button variant="ghost" size="sm" className="justify-start h-8">Income</Button>
                      <Button variant="ghost" size="sm" className="justify-start h-8">Expenses</Button>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Partner filter - inactive state */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 gap-2">
                      <span>Partner</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-3" align="start">
                    <div className="space-y-3">
                      <SearchInput value="" onChange={() => {}} placeholder="Search partners..." />
                      <div className="max-h-56 overflow-y-auto space-y-1">
                        <button className="w-full text-left flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
                          <span className="h-4 w-4 rounded border flex items-center justify-center border-muted-foreground/40 text-transparent">
                            <Check className="h-3 w-3" />
                          </span>
                          <span>Amazon</span>
                        </button>
                        <button className="w-full text-left flex items-center gap-2 rounded px-2 py-1.5 text-sm bg-muted">
                          <span className="h-4 w-4 rounded border flex items-center justify-center border-primary text-primary">
                            <Check className="h-3 w-3" />
                          </span>
                          <span>Netflix</span>
                        </button>
                        <button className="w-full text-left flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
                          <span className="h-4 w-4 rounded border flex items-center justify-center border-muted-foreground/40 text-transparent">
                            <Check className="h-3 w-3" />
                          </span>
                          <span>Client Corp</span>
                        </button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Detail Panel Overlay">
              <p className="text-sm text-muted-foreground mb-4">
                Overlay pattern that slides over the detail panel for secondary actions.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">connect-file-overlay.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">connect-transaction-overlay.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">email-search-panel.tsx</code></span>
              </p>
              <div className="border rounded-lg max-w-lg bg-background">
                {/* Overlay header */}
                <div className="flex items-center justify-between p-3 border-b">
                  <h4 className="font-medium">Connect File</h4>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                {/* Tabs */}
                <Tabs defaultValue="files" className="p-3">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="files" className="gap-1.5">
                      <FileText className="h-3.5 w-3.5" />
                      Files
                    </TabsTrigger>
                    <TabsTrigger value="email" className="gap-1.5">
                      <Mail className="h-3.5 w-3.5" />
                      Email
                    </TabsTrigger>
                    <TabsTrigger value="web" className="gap-1.5">
                      <Link2 className="h-3.5 w-3.5" />
                      Web
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="files" className="mt-3 space-y-3">
                    {/* Search input */}
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input placeholder="Search files..." className="pl-9" />
                    </div>

                    {/* File list with suggestions */}
                    <div className="space-y-2">
                      {/* High confidence match */}
                      <div className="flex items-center gap-3 p-2 border rounded-lg hover:bg-muted/50 cursor-pointer border-green-200 bg-green-50/50">
                        <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
                          <FileText className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">amazon_invoice_jan15.pdf</p>
                          <p className="text-xs text-muted-foreground">Amount: €125.50 · Jan 15, 2024</p>
                        </div>
                        <Badge className="bg-green-50 text-green-900 border-green-300 hover:bg-green-100">95%</Badge>
                      </div>

                      {/* Medium confidence match */}
                      <div className="flex items-center gap-3 p-2 border rounded-lg hover:bg-muted/50 cursor-pointer">
                        <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
                          <FileText className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">receipt_office_supplies.pdf</p>
                          <p className="text-xs text-muted-foreground">Amount: €127.00 · Jan 14, 2024</p>
                        </div>
                        <Badge className="bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-50">78%</Badge>
                      </div>

                      {/* No match indicator */}
                      <div className="flex items-center gap-3 p-2 border rounded-lg hover:bg-muted/50 cursor-pointer opacity-60">
                        <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
                          <FileText className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">random_document.pdf</p>
                          <p className="text-xs text-muted-foreground">No amount detected</p>
                        </div>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="email" className="mt-3">
                    <div className="text-center py-8 text-muted-foreground">
                      <Mail className="h-10 w-10 mx-auto mb-3 opacity-50" />
                      <p className="text-sm">Search email attachments</p>
                      <p className="text-xs mt-1">Connect Gmail to search invoices</p>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </ComponentGroup>

            {/* ===== INTEGRATION ITEMS ===== */}
            <SectionHeader id="integrations" title="Integration Items" />
            <p className="text-muted-foreground mb-6">
              Standardized integration item cards used on the integrations page. Each item follows a consistent layout with icon, title, status badge, and action area.
              <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">/app/(dashboard)/integrations/page.tsx</code></span>
            </p>

            <ComponentGroup title="Gmail Integration Item">
              <p className="text-sm text-muted-foreground mb-3">
                Gmail account cards showing different sync states. Right side shows stats or refresh button based on state.
              </p>
              <div className="space-y-3 max-w-2xl">
                {/* Connected state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Mail className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">user@example.com</span>
                          <Badge variant="success" className="text-xs">
                            <Check className="h-3 w-3 mr-1" />
                            Connected
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">Connected 2 hours ago</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-muted-foreground"><span className="font-medium text-foreground">42</span> imported</span>
                          <span className="text-muted-foreground"><span className="font-medium text-foreground">38</span> extracted</span>
                          <span className="text-muted-foreground"><span className="font-medium text-foreground">35</span> matched</span>
                        </div>
                        <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground mt-1">
                          <FileCheck className="h-3 w-3" />
                          <span>Last synced 5 minutes ago</span>
                        </div>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>

                {/* Syncing state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Mail className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">work@company.com</span>
                          <Badge variant="info" className="text-xs">
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            Syncing
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">Connected 1 day ago</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2 text-sm text-blue-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Syncing... (12 files)</span>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>

                {/* Paused state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Mail className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">admin@example.com</span>
                          <Badge variant="warning" className="text-xs">
                            <Pause className="h-3 w-3 mr-1" />
                            Paused
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">Connected 18 minutes ago</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <Button variant="ghost" size="sm">
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>

                {/* Reconnect required state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Mail className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">expired@example.com</span>
                          <Badge variant="destructive" className="text-xs">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            Reconnect Required
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">Connected 30 days ago</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <Button variant="outline" size="sm">
                        <RefreshCw className="h-4 w-4" />
                        <span className="ml-2">Reconnect</span>
                      </Button>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Browser Extension Item">
              <p className="text-sm text-muted-foreground mb-3">
                Chrome extension integration status. Shows install state and refresh button.
              </p>
              <div className="space-y-3 max-w-2xl">
                {/* Installed state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Globe className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Chrome Extension</span>
                          <Badge variant="success" className="text-xs">
                            <Check className="h-3 w-3 mr-1" />
                            Installed
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">Extension connected and ready to pull invoices</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <Button variant="ghost" size="sm">
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>

                {/* Checking state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Globe className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Chrome Extension</span>
                          <Badge variant="info" className="text-xs">
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            Checking
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">Checking extension status...</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>

                {/* Not installed state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Globe className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Chrome Extension</span>
                          <Badge variant="warning" className="text-xs">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            Not installed
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">Install the plugin to start scanning invoice portals</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <Button variant="ghost" size="sm">
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Email Forwarding Item">
              <p className="text-sm text-muted-foreground mb-3">
                Email forwarding service status with unique forwarding address display.
              </p>
              <div className="space-y-3 max-w-2xl">
                {/* Active state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Inbox className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <code className="font-medium text-sm bg-muted px-2 py-1 rounded">abc123@inbound.fibuki.com</code>
                          <Badge variant="success" className="text-xs">
                            <Check className="h-3 w-3 mr-1" />
                            Active
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">24 emails received · 18 files created</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right text-xs text-muted-foreground">
                        Last email 2 hours ago
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>

                {/* Paused state */}
                <div className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Inbox className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <code className="font-medium text-sm bg-muted px-2 py-1 rounded">xyz789@inbound.fibuki.com</code>
                          <Badge variant="warning" className="text-xs">
                            <Pause className="h-3 w-3 mr-1" />
                            Paused
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">12 emails received · 8 files created</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Integration Item Structure">
              <p className="text-sm text-muted-foreground mb-3">
                Standard layout pattern for all integration items:
              </p>
              <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="h-10 w-10 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center text-xs text-muted-foreground">
                      Icon
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <div className="h-4 w-32 bg-muted-foreground/20 rounded text-xs flex items-center justify-center">Title</div>
                        <div className="h-5 w-20 bg-muted-foreground/20 rounded text-xs flex items-center justify-center">Badge</div>
                      </div>
                      <div className="h-3 w-48 bg-muted-foreground/10 rounded text-xs flex items-center justify-center">Subtitle/Description</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="h-8 w-24 bg-muted-foreground/10 rounded text-xs flex items-center justify-center">Stats/Action</div>
                    <div className="h-5 w-5 bg-muted-foreground/10 rounded flex items-center justify-center text-xs">→</div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  <p><strong>Left side:</strong> Icon (40x40 rounded-full) + Title with Badge + Subtitle</p>
                  <p><strong>Right side:</strong> Stats/Action area (context-dependent) + ChevronRight navigation</p>
                  <p><strong>States:</strong> Connected (green), Syncing (blue), Paused (amber), Error (red)</p>
                </div>
              </div>
            </ComponentGroup>

            {/* ===== SIDEBAR & CHAT ===== */}
            <SectionHeader id="sidebar" title="Sidebar & Chat" />
            <p className="text-muted-foreground mb-6">
              Resizable AI chat sidebar patterns used for assistant interactions.
              Real implementation components: <code className="text-xs bg-muted px-1 py-0.5 rounded">ChatTabs</code>, <code className="text-xs bg-muted px-1 py-0.5 rounded">MessageBubble</code>, <code className="text-xs bg-muted px-1 py-0.5 rounded">ConfirmationCard</code>, <code className="text-xs bg-muted px-1 py-0.5 rounded">NotificationsList</code> in <code className="text-xs bg-muted px-1 py-0.5 rounded">/components/chat/</code>
            </p>

            <ComponentGroup title="Chat Sidebar Layout">
              <div className="border rounded-lg flex h-96 max-w-2xl overflow-hidden">
                {/* Sidebar */}
                <div className="w-72 border-r flex flex-col bg-background">
                  {/* Header */}
                  <div className="p-3 border-b flex items-center justify-between">
                    <Tabs defaultValue="messages" className="w-full">
                      <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="messages">Messages</TabsTrigger>
                        <TabsTrigger value="notifications">
                          Notifications
                          <Badge variant="destructive" className="ml-1.5 h-5 w-5 p-0 text-xs">3</Badge>
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>

                  {/* Messages area */}
                  <ScrollArea className="flex-1 p-3">
                    <div className="space-y-3">
                      {/* User message */}
                      <div className="flex justify-end">
                        <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 max-w-[80%]">
                          <p className="text-sm">Find transactions without receipts</p>
                        </div>
                      </div>
                      {/* AI message */}
                      <div className="flex justify-start">
                        <div className="bg-muted rounded-lg px-3 py-2 max-w-[80%]">
                          <p className="text-sm">I found 15 transactions without receipts. Would you like me to search for matching files?</p>
                        </div>
                      </div>
                      {/* Confirmation card */}
                      <div className="bg-info border border-info-border rounded-lg p-3">
                        <p className="text-sm font-medium text-info-foreground mb-2">Confirm action</p>
                        <p className="text-xs text-info-foreground/80 mb-3">Search for matching files for 15 transactions?</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="flex-1">Cancel</Button>
                          <Button size="sm" className="flex-1">Confirm</Button>
                        </div>
                      </div>
                    </div>
                  </ScrollArea>

                  {/* Input area */}
                  <div className="p-3 border-t">
                    <div className="flex gap-2">
                      <Input placeholder="Ask anything..." className="flex-1" />
                      <Button size="icon">
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Main content preview */}
                <div className="flex-1 bg-muted/30 flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">Main content area</p>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Sidebar Resize Handle">
              <div className="flex items-center gap-4">
                <div className="w-1 h-20 bg-border hover:bg-primary cursor-col-resize rounded-full transition-colors" />
                <div className="text-sm text-muted-foreground">
                  <p>Drag to resize sidebar (280px - 600px)</p>
                  <p className="text-xs mt-1">Width persists across sessions</p>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Chat Message Bubbles">
              <div className="space-y-3 max-w-md">
                {/* User message */}
                <div className="flex justify-end">
                  <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 max-w-[80%]">
                    <p className="text-sm">User message (right-aligned, primary color)</p>
                  </div>
                </div>
                {/* AI message */}
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg px-3 py-2 max-w-[80%]">
                    <p className="text-sm">AI response (left-aligned, muted background)</p>
                  </div>
                </div>
                {/* AI message with loading */}
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg px-3 py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Notification Card">
              <div className="max-w-sm space-y-3">
                <div className="border rounded-lg p-3">
                  <div className="flex items-start gap-3">
                    <div className="bg-green-50 rounded-full p-1.5 border border-green-300">
                      <Check className="h-4 w-4 text-green-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">Files matched</p>
                      <p className="text-xs text-muted-foreground">3 files matched to transactions automatically</p>
                    </div>
                    <span className="text-xs text-muted-foreground">2m ago</span>
                  </div>
                </div>
                <div className="border rounded-lg p-3 border-l-4 border-l-info">
                  <div className="flex items-start gap-3">
                    <div className="bg-info rounded-full p-1.5">
                      <Info className="h-4 w-4 text-info-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">New suggestion</p>
                      <p className="text-xs text-muted-foreground">Partner suggestion for transaction #1234</p>
                    </div>
                    <span className="text-xs text-muted-foreground">5m ago</span>
                  </div>
                </div>
              </div>
            </ComponentGroup>

            {/* ===== DIALOGS & SHEETS ===== */}
            <SectionHeader id="dialogs" title="Dialogs & Sheets" />
            <ComponentGroup title="Modal Dialog">
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger asChild>
                  <Button>Open Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Dialog Title</DialogTitle>
                    <DialogDescription>
                      This is a modal dialog used for confirmations, forms, or important information.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="py-4">
                    <Input placeholder="Enter something..." />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button onClick={() => setDialogOpen(false)}>Confirm</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </ComponentGroup>

            <ComponentGroup title="Side Sheet">
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline">Open Sheet</Button>
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>Sheet Title</SheetTitle>
                    <SheetDescription>
                      Side sheets slide in from the edge and are used for detail panels, forms, or navigation.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="py-6 space-y-4">
                    <div>
                      <Label className="text-xs text-muted-foreground">Field Name</Label>
                      <p className="text-sm">Field value here</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Another Field</Label>
                      <p className="text-sm">Another value</p>
                    </div>
                    <Separator />
                    <Button className="w-full">Take Action</Button>
                  </div>
                </SheetContent>
              </Sheet>
            </ComponentGroup>

            <ComponentGroup title="Table Overlay Dialog Pattern">
              <div className="border rounded-lg p-4 bg-muted/30">
                <p className="text-sm text-muted-foreground mb-4">
                  Used when selecting items from a table within a transaction context:
                </p>
                <div className="border rounded-lg bg-background">
                  <div className="flex items-center justify-between p-3 border-b">
                    <h4 className="font-medium">Connect File</h4>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <Tabs defaultValue="files" className="p-3">
                    <TabsList className="grid w-full grid-cols-3">
                      <TabsTrigger value="files">Files</TabsTrigger>
                      <TabsTrigger value="email">Email</TabsTrigger>
                      <TabsTrigger value="gmail">Gmail</TabsTrigger>
                    </TabsList>
                    <TabsContent value="files" className="mt-3">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3 p-2 border rounded hover:bg-muted cursor-pointer">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm flex-1">invoice_001.pdf</span>
                          <Badge className="bg-green-50 text-green-900 border-green-300">92%</Badge>
                        </div>
                        <div className="flex items-center gap-3 p-2 border rounded hover:bg-muted cursor-pointer">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm flex-1">receipt_amazon.pdf</span>
                          <Badge className="bg-amber-50 text-amber-900 border-amber-300">78%</Badge>
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>
              </div>
            </ComponentGroup>

            {/* Row Actions Dropdown - used in table columns */}
            <ComponentGroup title="Row Actions Dropdown">
              <p className="text-sm text-muted-foreground mb-3">
                Used in table column definitions for row-level actions. See <code>/components/ui/column-factories.tsx</code>
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem>
                    <User className="mr-2 h-4 w-4" />
                    View details
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Settings className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ComponentGroup>

            {/* ===== FEEDBACK & STATUS ===== */}
            <SectionHeader id="feedback" title="Feedback & Status" />
            <ComponentGroup title="Alerts">
              <div className="space-y-4 max-w-xl">
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertTitle>Information</AlertTitle>
                  <AlertDescription>
                    This is an informational alert for general messages.
                  </AlertDescription>
                </Alert>
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>
                    Something went wrong. Please try again later.
                  </AlertDescription>
                </Alert>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Progress">
              <div className="space-y-4 max-w-sm">
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm">Upload progress</span>
                    <span className="text-sm text-muted-foreground">{progress}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Loading States">
              <ComponentRow label="Spinner">
                <Loader2 className="h-4 w-4 animate-spin" />
                <Loader2 className="h-6 w-6 animate-spin" />
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </ComponentRow>
              <ComponentRow label="Skeleton">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-[200px]" />
                  <Skeleton className="h-4 w-[160px]" />
                </div>
              </ComponentRow>
            </ComponentGroup>

            <ComponentGroup title="Empty States (Animated)">
              <p className="text-sm text-muted-foreground mb-3">
                Animated empty states with CTAs for tables. Uses <code className="text-xs bg-muted px-1 py-0.5 rounded">TableEmptyState</code> component.
                <span className="block mt-1 text-xs text-muted-foreground/70">Used in: <code className="bg-muted px-1 py-0.5 rounded">data-table.tsx</code>, <code className="bg-muted px-1 py-0.5 rounded">files-data-table.tsx</code></span>
              </p>

              <Tabs defaultValue="transactions" className="w-full">
                <TabsList className="mb-4">
                  <TabsTrigger value="transactions">Transactions</TabsTrigger>
                  <TabsTrigger value="files">Files</TabsTrigger>
                  <TabsTrigger value="partners">Partners</TabsTrigger>
                  <TabsTrigger value="sizes">Size Variants</TabsTrigger>
                </TabsList>

                <TabsContent value="transactions" className="space-y-4">
                  {/* Transactions - No Data */}
                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                      No Data (First Time User)
                    </div>
                    <TableEmptyState
                      icon={<Receipt className="h-full w-full" />}
                      title={emptyStatePresets.transactions.noData.title}
                      description={emptyStatePresets.transactions.noData.description}
                      action={{
                        label: emptyStatePresets.transactions.noData.actionLabel,
                        onClick: () => {},
                        icon: <Landmark className="h-4 w-4" />,
                      }}
                    />
                  </div>

                  {/* Transactions - No Results */}
                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                      No Filter Results
                    </div>
                    <TableEmptyState
                      icon={<Search className="h-full w-full" />}
                      title={emptyStatePresets.transactions.noResults.title}
                      description={emptyStatePresets.transactions.noResults.description}
                      action={{
                        label: emptyStatePresets.transactions.noResults.actionLabel,
                        onClick: () => {},
                      }}
                      size="sm"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="files" className="space-y-4">
                  {/* Files - No Data */}
                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                      No Data (First Time User)
                    </div>
                    <TableEmptyState
                      icon={<FileText className="h-full w-full" />}
                      title={emptyStatePresets.files.noData.title}
                      description={emptyStatePresets.files.noData.description}
                      action={{
                        label: emptyStatePresets.files.noData.actionLabel,
                        onClick: () => {},
                        icon: <Upload className="h-4 w-4" />,
                      }}
                    />
                  </div>

                  {/* Files - No Results */}
                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                      No Filter Results
                    </div>
                    <TableEmptyState
                      icon={<Search className="h-full w-full" />}
                      title={emptyStatePresets.files.noResults.title}
                      description={emptyStatePresets.files.noResults.description}
                      action={{
                        label: emptyStatePresets.files.noResults.actionLabel,
                        onClick: () => {},
                      }}
                      size="sm"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="partners" className="space-y-4">
                  {/* Partners - No Data */}
                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                      No Data
                    </div>
                    <TableEmptyState
                      icon={<User className="h-full w-full" />}
                      title={emptyStatePresets.partners.noData.title}
                      description={emptyStatePresets.partners.noData.description}
                      action={{
                        label: emptyStatePresets.partners.noData.actionLabel,
                        onClick: () => {},
                        icon: <Plus className="h-4 w-4" />,
                      }}
                    />
                  </div>

                  {/* Partners - No Results */}
                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                      No Search Results
                    </div>
                    <TableEmptyState
                      icon={<Search className="h-full w-full" />}
                      title={emptyStatePresets.partners.noResults.title}
                      description={emptyStatePresets.partners.noResults.description}
                      action={{
                        label: emptyStatePresets.partners.noResults.actionLabel,
                        onClick: () => {},
                      }}
                      size="sm"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="sizes">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                        Small
                      </div>
                      <TableEmptyState
                        icon={<FileText className="h-full w-full" />}
                        title="No files"
                        size="sm"
                      />
                    </div>
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                        Default
                      </div>
                      <TableEmptyState
                        icon={<FileText className="h-full w-full" />}
                        title="No files"
                        size="default"
                      />
                    </div>
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-muted/30 px-3 py-1.5 border-b text-xs font-medium text-muted-foreground">
                        Large
                      </div>
                      <TableEmptyState
                        icon={<FileText className="h-full w-full" />}
                        title="No files"
                        size="lg"
                      />
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </ComponentGroup>

            <ComponentGroup title="Empty States (Simple)">
              <p className="text-sm text-muted-foreground mb-3">
                Simple text-only empty state for inline/minimal contexts.
              </p>
              <div className="border rounded-lg p-6 text-center bg-muted/30">
                <p className="text-sm text-muted-foreground">No transactions match your filters.</p>
              </div>
            </ComponentGroup>

            {/* ===== OVERLAYS & POPOVERS ===== */}
            <SectionHeader id="overlays" title="Overlays & Popovers" />
            <ComponentGroup title="Tooltips">
              <div className="flex gap-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline">Hover me</Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>This is a tooltip</p>
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon">
                      <Info className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>More information about this feature</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Popovers">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">Open Popover</Button>
                </PopoverTrigger>
                <PopoverContent className="w-80">
                  <div className="space-y-4">
                    <h4 className="font-medium">Popover Content</h4>
                    <p className="text-sm text-muted-foreground">
                      Popovers are used for filters, settings panels, and other contextual content.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="flex-1">Cancel</Button>
                      <Button size="sm" className="flex-1">Apply</Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </ComponentGroup>

            <ComponentGroup title="Drag & Drop Zone">
              <div className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
                <p className="font-medium">Drop files here or click to upload</p>
                <p className="text-sm text-muted-foreground">PDF, JPG, PNG up to 10MB</p>
              </div>
            </ComponentGroup>

            <ComponentGroup title="Upload Overlay (Active State)">
              <div className="border-2 border-dashed border-primary rounded-lg p-8 text-center bg-primary/10">
                <Upload className="h-12 w-12 mx-auto text-primary mb-4" />
                <p className="text-lg font-medium">Drop file to upload</p>
                <p className="text-sm text-muted-foreground">PDF, JPG, PNG, or WebP up to 10MB</p>
              </div>
            </ComponentGroup>



            {/* Spacer at bottom */}
            <div className="h-20" />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
