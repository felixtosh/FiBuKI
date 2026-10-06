"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ComponentDoc, DesignLayer } from "@/lib/design-system/types";
import { cn } from "@/lib/utils";
import { componentDocs } from "./registry";
import { colorGroups, motionTokens } from "./tokens";

/*
 * Every component below is the real one from components/ui, rendered by the
 * examples file next to it. This page holds no component markup of its own;
 * to change what it shows, change a `*.examples.tsx`. See
 * scripts/check-design-system.mjs for what CI enforces.
 */

const LAYERS: { layer: DesignLayer; title: string; intro: string }[] = [
  { layer: "primitive", title: "Primitives", intro: "Generic building blocks with no FiBuKI meaning." },
  { layer: "pattern", title: "Patterns", intro: "FiBuKI building blocks made of primitives. Reuse these before writing a new one." },
  { layer: "brand", title: "Brand", intro: "Logos and the mascot." },
];

const FOUNDATIONS = [
  { id: "colors", title: "Colors" },
  { id: "typography", title: "Typography" },
  { id: "motion", title: "Motion" },
];

const TYPE_ROLES = [
  { classes: "text-2xl font-bold", role: "Page title" },
  { classes: "text-lg font-semibold", role: "Panel title" },
  { classes: "text-base font-medium", role: "Card title" },
  { classes: "text-sm", role: "Body text and field values" },
  { classes: "text-sm text-muted-foreground", role: "Labels and descriptions" },
  { classes: "text-xs font-semibold uppercase tracking-wider text-muted-foreground", role: "Section header" },
  { classes: "text-sm tabular-nums", role: "Amounts: -€1.234,56" },
  { classes: "font-mono text-xs", role: "IBANs, ids: AT61 1904 3002 3457 3201" },
];

const slug = (doc: ComponentDoc) => `c-${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

export default function DesignSystemPage() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("colors");
  const scrollRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (doc: ComponentDoc) =>
      !q || doc.title.toLowerCase().includes(q) || doc.purpose.toLowerCase().includes(q);
    return LAYERS.map((group) => ({
      ...group,
      docs: componentDocs
        .filter((doc) => doc.layer === group.layer && matches(doc))
        .sort((a, b) => a.title.localeCompare(b.title)),
    }));
  }, [query]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id);
      },
      { root, rootMargin: "-10% 0px -80% 0px", threshold: 0 }
    );
    root.querySelectorAll("[data-ds-section]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [groups]);

  const scrollTo = (id: string) => {
    const root = scrollRef.current;
    const el = document.getElementById(id);
    if (!root || !el) return;
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: top - 16, behavior: "smooth" });
  };

  const navItem = (id: string, label: string) => (
    <li key={id}>
      <button
        type="button"
        onClick={() => scrollTo(id)}
        className={cn(
          "w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors",
          active === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        {label}
      </button>
    </li>
  );

  return (
    <TooltipProvider>
      <div className="h-[calc(100vh-3.5rem)] flex overflow-hidden">
        <nav className="hidden md:flex w-60 shrink-0 flex-col border-r bg-muted/30">
          <div className="p-4 space-y-3 border-b">
            <h1 className="text-lg font-semibold">Design System</h1>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a component" className="h-8" />
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            <NavGroup title="Foundations">{FOUNDATIONS.map((f) => navItem(f.id, f.title))}</NavGroup>
            {groups.map((group) =>
              group.docs.length > 0 ? (
                <NavGroup key={group.layer} title={group.title}>
                  {group.docs.map((doc) => navItem(slug(doc), doc.title))}
                </NavGroup>
              ) : null
            )}
          </div>
        </nav>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-4 py-8 md:p-8 space-y-16">
            <Section id="colors" title="Colors" intro="Theme tokens from app/globals.css. Use the Tailwind class (bg-primary, text-amount-negative), never a raw color.">
              {colorGroups.map((group) => (
                <div key={group.title} className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.title}</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    {group.tokens.map((color) => (
                      <div key={color.token} className="space-y-1.5">
                        <div className="h-12 rounded-lg border shadow-sm" style={{ background: `var(${color.token})` }} />
                        <p className="text-xs font-medium">{color.name}</p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">{color.token.replace("--color-", "")}</p>
                        <p className="text-[11px] text-muted-foreground">{color.use}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Section>

            <Section id="typography" title="Typography" intro="Text styles by role. Use the role, not a size picked by eye.">
              <div className="border rounded-md divide-y">
                {TYPE_ROLES.map((t) => (
                  <div key={t.role} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 p-3">
                    <code className="sm:w-72 shrink-0 text-[11px] text-muted-foreground">{t.classes}</code>
                    <span className={t.classes}>{t.role}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section id="motion" title="Motion" intro="Duration and easing tokens from app/globals.css. Press play to compare them.">
              <MotionPreview />
            </Section>

            {groups.map((group) =>
              group.docs.length > 0 ? (
                <div key={group.layer} className="space-y-12">
                  <div className="border-t pt-8">
                    <h2 className="text-2xl font-bold">{group.title}</h2>
                    <p className="text-sm text-muted-foreground mt-1">{group.intro}</p>
                  </div>
                  {group.docs.map((doc) => (
                    <ComponentSection key={doc.title} doc={doc} />
                  ))}
                </div>
              ) : null
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro: string; children: React.ReactNode }) {
  return (
    <section id={id} data-ds-section className="space-y-4 scroll-mt-4">
      <div>
        <h2 className="text-2xl font-bold">{title}</h2>
        <p className="text-sm text-muted-foreground mt-1">{intro}</p>
      </div>
      {children}
    </section>
  );
}

function ComponentSection({ doc }: { doc: ComponentDoc }) {
  return (
    <section id={slug(doc)} data-ds-section className="space-y-3 scroll-mt-4">
      <div>
        <h3 className="text-lg font-semibold">{doc.title}</h3>
        <p className="text-sm text-muted-foreground">{doc.purpose}</p>
      </div>
      {doc.examples.map(({ name, Example }) => (
        <div key={name} className="rounded-lg border">
          <p className="px-4 py-2 border-b text-xs font-medium text-muted-foreground">{name}</p>
          <div className="p-4 overflow-x-auto">
            <Example />
          </div>
        </div>
      ))}
    </section>
  );
}

function MotionPreview() {
  const [moved, setMoved] = useState(false);
  const durations = motionTokens.filter((m) => m.token.startsWith("--duration-"));
  const easings = motionTokens.filter((m) => m.token.startsWith("--ease-"));
  const track = (key: string, label: string, use: string, style: React.CSSProperties) => (
    <div key={key} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
      <div className="sm:w-56 shrink-0">
        <code className="text-[11px]">{label}</code>
        <p className="text-[11px] text-muted-foreground">{use}</p>
      </div>
      <div className="relative h-8 flex-1 rounded-md bg-muted">
        <div
          className="absolute top-1 left-1 h-6 w-6 rounded bg-primary transition-transform"
          style={{ ...style, transform: moved ? "translateX(calc(min(60vw, 32rem) - 2rem))" : "translateX(0)" }}
        />
      </div>
    </div>
  );
  return (
    <div className="space-y-3">
      <Button size="sm" variant="outline" onClick={() => setMoved((m) => !m)}>
        Play
      </Button>
      {durations.map((m) => track(m.token, m.token, m.use, { transitionDuration: `var(${m.token})`, transitionTimingFunction: "ease-out" }))}
      {easings.map((m) => track(m.token, m.token, m.use, { transitionDuration: "700ms", transitionTimingFunction: `var(${m.token})` }))}
    </div>
  );
}
