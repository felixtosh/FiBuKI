"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { Building2, Check, Info, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Pill } from "@/components/ui/pill";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/*
 * Every animation the app actually uses, with the classes and curve it really
 * runs. scripts/check-design-system.mjs fails when globals.css defines an
 * `animate-*` class or an `--ease-*` token that is not listed here, so an
 * unused one shows up as unused instead of sitting in the theme.
 */

export interface MotionEntry {
  name: string;
  /** Where it runs. */
  used: string;
  /** Duration and curve, as the code has them. */
  timing: string;
  /** The classes or token to reuse it. */
  code: string;
  Demo: ComponentType;
}

export interface MotionGroup {
  title: string;
  intro: string;
  entries: MotionEntry[];
}

/** Re-mounts its child on every press, so a one-shot animation plays again. */
function Replay({ children }: { children: (run: number) => ReactNode }) {
  const [run, setRun] = useState(0);
  return (
    <div className="flex items-center gap-4">
      <Button size="sm" variant="outline" onClick={() => setRun((r) => r + 1)}>
        Play
      </Button>
      <div key={run} className="min-h-10 flex items-center">
        {children(run)}
      </div>
    </div>
  );
}

function ChatSidebarSlide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
        {open ? "Close" : "Open"}
      </Button>
      <div className="relative h-24 w-full max-w-md overflow-hidden rounded-md border bg-muted/40">
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-40 border-r bg-background p-2 text-xs transition-transform duration-300 ease-slide",
            open ? "translate-x-0" : "-translate-x-full"
          )}
        >
          Chat
        </div>
      </div>
    </div>
  );
}

function DetailPanelMakeRoom() {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
        {open ? "Close" : "Open"}
      </Button>
      <div className="relative h-24 w-full max-w-md overflow-hidden rounded-md border">
        <div
          className="h-full bg-muted/40 p-2 text-xs transition-[margin] duration-200 ease-slide"
          style={{ marginRight: open ? 160 : 0 }}
        >
          List
        </div>
        {open && <div className="absolute inset-y-0 right-0 w-40 border-l bg-background p-2 text-xs">Panel</div>}
      </div>
    </div>
  );
}

function SheetDemo() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">Open sheet</Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  );
}

function PopUpDemo() {
  return (
    <div className="flex flex-wrap gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline">Popover</Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 text-sm" align="start">
          A filter or picker.
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">Menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dialog</DialogTitle>
          <DialogDescription>Fades and grows from 95%.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}

const box = "rounded-md border bg-background px-3 py-2 text-sm";

/** The list motions run on a real table; the lab is where to see and tune them. */
function MotionLabLink() {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href="/design-system/motion-lab">Try it in the motion lab</Link>
    </Button>
  );
}

