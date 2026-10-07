/**
 * The theme tokens of app/globals.css (@theme), as the design-system page
 * shows them. scripts/check-design-system.mjs fails when globals.css gains a
 * color token that is not listed here (easings and animations: motion.tsx).
 */

export interface ColorToken {
  token: string;
  name: string;
  use: string;
}

export const colorGroups: { title: string; tokens: ColorToken[] }[] = [
  {
    title: "Surfaces and text",
    tokens: [
      { token: "--color-background", name: "Background", use: "Page background" },
      { token: "--color-foreground", name: "Foreground", use: "Body text" },
      { token: "--color-card", name: "Card", use: "Card background" },
      { token: "--color-card-foreground", name: "Card FG", use: "Text on a card" },
      { token: "--color-popover", name: "Popover", use: "Popover and menu background" },
      { token: "--color-popover-foreground", name: "Popover FG", use: "Text in a popover" },
      { token: "--color-muted", name: "Muted", use: "Subtle backgrounds" },
      { token: "--color-muted-foreground", name: "Muted FG", use: "Secondary text" },
      { token: "--color-border", name: "Border", use: "Dividers and outlines" },
      { token: "--color-input", name: "Input", use: "Form control borders" },
      { token: "--color-ring", name: "Ring", use: "Focus ring" },
    ],
  },
  {
    title: "Actions",
    tokens: [
      { token: "--color-primary", name: "Primary", use: "Main buttons" },
      { token: "--color-primary-foreground", name: "Primary FG", use: "Text on primary" },
      { token: "--color-secondary", name: "Secondary", use: "Secondary buttons, set filters" },
      { token: "--color-secondary-foreground", name: "Secondary FG", use: "Text on secondary" },
      { token: "--color-accent", name: "Accent", use: "Hover backgrounds" },
      { token: "--color-accent-foreground", name: "Accent FG", use: "Text on accent" },
      { token: "--color-destructive", name: "Destructive", use: "Deletes and errors" },
      { token: "--color-destructive-foreground", name: "Destructive FG", use: "Text on destructive" },
    ],
  },
  {
    title: "Meaning",
    tokens: [
      { token: "--color-amount-positive", name: "Amount +", use: "Income amounts" },
      { token: "--color-amount-negative", name: "Amount -", use: "Expense amounts" },
      { token: "--color-complete-row", name: "Complete row", use: "A finished Transaction" },
      { token: "--color-complete-row-selected", name: "Complete selected", use: "A finished, selected Transaction" },
      { token: "--color-info", name: "Info", use: "Tips and suggestions" },
      { token: "--color-info-foreground", name: "Info FG", use: "Text on info" },
      { token: "--color-info-border", name: "Info border", use: "Outline of info boxes" },
      { token: "--color-highlight", name: "Highlight", use: "Search matches" },
    ],
  },
  {
    title: "Charts",
    tokens: [
      { token: "--color-chart-1", name: "Chart 1", use: "Chart series" },
      { token: "--color-chart-2", name: "Chart 2", use: "Chart series" },
      { token: "--color-chart-3", name: "Chart 3", use: "Chart series" },
      { token: "--color-chart-4", name: "Chart 4", use: "Chart series" },
      { token: "--color-chart-5", name: "Chart 5", use: "Chart series" },
    ],
  },
];
