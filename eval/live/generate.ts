/**
 * Seeded note generation for the live eval.
 * Same seed → same notes. Default seed is Date.now() or EVAL_LIVE_SEED.
 */
import {
  assembleCleanNote,
  BODIES,
  BUDGETS,
  CITIES,
  MESSY,
  NEEDS,
  type BodyTemplate,
  type BudgetTemplate,
  type CityTemplate,
  type MessyTemplate,
  type NeedTemplate,
} from "./templates";
import type { GeneratedQuery } from "./types";

/** Mulberry32 — fast, deterministic, good enough for template picks. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function slug(parts: string[]): string {
  return parts
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 48);
}

export function resolveSeed(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): number {
  const raw = env.EVAL_LIVE_SEED?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return nowMs;
}

/**
 * Build `count` varied notes from template pools.
 * Guarantees uniqueness by retrying combinations; falls back to a suffix if needed.
 */
export function generateQueries(seed: number, count: number): GeneratedQuery[] {
  const n = Math.max(1, Math.min(100, Math.floor(count)));
  const rng = createRng(seed);
  const out: GeneratedQuery[] = [];
  const seen = new Set<string>();

  let attempts = 0;
  const maxAttempts = n * 40;
  while (out.length < n && attempts < maxAttempts) {
    attempts += 1;
    const city = pick(rng, CITIES) as CityTemplate;
    const budget = pick(rng, BUDGETS) as BudgetTemplate;
    const body = pick(rng, BODIES) as BodyTemplate;
    const need = pick(rng, NEEDS) as NeedTemplate;
    const messyTpl = pick(rng, MESSY) as MessyTemplate;
    const messy = messyTpl.id !== "clean";
    const clean = assembleCleanNote({ body, budget, need, city });
    let note = messyTpl.wrap(clean);
    if (seen.has(note)) {
      note = `${note} (#${out.length + 1})`;
    }
    if (seen.has(note)) continue;
    seen.add(note);

    const nationwide = city.id === "nationwide";
    const id = slug([
      String(out.length + 1).padStart(2, "0"),
      city.id,
      body.id,
      budget.id,
      need.id,
      messyTpl.id,
    ]);

    out.push({
      id,
      note,
      zip: nationwide ? null : city.zip,
      distanceMiles: nationwide ? null : city.radiusMi,
      tags: {
        city: city.id,
        budget: budget.id,
        body: body.id,
        need: need.id,
        messy,
      },
    });
  }

  return out;
}
