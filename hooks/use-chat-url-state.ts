"use client";

import { useCallback, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { parseChatUrlState, consumeChatUrlParam } from "@/lib/chat/chat-url-state";

export interface ChatUrlCommand {
  hasChatParam: boolean;
  isSidebarOpen: boolean;
  sessionId: string | null;
}

/**
 * Reads the URL `?chat=` param once on first mount via lazy useState init,
 * and provides a consume function to silently strip it. No ongoing URL sync —
 * state lives in localStorage after the initial read.
 */
export function useChatUrlCommand() {
  const searchParams = useSearchParams();
  const consumedRef = useRef(false);

  // Lazy init captures the URL state exactly once. We intentionally do not
  // refresh on subsequent searchParams changes since the param is consumed
  // right after reading.
  const [initialCommand] = useState<ChatUrlCommand>(() =>
    parseChatUrlState(searchParams),
  );

  const consumeParam = useCallback(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    consumeChatUrlParam();
  }, []);

  return {
    initialCommand,
    consumeParam,
  };
}