export const motionGroups: MotionGroup[] = [
  {
    title: "Panels and menus",
    intro: "Everything that slides or pops in and out shares one curve, --ease-slide. Change it in app/globals.css and every one of these follows.",
    entries: [
      {
        name: "Chat sidebar",
        used: "chat-sidebar.tsx",
        timing: "300ms, --ease-slide",
        code: "transition-transform duration-300 ease-slide",
        Demo: ChatSidebarSlide,
      },
      {
        name: "List makes room for the detail panel",
        used: "DetailPanelLayout (Files, Transactions, Partners)",
        timing: "200ms, --ease-slide",
        code: "transition-[margin] duration-200 ease-slide",
        Demo: DetailPanelMakeRoom,
      },
      {
        name: "Sheet",
        used: "Sheet: the phone's filter panel, mobile menus",
        timing: "150ms, --ease-slide",
        code: "slide-in-from-right / slide-out-to-right",
        Demo: SheetDemo,
      },
      {
        name: "Pop-ups",
        used: "Popover, DropdownMenu, Select, Tooltip",
        timing: "150ms, --ease-slide",
        code: "fade-in-0 zoom-in-95 slide-in-from-top-2",
        Demo: PopUpDemo,
      },
      {
        name: "Dialog",
        used: "Dialog, AlertDialog",
        timing: "200ms, --ease-slide",
        code: "fade-in-0 zoom-in-95",
        Demo: DialogDemo,
      },
      {
        name: "Page enter",
        used: "app/(dashboard)/template.tsx, on every navigation",
        timing: "200ms, ease-out, opacity only (any transform there breaks the fixed detail panels)",
        code: "animate-page-in",
        Demo: () => <Replay>{() => <div className={cn(box, "animate-page-in")}>Page content</div>}</Replay>,
      },
    ],
  },
  {
    title: "Feedback",
    intro: "Short one-shot animations when something changes: a match lands, a row completes, a count goes up.",
    entries: [
      {
        name: "Rows arrive",
        used: "Transactions table, rows new to the list (not rows scrolled into view)",
        timing: "320ms, 40ms apart, 8px up, --ease-out-expo",
        code: "LIST_MOTION.enter (lib/motion/settings.ts)",
        Demo: () => <MotionLabLink />,
      },
      {
        name: "Row turns green, or back",
        used: "Transactions table, a row completing or no longer complete on screen",
        timing: "600ms liquid, intensity 0.1, cubic-bezier(0.65, 0, 0.28, 1)",
        code: "LIST_MOTION.change (lib/motion/settings.ts)",
        Demo: () => <MotionLabLink />,
      },
      {
        name: "Rows glide",
        used: "Transactions table, the other rows when rows arrive or leave",
        timing: "250ms, --ease-slide",
        code: "LIST_MOTION.leave (lib/motion/settings.ts)",
        Demo: () => <MotionLabLink />,
      },
      {
        name: "Pill pops in",
        used: "Pill, PartnerPill (a Partner or Category is assigned)",
        timing: "250ms, --ease-out-back",
        code: "animate-pill-pop",
        Demo: () => <Replay>{() => <Pill label="A1 Telekom" icon={Building2} animate />}</Replay>,
      },
      {
        name: "Check appears",
        used: "AmountMatchDisplay, upload progress",
        timing: "300ms, --ease-out-back",
        code: "animate-check-appear",
        Demo: () => <Replay>{() => <Check className="h-5 w-5 text-green-600 animate-check-appear" />}</Replay>,
      },
      {
        name: "Counter bumps",
        used: "ProgressCounter, suggestion counts",
        timing: "250ms, --ease-out-back",
        code: "animate-counter-bump",
        Demo: () => <Replay>{(run) => <span className="inline-block text-lg font-medium tabular-nums animate-counter-bump">{18 + run}</span>}</Replay>,
      },
      {
        name: "List items stagger in",
        used: "Import progress",
        timing: "300ms each, 80ms apart, --ease-out-expo",
        code: "animate-stagger-in + style --stagger-index",
        Demo: () => (
          <Replay>
            {() => (
              <div className="space-y-1">
                {["Main Account", "Kreditkarte", "PayPal"].map((name, i) => (
                  <div key={name} className={cn(box, "py-1 animate-stagger-in")} style={{ "--stagger-index": i } as React.CSSProperties}>
                    {name}
                  </div>
                ))}
              </div>
            )}
          </Replay>
        ),
      },
      {
        name: "Suggestion accepted",
        used: "File detail: a Transaction suggestion is accepted",
        timing: "500ms, --ease-out-expo",
        code: "animate-suggestion-accept",
        Demo: () => <Replay>{() => <div className={cn(box, "w-64 animate-suggestion-accept")}>Suggested: A1 Telekom</div>}</Replay>,
      },
      {
        name: "Suggestion dismissed",
        used: "File detail: a Transaction suggestion is declined",
        timing: "350ms, --ease-out-expo",
        code: "animate-suggestion-dismiss",
        Demo: () => <Replay>{() => <div className={cn(box, "w-64 animate-suggestion-dismiss")}>Suggested: A1 Telekom</div>}</Replay>,
      },
      {
        name: "Info icon appears",
        used: "Settings, identity page",
        timing: "400ms after 200ms, --ease-out-back",
        code: "animate-info-icon-in",
        Demo: () => <Replay>{() => <Info className="h-5 w-5 text-info-foreground animate-info-icon-in" />}</Replay>,
      },
      {
        name: "Skeleton shimmer",
        used: "Skeleton with shimmer, while a list loads",
        timing: "1.5s, ease-in-out, repeating",
        code: "<Skeleton shimmer />",
        Demo: () => <Skeleton shimmer className="h-4 w-64" />,
      },
    ],
  },
  {
    title: "Mascot and landing page",
    intro: "Playful, only on the landing page, the logo and empty states.",
    entries: [
      {
        name: "Floating icon",
        used: "TableEmptyState icon",
        timing: "3.5s, ease-in-out, repeating",
        code: "animate-float-medium",
        Demo: () => <Plus className="h-8 w-8 text-muted-foreground animate-float-medium" />,
      },
      {
        name: "Mascot walks",
        used: "Landing page hero",
        timing: "180ms, ease-in-out, repeating",
        code: "animate-wiggle",
        Demo: () => <span className="inline-block text-2xl animate-wiggle">F</span>,
      },
      {
        name: "Letters fall and grow back",
        used: "Landing page hero game",
        timing: "600ms ease-in, then 400ms ease-out",
        code: "animate-letter-fall, animate-letter-grow",
        Demo: () => <Replay>{() => <span className="inline-block text-2xl font-bold animate-letter-grow">B</span>}</Replay>,
      },
    ],
  },
];
