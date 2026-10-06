import type { ComponentType } from "react";

/**
 * What a component in components/ui/ is, in layers:
 * - primitive: a generic building block with no FiBuKI meaning (Button, Dialog)
 * - pattern:   a FiBuKI building block made of primitives (ChoiceFilter, ProgressCounter)
 * - brand:     logos and the mascot
 */
export type DesignLayer = "primitive" | "pattern" | "brand";

export interface DesignExample {
  name: string;
  /** A component, not a render function, so an example can keep its own state. */
  Example: ComponentType;
}

/**
 * The default export of every `components/ui/<name>.examples.tsx`. The
 * design-system page renders these, the render test mounts them, and the
 * new-component hook prints `purpose` so a new component is checked against
 * the existing ones before it is written.
 */
export interface ComponentDoc {
  title: string;
  /** One line: when to use it. Keep it on one line as a plain string literal; scripts read it. */
  purpose: string;
  layer: DesignLayer;
  examples: DesignExample[];
}
