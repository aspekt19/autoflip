/**
 * Seeded note generation for the live eval.
 * Same seed → same notes. Default seed is Date.now() or EVAL_LIVE_SEED.
 *
 * Default batch: 8 queries ≈ 5 Find + 3 Resale (randomized templates).
 */
import {
  assembleCleanNote,
  assembleResaleNote,
  BODIES,
  BUDGETS,
  CITIES,
  FLIP_GOALS,
  MESSY,
  NEEDS,
  type BodyTemplate,
  type BudgetTemplate,
  type CityTemplate,
  type FlipGoalTemplate,
  type MessyTemplate,
  type NeedTemplate,
} from "./templates";
import type { GeneratedQuery, LiveEvalProduct } from "./types";

export const DEFAULT_FIND_QUERIES = 5;
export const DEFAULT_RESALE_QUERIES = 3;
export const DEFAULT_EVAL_QUERIES = DEFAULT_FIND_QUERIES + DEFAULT_RESALE_QUERIES;

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

export type GenerateSplit = {
  find: number;
  resale: number;
};

/**
 * Split `count` into ~5 Find + ~3 Resale when count is 8; otherwise proportional.
 * Always at least one Find when count ≥ 1; at least one Resale when count ≥ 2.
 */
export function splitFindResale(count: number): GenerateSplit {
  const n = Math.max(1, Math.min(100, Math.floor(count)));
  if (n === 1) return { find: 1, resale: 0 };
  if (n === DEFAULT_EVAL_QUERIES) {
    return { find: DEFAULT_FIND_QUERIES, resale: DEFAULT_RESALE_QUERIES };
  }
  const resale = Math.max(1, Math.round((n * DEFAULT_RESALE_QUERIES) / DEFAULT_EVAL_QUERIES));
  const find = Math.max(1, n - resale);
  return { find, resale: n - find };
}

function oneFind(rng: () => number, index: number, seen: Set<string>): GeneratedQuery | null {
  const city = pick(rng, CITIES) as CityTemplate;
  const budget = pick(rng, BUDGETS) as BudgetTemplate;
  const body = pick(rng, BODIES) as BodyTemplate;
  const need = pick(rng, NEEDS) as NeedTemplate;
  const messyTpl = pick(rng, MESSY) as MessyTemplate;
  const messy = messyTpl.id !== "clean";
  const clean = assembleCleanNote({ body, budget, need, city });
  let note = messyTpl.wrap(clean);
  if (seen.has(note)) note = `${note} (#${index + 1})`;
  if (seen.has(note)) return null;
  seen.add(note);
  const nationwide = city.id === "nationwide";
  return {
    id: slug([
      String(index + 1).padStart(2, "0"),
      "find",
      city.id,
      body.id,
      budget.id,
      need.id,
      messyTpl.id,
    ]),
    product: "find",
    note,
    zip: nationwide ? null : city.zip,
    distanceMiles: nationwide ? null : city.radiusMi,
    tags: {
      product: "find",
      city: city.id,
      budget: budget.id,
      body: body.id,
      need: need.id,
      messy,
    },
  };
}

function oneResale(rng: () => number, index: number, seen: Set<string>): GeneratedQuery | null {
  const city = pick(rng, CITIES) as CityTemplate;
  const budget = pick(rng, BUDGETS) as BudgetTemplate;
  const body = pick(rng, BODIES) as BodyTemplate;
  const goal = pick(rng, FLIP_GOALS) as FlipGoalTemplate;
  const messyTpl = pick(rng, MESSY) as MessyTemplate;
  const messy = messyTpl.id !== "clean";
  const clean = assembleResaleNote({ body, budget, goal, city });
  let note = messyTpl.wrap(clean);
  if (seen.has(note)) note = `${note} (#${index + 1})`;
  if (seen.has(note)) return null;
  seen.add(note);
  const nationwide = city.id === "nationwide";
  return {
    id: slug([
      String(index + 1).padStart(2, "0"),
      "resale",
      city.id,
      body.id,
      budget.id,
      goal.id,
      messyTpl.id,
    ]),
    product: "resale",
    note,
    zip: nationwide ? null : city.zip,
    distanceMiles: nationwide ? null : city.radiusMi,
    tags: {
      product: "resale",
      city: city.id,
      budget: budget.id,
      body: body.id,
      need: goal.id,
      messy,
    },
  };
}

/**
 * Build `count` varied notes (default split 5 Find + 3 Resale).
 * Guarantees uniqueness by retrying combinations.
 */
export function generateQueries(
  seed: number,
  count: number = DEFAULT_EVAL_QUERIES,
  split?: GenerateSplit,
): GeneratedQuery[] {
  const n = Math.max(1, Math.min(100, Math.floor(count)));
  const parts = split ?? splitFindResale(n);
  const findTarget = Math.min(n, Math.max(0, parts.find));
  const resaleTarget = Math.min(n - findTarget, Math.max(0, parts.resale));
  const rng = createRng(seed);
  const out: GeneratedQuery[] = [];
  const seen = new Set<string>();

  let attempts = 0;
  const maxAttempts = n * 50;
  while (out.filter((q) => q.product === "find").length < findTarget && attempts < maxAttempts) {
    attempts += 1;
    const q = oneFind(rng, out.length, seen);
    if (q) out.push(q);
  }
  while (out.filter((q) => q.product === "resale").length < resaleTarget && attempts < maxAttempts) {
    attempts += 1;
    const q = oneResale(rng, out.length, seen);
    if (q) out.push(q);
  }
  // Fill remainder as Find if uniqueness exhausted on Resale.
  while (out.length < n && attempts < maxAttempts) {
    attempts += 1;
    const q = oneFind(rng, out.length, seen);
    if (q) out.push(q);
  }

  return out.slice(0, n);
}

export function countByProduct(queries: readonly GeneratedQuery[]): Record<LiveEvalProduct, number> {
  return {
    find: queries.filter((q) => q.product === "find").length,
    resale: queries.filter((q) => q.product === "resale").length,
  };
}
