/** Transport and profiles live in src/server/serv. This file only re-exports them. */
export {
  BASE_MODEL,
  FLIP_SHADOW_HINT,
  PROFILES,
  REPORT_SHADOW_HINT,
  SHADOW_MAX_ITERATIONS,
  interpretGuard,
  modelFor,
  requestFor,
  runServ,
  shadowOutcomeFrom,
  type ServProof,
} from "@/server/serv";
import { REPORT_SHADOW_HINT as reportShadowHint } from "@/server/serv";

export const SHADOW_HINT = reportShadowHint;
export const EXPLAIN_PROMPT_VERSION = "autoflip.explain.v1";
export const GUARD_PROMPT_VERSION = "autoflip.guard.v1";
