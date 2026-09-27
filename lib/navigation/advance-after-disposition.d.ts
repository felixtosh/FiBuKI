export function advanceAfterDisposition(args: {
  orderedIds: string[];
  currentId: string | null | undefined;
  mutate: () => Promise<unknown>;
  navigateTo: (id: string) => void;
}): Promise<string | null>;
