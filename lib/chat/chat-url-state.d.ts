export interface ParsedChatUrlState {
  hasChatParam: boolean;
  isSidebarOpen: boolean;
  sessionId: string | null;
}

export function parseChatUrlState(params: {
  get: (name: string) => string | null;
}): ParsedChatUrlState;

export function buildNextChatUrl(
  pathname: string,
  currentParams: { toString: () => string },
  nextState: { isSidebarOpen: boolean; sessionId: string | null }
): string | null;
