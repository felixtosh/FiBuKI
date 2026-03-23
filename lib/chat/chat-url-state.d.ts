export interface ParsedChatUrlState {
  hasChatParam: boolean;
  isSidebarOpen: boolean;
  sessionId: string | null;
}

export function parseChatUrlState(params: {
  get: (name: string) => string | null;
}): ParsedChatUrlState;

export function consumeChatUrlParam(): void;
