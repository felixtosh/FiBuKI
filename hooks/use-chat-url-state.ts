"use client";

import { useCallback, useEffect, useRef } from "react";
import { parseChatUrlState, buildNextChatUrl } from "@/lib/chat/chat-url-state";

type SearchParamsLike = {
  get: (name: string) => string | null;
  toString: () => string;
};

type RouterLike = {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
};

export interface ChatUrlState {
  hasChatParam: boolean;
  isSidebarOpen: boolean;
  sessionId: string | null;
}

export interface ChatNavigationContext {
  pathnameChanged: boolean;
  isPopStateNavigation: boolean;
}

export function useChatUrlState(args: {
  pathname: string;
  searchParams: SearchParamsLike;
  router: RouterLike;
}) {
  const { pathname, searchParams, router } = args;

  const searchParamsRef = useRef(searchParams);
  const lastPathnameRef = useRef(pathname);
  const isPopStateNavigationRef = useRef(false);

  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);

  useEffect(() => {
    const handlePopState = () => {
      isPopStateNavigationRef.current = true;
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  const readUrlState = useCallback(() => parseChatUrlState(searchParamsRef.current), []);

  const readNavigationContext = useCallback((): ChatNavigationContext => {
    const pathnameChanged = lastPathnameRef.current !== pathname;
    lastPathnameRef.current = pathname;
    const isPopStateNavigation = isPopStateNavigationRef.current;
    isPopStateNavigationRef.current = false;
    return { pathnameChanged, isPopStateNavigation };
  }, [pathname]);

  const updateUrlState = useCallback((updates: {
    isSidebarOpen: boolean;
    sessionId: string | null;
    historyMode: "push" | "replace";
  }) => {
    const nextUrl = buildNextChatUrl(pathname, searchParamsRef.current, {
      isSidebarOpen: updates.isSidebarOpen,
      sessionId: updates.sessionId,
    });

    if (!nextUrl) return;
    if (updates.historyMode === "push") {
      router.push(nextUrl, { scroll: false });
      return;
    }
    router.replace(nextUrl, { scroll: false });
  }, [pathname, router]);

  return {
    readUrlState,
    readNavigationContext,
    updateUrlState,
  };
}
