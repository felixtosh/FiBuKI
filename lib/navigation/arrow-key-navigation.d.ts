export function isTypingTarget(target: EventTarget | null | undefined): boolean;
export function isOverlayOpen(doc: Document | null | undefined): boolean;
export function getArrowNavigationStep(
  event: KeyboardEvent | null | undefined,
): number | null;
export function isRowNavigationEnabled(state: {
  panelOpen: boolean;
  connectOverlayOpen: boolean;
}): boolean;
