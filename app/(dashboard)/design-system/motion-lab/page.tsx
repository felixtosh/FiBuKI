"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { LabTable, type LabRow } from "./lab-table";
import {
  DEFAULT_SETTINGS,
  EASING_PRESETS,
  bezierCss,
  fromJson,
  toJson,
  type Bezier,
  type LabSettings,
} from "./settings";

/*
 * Motion lab: tune how rows arrive, change and leave in a list, on a table
 * made of the real row parts. Nothing here changes the app; the JSON at the
 * bottom of the sidebar is the hand-off to turn a setting into real tokens.
 */

const STORAGE_KEY = "fibuki.motionLab.settings";

const SAMPLE: Omit<LabRow, "id" | "version">[] = [
  { date: "15.03.2026", text: "A1 TELEKOM AUSTRIA RECHNUNG 03/26", amount: -4990, partner: "A1 Telekom", fileAmount: 4990 },
  { date: "14.03.2026", text: "Kunde GmbH Invoice 2026-12", amount: 120000, partner: "Kunde GmbH" },
  { date: "12.03.2026", text: "AMAZON EU SARL", amount: -2399 },
  { date: "10.03.2026", text: "WIENER LINIEN JAHRESKARTE", amount: -36500, partner: "Wiener Linien", fileAmount: 36500 },
  { date: "08.03.2026", text: "SVS BEITRAG Q1", amount: -82015 },
  { date: "05.03.2026", text: "HETZNER ONLINE GMBH", amount: -1890, partner: "Hetzner" },
  { date: "03.03.2026", text: "SPAR DANKT 4711", amount: -1245 },
  { date: "01.03.2026", text: "Kundin Huber Honorar", amount: 85000 },
];

const ARRIVALS: Omit<LabRow, "id" | "version">[] = [
  { date: "16.03.2026", text: "GOOGLE WORKSPACE", amount: -1380 },
  { date: "16.03.2026", text: "ADOBE CREATIVE CLOUD", amount: -6599 },
  { date: "17.03.2026", text: "ÖBB TICKET WIEN-LINZ", amount: -3790 },
  { date: "17.03.2026", text: "Kunde GmbH Invoice 2026-13", amount: 96000 },
];

let nextId = 0;
const makeRows = (items: Omit<LabRow, "id" | "version">[], animate: boolean): LabRow[] =>
  items.map((item, i) => ({ ...item, id: `r${nextId++}`, version: 0, enterIndex: animate ? i : undefined }));

