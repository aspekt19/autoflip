"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  reduceAccountLoad,
  readAccountFetch,
  type AccountLoadPhase,
  type AccountSnapshot,
} from "@/domain/account-load";

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
  const bodyRef = useRef<AccountSnapshot | null>(null);

  const apply = useCallback((next: { phase: AccountLoadPhase; body: AccountSnapshot | null }) => {
    phaseRef.current = next.phase;
    bodyRef.current = next.body;
    setPhase(next.phase);
    setBody(next.body);
  }, []);

  const load = useCallback(async (mode: "replace" | "preserve-loaded") => {
    const token = ++gen.current;
    const prev = { phase: phaseRef.current, body: bodyRef.current };
    const started = reduceAccountLoad(prev, { type: "start", mode });
    if (started.phase !== prev.phase || started.body !== prev.body) apply(started);
    try {
      const response = await fetch("/api/account", { cache: "no-store" });
      const result = await readAccountFetch(response);
      if (token !== gen.current) return;
      apply(reduceAccountLoad({ phase: phaseRef.current, body: bodyRef.current }, { type: "result", result }));
    } catch {
      if (token !== gen.current) return;
      apply(
        reduceAccountLoad(
          { phase: phaseRef.current, body: bodyRef.current },
          { type: "result", result: { phase: "failed" } },
        ),
      );
    }
  }, [apply]);

  useEffect(() => {
    void load(phaseRef.current === "loaded" ? "preserve-loaded" : "replace");
  }, [load, reloadKey]);

  const retry = useCallback(() => {
    void load("replace");
  }, [load]);

  const reload = useCallback(() => load("preserve-loaded"), [load]);

  return { phase, body, retry, reload };
}
