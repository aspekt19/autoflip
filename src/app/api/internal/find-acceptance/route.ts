/**
 * Preview-only Find acceptance + Auto.dev probe.
 * Gated by FIND_ACCEPTANCE_TOKEN. Never enabled in production target.
 * Does not charge credits — exercises understandNeed + runFindMatch with live keys.
 */
import { listingsSearchUrl } from "@/io/autodev";
import { getKv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { runFindMatch } from "@/server/find-match";
import { understandNeed } from "@/server/understand-need";
import { secretMatch } from "@/server/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NOTES = [
  {
    id: "yura_suv",
    text: "Looking for a used SUV around $20k. Preferably AWD, under 70k miles, 2020 or newer. Mostly for commuting, but I need something reliable for road trips too. What are the best deals near me?",
    zip: "75201",
  },
  {
    id: "first_car",
    text: "Looking for a cheap first car around $8000. Something reliable and not too old.",
    zip: "75201",
  },
  {
    id: "pickup_tow",
    text: "Need a pickup truck around $30k that can tow. Prefer something 2018 or newer.",
    zip: "75201",
  },
] as const;

function bearerToken(request: Request): string {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? "";
}

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV === "production") {
    return Response.json({ error: "forbidden", message: "Not available in production." }, { status: 403 });
  }
  const expected = process.env.FIND_ACCEPTANCE_TOKEN?.trim() ?? "";
  if (!expected || !secretMatch(bearerToken(request), expected)) {
    return Response.json({ error: "unauthorized", message: "Bearer FIND_ACCEPTANCE_TOKEN required." }, { status: 401 });
  }

  const deps = runtimeDeps();
  const kv = getKv();

  // ONE Auto.dev probe: multi-model comma + drivetrain query param.
  let autoDevProbe: {
    multiModelComma: "ok" | "empty" | "upstream" | "no_key";
    multiModelCount: number;
    drivetrainFilterParam: "accepted" | "rejected" | "ignored" | "no_key";
    drivetrainNote: string;
  } = {
    multiModelComma: "no_key",
    multiModelCount: 0,
    drivetrainFilterParam: "no_key",
    drivetrainNote: "AUTODEV_API_KEY missing on this deploy.",
  };

  if (deps.autodevKey && deps.autodev) {
    const adDeps = {
      fetch,
      cache: deps.autodev.cache,
      counter: deps.autodev.counter,
      apiKey: deps.autodevKey,
      reserve: deps.autodev.reserve,
      bypassCache: true,
      timeoutMs: 15_000,
    };
    const multiUrl = listingsSearchUrl({
      make: "Toyota",
      model: "Camry,RAV4",
      used: true,
      limit: 5,
      priceRange: "1-25000",
    });
    const multi = await (await import("@/io/autodev")).autodevSearch(
      { make: "Toyota", model: "Camry,RAV4", used: true, limit: 5, priceRange: "1-25000" },
      adDeps,
    );
    if (multi.ok) {
      autoDevProbe.multiModelComma = multi.listings.length > 0 ? "ok" : "empty";
      autoDevProbe.multiModelCount = multi.listings.length;
    } else {
      autoDevProbe.multiModelComma = "upstream";
    }

    // Probe whether vehicle.drivetrain is a valid query filter (not only response field).
    const dtParams = new URLSearchParams();
    dtParams.set("vehicle.make", "Toyota");
    dtParams.set("vehicle.model", "RAV4");
    dtParams.set("vehicle.drivetrain", "AWD");
    dtParams.set("retailListing.used", "true");
    dtParams.set("limit", "3");
    const dtUrl = `https://api.auto.dev/listings?${dtParams.toString()}`;
    try {
      const dtRes = await fetch(dtUrl, {
        headers: { Authorization: `Bearer ${deps.autodevKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (dtRes.ok) {
        const json = (await dtRes.json()) as { data?: unknown[]; listings?: unknown[] };
        const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.listings) ? json.listings : [];
        autoDevProbe.drivetrainFilterParam = "accepted";
        autoDevProbe.drivetrainNote = `HTTP ${dtRes.status}; ${rows.length} rows. Prefer client-side decode if rows ignore AWD. Probe URL shape: vehicle.drivetrain.`;
      } else if (dtRes.status === 400 || dtRes.status === 422) {
        autoDevProbe.drivetrainFilterParam = "rejected";
        autoDevProbe.drivetrainNote = `HTTP ${dtRes.status} — drivetrain is not a query filter; filter client-side.`;
      } else {
        autoDevProbe.drivetrainFilterParam = "ignored";
        autoDevProbe.drivetrainNote = `HTTP ${dtRes.status} on drivetrain probe.`;
      }
    } catch (err) {
      autoDevProbe.drivetrainFilterParam = "ignored";
      autoDevProbe.drivetrainNote = err instanceof Error ? err.message : "drivetrain probe failed";
    }
    void multiUrl;
  }

  const body = (await request.json().catch(() => null)) as { id?: string } | null;
  const onlyId = typeof body?.id === "string" ? body.id.trim() : "";
  const notes = onlyId ? NOTES.filter((n) => n.id === onlyId) : NOTES;
  if (onlyId && notes.length === 0) {
    return Response.json({ error: "unknown_id", message: `Unknown note id ${onlyId}` }, { status: 400 });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const note of notes) {
    const understood = await understandNeed(
      { text: note.text, mode: "personal", zip: note.zip, distanceMiles: 100 },
      {
        servKey: deps.servKey,
        servModel: deps.servModel,
        servBaseUrl: deps.servBaseUrl,
      },
    );
    if (!understood.ok) {
      results.push({
        id: note.id,
        ok: false,
        error: understood.error,
        message: understood.message,
        cars: 0,
      });
      continue;
    }
    const match = await runFindMatch(
      { need: understood.need, directions: understood.directions },
      {
        ...deps,
        kv,
        parallelProviderQueries: true,
      },
    );
    const groups = match.ok && match.body.ok ? match.body.directions : [];
    const cars = groups.reduce((n, g) => n + (g.listings?.length ?? 0), 0);
    const top = groups
      .flatMap((g) => g.listings ?? [])
      .slice(0, 3)
      .map((l) => ({
        year: l.year,
        make: l.make,
        model: l.model,
        priceUsd: l.priceUsd,
        miles: l.miles,
        drivetrain: l.drivetrain,
      }));
    results.push({
      id: note.id,
      ok: match.ok && cars >= 1,
      cars,
      planSummary: understood.findPlan.summary,
      question: understood.findPlan.question,
      directions: understood.directions.map((d) => ({
        segment: d.segment,
        models: d.models,
        bodyStyle: d.bodyStyle ?? null,
      })),
      providerQueriesUsed: match.ok && match.body.ok ? match.body.providerQueriesUsed : 0,
      top,
      message: match.ok ? match.body.message : match.body.message,
    });
  }

  return Response.json({
    ok: results.every((r) => r.ok === true),
    vercelEnv: process.env.VERCEL_ENV ?? null,
    autoDevProbe,
    results,
  });
}