function loadSettings(): LabSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? fromJson(saved) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function MotionLabPage() {
  const [settings, setSettings] = useState<LabSettings>(DEFAULT_SETTINGS);
  const [rows, setRows] = useState<LabRow[]>(() => makeRows(SAMPLE, false));
  const [slow, setSlow] = useState(1);
  const [auto, setAuto] = useState(false);
  const arrivals = useRef(0);

  // Settings come back from this browser after the first render, so the server
  // render and the first client render agree.
  useEffect(() => {
    setSettings(loadSettings());
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, toJson(settings));
    } catch {
      // Private window or blocked storage: the lab still works, it just forgets.
    }
  }, [settings]);

  const loadList = useCallback(() => setRows(makeRows(SAMPLE, true)), []);

  const arrive = useCallback(() => {
    const start = arrivals.current % ARRIVALS.length;
    arrivals.current += 2;
    const batch = [ARRIVALS[start], ARRIVALS[(start + 1) % ARRIVALS.length]];
    setRows((current) => [
      ...makeRows(batch, true),
      ...current.map((row) => ({ ...row, enterIndex: undefined })),
    ]);
  }, []);

  // Each press moves one unfinished row a step on: Partner, then File.
  const change = useCallback(() => {
    setRows((current) => {
      const index = current.findIndex((row) => !row.leaving && (!row.partner || row.fileAmount === undefined));
      if (index === -1) return makeRows(SAMPLE, false);
      return current.map((row, i) => {
        if (i !== index) return row;
        const next = row.partner
          ? { ...row, fileAmount: Math.abs(row.amount) }
          : { ...row, partner: row.text.split(" ")[0].replace(/^\w/, (c) => c.toUpperCase()) };
        return { ...next, version: row.version + 1 };
      });
    });
  }, []);

  const leave = useCallback(() => {
    setRows((current) => {
      const candidates = current.filter((row) => !row.leaving);
      const target = candidates[Math.min(2, candidates.length - 1)];
      return target ? current.map((row) => (row.id === target.id ? { ...row, leaving: true } : row)) : current;
    });
  }, []);

  const onLeft = useCallback((id: string) => setRows((current) => current.filter((row) => row.id !== id)), []);

  useEffect(() => {
    if (!auto) return;
    const steps = [arrive, change, change, leave];
    let i = 0;
    const timer = setInterval(() => steps[i++ % steps.length](), 1800 * slow);
    return () => clearInterval(timer);
  }, [auto, slow, arrive, change, leave]);

  const set = <K extends keyof LabSettings>(group: K, patch: Partial<LabSettings[K]>) =>
    setSettings((s) => ({ ...s, [group]: { ...s[group], ...patch } }));

  return (
    <div className="h-[calc(100vh-3.5rem)] flex overflow-hidden">
      <aside className="w-80 shrink-0 border-r bg-muted/30 overflow-y-auto">
        <div className="p-4 border-b space-y-1">
          <Link href="/design-system" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" />
            Design System
          </Link>
          <h1 className="text-lg font-semibold">Motion lab</h1>
          <p className="text-xs text-muted-foreground">Tune how rows arrive, change and leave. Copy the JSON at the bottom to hand it over.</p>
        </div>

        <Group title="Rows arrive">
          <Slider label="Duration" unit="ms" min={0} max={1200} step={10} value={settings.enter.duration} onChange={(v) => set("enter", { duration: v })} />
          <CurveEditor value={settings.enter.easing} onChange={(v) => set("enter", { easing: v })} />
          <Slider label="Delay between rows" unit="ms" min={0} max={200} step={5} value={settings.enter.rowStagger} onChange={(v) => set("enter", { rowStagger: v })} />
          <Slider label="Delay between cells" unit="ms" min={0} max={120} step={5} value={settings.enter.cellStagger} onChange={(v) => set("enter", { cellStagger: v })} />
          <Slider label="Travel up" unit="px" min={0} max={40} step={1} value={settings.enter.offsetY} onChange={(v) => set("enter", { offsetY: v })} />
          <Slider label="Start opacity" min={0} max={1} step={0.05} value={settings.enter.fromOpacity} onChange={(v) => set("enter", { fromOpacity: v })} />
          <Slider label="Start scale" min={0.8} max={1} step={0.01} value={settings.enter.fromScale} onChange={(v) => set("enter", { fromScale: v })} />
          <Toggle label="Divider line draws in" checked={settings.enter.lineDraw} onChange={(v) => set("enter", { lineDraw: v })} />
          {settings.enter.lineDraw ? (
            <Slider label="Line duration" unit="ms" min={0} max={1500} step={10} value={settings.enter.lineDuration} onChange={(v) => set("enter", { lineDuration: v })} />
          ) : null}
        </Group>

        <Group title="A row changes">
          <div className="space-y-1.5">
            <Label className="text-xs">Flash</Label>
            <div className="flex flex-wrap gap-1">
              {(["complete", "info", "highlight", "none"] as const).map((flash) => (
                <Button key={flash} size="sm" variant={settings.change.flash === flash ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => set("change", { flash })}>
                  {flash}
                </Button>
              ))}
            </div>
          </div>
          <Slider label="Flash fades over" unit="ms" min={0} max={2000} step={10} value={settings.change.flashDuration} onChange={(v) => set("change", { flashDuration: v })} />
          <CurveEditor value={settings.change.easing} onChange={(v) => set("change", { easing: v })} />
          <Slider label="Changed cell duration" unit="ms" min={0} max={800} step={10} value={settings.change.cellDuration} onChange={(v) => set("change", { cellDuration: v })} />
          <Slider label="Changed cell travel" unit="px" min={0} max={20} step={1} value={settings.change.cellOffsetY} onChange={(v) => set("change", { cellOffsetY: v })} />
          <Slider label="New pill starts at scale" min={0.2} max={1} step={0.05} value={settings.change.pillFromScale} onChange={(v) => set("change", { pillFromScale: v })} />
        </Group>

        <Group title="A row leaves">
          <Slider label="Duration" unit="ms" min={0} max={800} step={10} value={settings.leave.duration} onChange={(v) => set("leave", { duration: v })} />
          <CurveEditor value={settings.leave.easing} onChange={(v) => set("leave", { easing: v })} />
          <Slider label="Slide right" unit="px" min={0} max={60} step={1} value={settings.leave.offsetX} onChange={(v) => set("leave", { offsetX: v })} />
          <Toggle label="Rows below close the gap" checked={settings.leave.collapse} onChange={(v) => set("leave", { collapse: v })} />
        </Group>

        <JsonPanel settings={settings} onLoad={setSettings} />
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={loadList}>Load list</Button>
            <Button size="sm" variant="outline" onClick={arrive}>New rows arrive</Button>
            <Button size="sm" variant="outline" onClick={change}>Change a row</Button>
            <Button size="sm" variant="outline" onClick={leave}>Remove a row</Button>
            <div className="ml-auto flex items-center gap-3">
              <Toggle label="Auto-play" checked={auto} onChange={setAuto} />
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">Speed</span>
                {[1, 2, 4, 10].map((factor) => (
                  <Button key={factor} size="sm" variant={slow === factor ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => setSlow(factor)}>
                    {factor === 1 ? "1x" : `1/${factor}`}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          <LabTable rows={rows} settings={settings} slow={slow} onLeft={onLeft} />
          <p className="text-xs text-muted-foreground">
            The rows use the real Pill and AmountMatchDisplay. &quot;Change a row&quot; assigns a Partner, then connects a File, which completes the row.
          </p>
        </div>
      </main>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="p-4 border-b space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Slider({
  label,
  unit = "",
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {value}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/** Pick a preset or drag the four numbers of a cubic-bezier; the curve shows the result. */
function CurveEditor({ value, onChange }: { value: Bezier; onChange: (value: Bezier) => void }) {
  const [x1, y1, x2, y2] = value;
  const size = 96;
  const pad = 12;
  const px = (x: number) => pad + x * size;
  const py = (y: number) => pad + (1 - y) * size;
  const preset = EASING_PRESETS.find((p) => p.value.every((n, i) => Math.abs(n - value[i]) < 0.001));
  const setPoint = (i: number, n: number) => onChange(value.map((v, j) => (j === i ? n : v)) as Bezier);

  return (
    <div className="space-y-2">
      <span className="flex justify-between text-xs">
        <span>Curve</span>
        <span className="text-muted-foreground">{preset ? (preset.token ?? preset.name) : "custom"}</span>
      </span>
      <div className="flex flex-wrap gap-1">
        {EASING_PRESETS.map((p) => (
          <Button key={p.name} size="sm" variant={preset === p ? "secondary" : "ghost"} className="h-6 px-2 text-[11px]" onClick={() => onChange(p.value)}>
            {p.name}
          </Button>
        ))}
      </div>
      <div className="flex gap-3">
        <svg width={size + pad * 2} height={size + pad * 2} className="shrink-0 rounded border bg-background overflow-visible" aria-hidden="true">
          <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} className="stroke-border" strokeDasharray="3 3" />
          <line x1={px(0)} y1={py(0)} x2={px(x1)} y2={py(y1)} className="stroke-muted-foreground" />
          <line x1={px(1)} y1={py(1)} x2={px(x2)} y2={py(y2)} className="stroke-muted-foreground" />
          <path
            d={`M ${px(0)} ${py(0)} C ${px(x1)} ${py(y1)}, ${px(x2)} ${py(y2)}, ${px(1)} ${py(1)}`}
            className="stroke-primary"
            strokeWidth={2}
            fill="none"
          />
          <circle cx={px(x1)} cy={py(y1)} r={3} className="fill-primary" />
          <circle cx={px(x2)} cy={py(y2)} r={3} className="fill-primary" />
        </svg>
        <div className="flex-1 space-y-1">
          {(["x1", "y1", "x2", "y2"] as const).map((name, i) => (
            <label key={name} className="flex items-center gap-2 text-[11px]">
              <span className="w-4 text-muted-foreground">{name}</span>
              <input
                type="range"
                min={name.startsWith("x") ? 0 : -0.5}
                max={name.startsWith("x") ? 1 : 1.6}
                step={0.01}
                value={value[i]}
                onChange={(e) => setPoint(i, Number(e.target.value))}
                className="min-w-0 flex-1 accent-primary"
              />
              <span className="w-9 text-right tabular-nums">{value[i].toFixed(2)}</span>
            </label>
          ))}
        </div>
      </div>
      <code className="block text-[10px] text-muted-foreground">{bezierCss(value)}</code>
    </div>
  );
}

function JsonPanel({ settings, onLoad }: { settings: LabSettings; onLoad: (settings: LabSettings) => void }) {
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const json = toJson(settings);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy; select the text and copy it by hand.");
    }
  };
  const apply = () => {
    try {
      onLoad(fromJson(draft ?? json));
      setDraft(null);
      setError(null);
    } catch {
      setError("That is not valid JSON.");
    }
  };

  return (
    <Group title="Settings as JSON">
      <textarea
        value={draft ?? json}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="h-64 w-full resize-y rounded-md border bg-background p-2 font-mono text-[11px] leading-snug"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="outline" disabled={draft === null} onClick={apply}>
          Apply pasted
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onLoad(DEFAULT_SETTINGS)}>
          <RotateCcw className={cn("h-3.5 w-3.5 mr-1.5")} />
          Reset
        </Button>
      </div>
    </Group>
  );
}
