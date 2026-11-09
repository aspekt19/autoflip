"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readAccountFetch, type AccountLoadPhase, type AccountSnapshot } from "@/domain/account-load";

/**
 * GET /api/account with loading / failed / loaded.
 * A refresh that already has a payload keeps that payload until the next response.
 */
export function useAccountLoad(reloadKey = ""): {
  phase: AccountLoadPhase;
  body: AccountSnapshot | null;
  retry: () => void;
  reload: () => Promise<void>;
} {
  const [phase, setPhase] = useState<AccountLoadPhase>("loading");
  const [body, setBody] = useState<AccountSnapshot | null>(null);
  const gen = useRef(0);
  const phaseRef = useRef<AccountLoadPhase>("loading");

  const load = useCallback(async (mode: "replace" | "preserve-loaded") => {
    const token = ++gen.current;
    if (!(mode === "preserve-loaded" && phaseRef.current === "loaded")) {
      phaseRef.current = "loading";
      setPhase("loading");
    }
    try {
      const response = await fetch("/api/account", { cache: "no-store" });
      const result = await readAccountFetch(response);
      if (token !== gen.current) return;
      if (result.phase === "failed") {
        phaseRef.current = "failed";
        setBody(null);
        setPhase("failed");
        return;
      }
      phaseRef.current = "loaded";
      setBody(result.body);
      setPhase("loaded");
    } catch {
      if (token !== gen.current) return;
      phaseRef.current = "failed";
      setBody(null);
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    void load(phaseRef.current === "loaded" ? "preserve-loaded" : "replace");
  }, [load, reloadKey]);

  const retry = useCallback(() => {
    void load("replace");
  }, [load]);

  const reload = useCallback(() => load("preserve-loaded"), [load]);

  return { phase, body, retry, reload };
}
