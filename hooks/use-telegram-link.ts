"use client";

import { useCallback, useEffect, useState } from "react";
import { callFunction } from "@/lib/firebase/callable";

export interface TelegramLinkStatus {
  available: boolean;
  linked: boolean;
  username: string | null;
  announcementsUrl: string | null;
}

type Empty = Record<string, never>;

/** Settings → Community: link state plus connect/disconnect, all through callables. */
export function useTelegramLink() {
  const [status, setStatus] = useState<TelegramLinkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await callFunction<Empty, TelegramLinkStatus>("getTelegramLinkStatus", {}));
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    try {
      await work();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = useCallback(
    () =>
      run(async () => {
        const res = await callFunction<Empty, { url: string }>("createTelegramLink", {});
        setUrl(res.url);
        window.open(res.url, "_blank", "noopener,noreferrer");
      }),
    [run],
  );

  const disconnect = useCallback(
    () =>
      run(async () => {
        await callFunction<Empty, { success: boolean }>("unlinkTelegram", {});
        setUrl(null);
        await load();
      }),
    [run, load],
  );

  return { status, busy, error, url, connect, disconnect };
}
