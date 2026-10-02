"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { replaceQuery } from "@/lib/navigation/query-url";
import { queryToRestore, rememberableQuery } from "@/lib/filters/remembered-query";

/**
 * Keeps a list's filters and search across page switches (#530), the way the
 * Transactions page already does: whatever the user set is remembered in this
 * browser, and put back when they return to the bare list. See
 * lib/filters/remembered-query.js for which URLs are restored onto.
 *
 * The first run reads before it writes, so the bare URL a user arrives on
 * cannot overwrite what it is about to restore.
 */
export function useRememberedListQuery(listKey: string, path: string): void {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const restoredRef = useRef(false);

  useEffect(() => {
    const storageKey = `fibuki.listQuery.${listKey}`;
    if (!restoredRef.current) {
      restoredRef.current = true;
      const restore = queryToRestore(query, readStorage(storageKey));
      if (restore) {
        replaceQuery(router, `${path}?${restore}`);
        return;
      }
    }
    writeStorage(storageKey, rememberableQuery(query));
  }, [query, listKey, path, router]);
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode or blocked storage: the list just starts unfiltered.
  }
}
