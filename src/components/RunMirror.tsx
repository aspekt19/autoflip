"use client";

import { useEffect, useState } from "react";
import type { RunView } from "@/domain/run-view";
import { RunReport } from "./RunReport";

function isRunView(value: unknown): value is RunView {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RunView>;
  return typeof row.id === "string" && typeof row.permalink === "string" && Array.isArray(row.steps);
}

/**
 * The live Find / Resale / Check pages read the stored run.
 * While the search is still running, this polls the same record the permalink will show.
 */
export function RunMirror({ runId }: { runId: string | null }) {
  const [run, setRun] = useState<RunView | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let stop = false;
    let timer = 0;
    setRun(null);
    setMissing(false);
    async function tick() {
      try {
        const response = await fetch(`/api/run/${runId}`);
        if (!response.ok) {
          if (!stop) setMissing(true);
          return;
        }
        const body = (await response.json()) as { run?: unknown };
        if (stop || !isRunView(body.run)) return;
        setMissing(false);
        setRun(body.run);
        if (body.run.phase === "draft" || body.run.phase === "running") {
          timer = window.setTimeout(() => void tick(), 1500);
        }
      } catch {
        if (!stop) setMissing(true);
      }
    }
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [runId]);

  if (!runId) return null;
  if (!run && missing) return <p className="hint">This search is not saved yet.</p>;
  if (!run) return <p className="hint">Loading the saved search…</p>;
  return <RunReport run={run} />;
}
