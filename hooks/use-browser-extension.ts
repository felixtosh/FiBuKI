import { useCallback, useEffect, useRef, useState } from "react";

const EXTENSION_PING = "TAXSTUDIO_EXTENSION_PING";
const EXTENSION_PONG = "TAXSTUDIO_EXTENSION_PONG";
const EXTENSION_SOURCE = "taxstudio_extension";
const EXTENSION_MARKER = "taxstudio-extension";
const CHECK_TIMEOUT_MS = 1200;

export type BrowserExtensionStatus = "checking" | "installed" | "not_installed";

export interface BrowserExtensionState {
  status: BrowserExtensionStatus;
  version: string | null;
  lastCheckedAt: Date | null;
  checkNow: () => void;
}

export function useBrowserExtensionStatus(): BrowserExtensionState {
  const [status, setStatus] = useState<BrowserExtensionStatus>("checking");
  const [version, setVersion] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const awaitingRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);

  const checkNow = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }
    awaitingRef.current = true;
    setStatus("checking");
    setLastCheckedAt(new Date());
    const marker = document.querySelector<HTMLMetaElement>(
      `meta[name="${EXTENSION_MARKER}"]`,
    );
    if (marker) {
      awaitingRef.current = false;
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      setStatus("installed");
      setVersion(marker.getAttribute("content"));
      return;
    }
    window.postMessage({ type: EXTENSION_PING, source: "taxstudio_app" }, "*");
    timeoutRef.current = window.setTimeout(() => {
      if (awaitingRef.current) {
        awaitingRef.current = false;
        setStatus("not_installed");
        setVersion(null);
      }
    }, CHECK_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as {
        type?: string;
        source?: string;
        version?: string;
      };
      if (!data || data.type !== EXTENSION_PONG || data.source !== EXTENSION_SOURCE)
        return;
      awaitingRef.current = false;
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      setStatus("installed");
      setVersion(typeof data.version === "string" ? data.version : null);
    };

    window.addEventListener("message", handleMessage);

    // Defer the initial check to the next microtask so the setState calls
    // inside checkNow() are dispatched event-handler-style, not from within
    // the effect body.
    const initialCheckId = window.setTimeout(() => checkNow(), 0);

    return () => {
      window.clearTimeout(initialCheckId);
      window.removeEventListener("message", handleMessage);
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, [checkNow]);

  return { status, version, lastCheckedAt, checkNow };
}
