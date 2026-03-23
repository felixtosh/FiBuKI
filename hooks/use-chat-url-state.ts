"use client";

import { useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { parseChatUrlState, consumeChatUrlParam } from "@/lib/chat/chat-url-state";

export interface ChatUrlCommand {
  hasChatParam: boolean;
  isSidebarOpen: boolean;
  sessionId: string | null;
}

/**
 * Reads the URL `?chat=` param once on first call (via ref guard) and provides
 * a consume function to silently strip it. No ongoing URL sync — state lives
 * in localStorage after the initial read.
 */
export function useChatUrlCommand() {
  const searchParams = useSearchParams();
  const consumedRef = useRef(false);

  // Parse on first render only — subsequent re-renders from searchParams changes
  // won't matter because we consume the param immediately after reading.
  const initialCommandRef = useRef<ChatUrlCommand | null>(null);
  if (initialCommandRef.current === null) {
    initialCommandRef.current = parseChatUrlState(searchParams);
  }

  const consumeParam = useCallback(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    consumeChatUrlParam();
  }, []);

  return {
    initialCommand: initialCommandRef.current,
    consumeParam,
  };
}
