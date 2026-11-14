import type { Kv } from "@/io/kv";

const STOP_KEY = "radar:test-mode:stopped";

/** Set RADAR_TEST_MODE=0 to re-arm normal Radar after the controlled demo. */
export function isRadarTestModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RADAR_TEST_MODE !== "0";
}
const CYCLE_LOCK_KEY = "radar:test-mode:cycle-lock";
const CYCLE_LOCK_TTL_MS = 8 * 60 * 1000;

export type RadarTestModeState = {
  stopped: boolean;
  stoppedAt: string | null;
  alertId: string | null;
  message: string | null;
};

export const RADAR_TEST_DIRECT_SCAN_MESSAGE =
  "Ad-hoc Deal Radar scans are disabled during the one-notification test. Only the single saved watch can run.";

const STOPPED_MESSAGE =
  "Deal Radar was automatically paused after its first test notification. Existing alerts remain available, but no further monitoring checks will run.";

export async function readRadarTestModeState(
  kv: Kv,
  env: Record<string, string | undefined> = process.env,
): Promise<RadarTestModeState> {
  if (!isRadarTestModeEnabled(env)) {
    return { stopped: false, stoppedAt: null, alertId: null, message: null };
  }
  try {
    const raw = await kv.get(STOP_KEY);
    if (!raw) return { stopped: false, stoppedAt: null, alertId: null, message: null };
    try {
      const parsed = JSON.parse(raw) as { stoppedAt?: unknown; alertId?: unknown; message?: unknown };
      return {
        stopped: true,
        stoppedAt: typeof parsed.stoppedAt === "string" ? parsed.stoppedAt : null,
        alertId: typeof parsed.alertId === "string" ? parsed.alertId : null,
        message: typeof parsed.message === "string" ? parsed.message : STOPPED_MESSAGE,
      };
    } catch {
      // A non-empty but unreadable safety flag must never re-enable paid monitoring.
      return {
        stopped: true,
        stoppedAt: null,
        alertId: null,
        message: "Deal Radar is paused because its test-safety state could not be read. No new checks will run.",
      };
    }
  } catch {
    // Storage errors fail closed: do not risk spending against an unknown global state.
    return {
      stopped: true,
      stoppedAt: null,
      alertId: null,
      message: "Deal Radar is temporarily paused because its safety state is unavailable. No new checks will run.",
    };
  }
}

export async function acquireRadarTestCycle(
  kv: Kv,
  runId: string,
  env: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; stopped: boolean; message: string }> {
  const state = await readRadarTestModeState(kv);
  if (state.stopped) {
    return { ok: false, stopped: true, message: state.message ?? STOPPED_MESSAGE };
  }
  if (env.VERCEL && kv.backend !== "upstash") {
    return {
      ok: false,
      stopped: false,
      message: "Deal Radar check skipped: shared persistent storage is unavailable, so spend safety cannot be guaranteed.",
    };
  }
  try {
    const acquired = await kv.setNx(CYCLE_LOCK_KEY, runId, { ttlMs: CYCLE_LOCK_TTL_MS });
    if (!acquired) {
      return {
        ok: false,
        stopped: false,
        message: "Another Deal Radar test cycle is already running. This overlapping check was skipped.",
      };
    }
    // Re-read after acquiring the lock to close the race with a concurrent stop.
    const current = await readRadarTestModeState(kv);
    if (current.stopped) {
      await kv.compareAndSwap(CYCLE_LOCK_KEY, runId, null);
      return { ok: false, stopped: true, message: current.message ?? STOPPED_MESSAGE };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      stopped: false,
      message: "Deal Radar check skipped: its shared safety lock is unavailable. No external lookup was started.",
    };
  }
}

export async function releaseRadarTestCycle(kv: Kv, runId: string): Promise<void> {
  await kv.compareAndSwap(CYCLE_LOCK_KEY, runId, null).catch(() => false);
}

export async function stopRadarAfterFirstTestAlert(
  kv: Kv,
  alertId: string,
  stoppedAt: string,
): Promise<RadarTestModeState> {
  if (!isRadarTestModeEnabled()) return readRadarTestModeState(kv);
  await kv.setNx(
    STOP_KEY,
    JSON.stringify({ stoppedAt, alertId, message: STOPPED_MESSAGE }),
  );
  return readRadarTestModeState(kv);
}

export async function radarTestModeIsBusy(kv: Kv): Promise<boolean> {
  try {
    return (await kv.get(CYCLE_LOCK_KEY)) !== null;
  } catch {
    return true;
  }
}

export const __radarTestModeKeys = { STOP_KEY, CYCLE_LOCK_KEY };
