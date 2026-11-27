/**
 * Read the Find decide graph's reply and map it onto the find_decide / find_challenge
 * payload shapes, so the same validators (validateFindDecide / validateFindChallenge) judge it.
 *
 * The graph prompt (docs/graphs/find-decide-graph-prompt.md) asks for a compact answer:
 *
 *   Pick: <shortlist key>
 *   Action: buy | negotiate | inspect_first | pass
 *   Confidence: high | medium | low
 *   Review: kept | revised [— note]
 *   <one or two sentences: why this car, the main risk, evidence ids>
 *
 * The console designs the graph's own output schema, so the reply may also arrive as JSON with
 * generator-chosen field names. Both forms are read here. The legacy `{ decide, challenge }`
 * object is still accepted as is. Nothing is inferred: without a pick, an action and a
 * confidence the reply is unreadable (null) and the caller treats the graph run as failed.
 */
import { tryExtractServJson } from "@/domain/serv-json";

export type FindDecideGraphPayload = { decide: unknown; challenge: unknown };

type Compact = {
  pick: string;
  action: string;
  confidence: string;
  review: "kept" | "revised" | null;
  reviewNote: string | null;
  reason: string | null;
  risk: string | null;
  evidenceIds: string[];
};

const EVIDENCE_ID = /\b[a-z][a-z_]*:[A-Za-z0-9][A-Za-z0-9_.:\-]*/g;

function clean(value: string): string {
  return value
    .replace(/[`*_"]+/g, (m) => (m.includes("_") && m.length === 1 ? m : ""))
    .replace(/\s+/g, " ")
    .trim();
}

function firstWordToken(value: string): string {
  const v = clean(value).replace(/^[<[(]+|[>\]).,;]+$/g, "");
  return v.split(/\s+/)[0] ?? "";
}

function normalizeAction(value: string): string {
  return clean(value).toLowerCase().replace(/[\s-]+/g, "_").split(/[^a-z_]/)[0] ?? "";
}

function evidenceFrom(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EVIDENCE_ID)) {
    const id = m[0].replace(/[.:]+$/, "");
    if (/^https?:/.test(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Drop a trailing "Evidence: id, id" from shopper-facing text; the ids are read separately. */
function stripEvidenceTail(text: string): string {
  return text.replace(/\s*\(?\s*evidence(?:\s*ids?)?\s*[:=][^]*$/i, "").trim();
}

function fromLines(text: string): Compact | null {
  const line = (label: RegExp): string | null => {
    const re = new RegExp(`^[\\s>*#_\\-]*(?:${label.source})[\\s*_]*[:=\\-–—]\\s*(.+)$`, "im");
    const m = text.match(re);
    return m ? m[1]!.trim() : null;
  };
  const pick = line(/pick(?:\s*key)?|chosen car|car/);
  const action = line(/action|verdict/);
  const confidence = line(/confidence/);
  if (!pick || !action || !confidence) return null;
  const reviewRaw = line(/review|self[-\s]?review|challenge/);
  const review = reviewRaw ? (/revis/i.test(reviewRaw) ? "revised" : /kept|keep|agree/i.test(reviewRaw) ? "kept" : null) : null;
  const reviewNote = reviewRaw ? clean(reviewRaw.replace(/^\W*(kept|keep|revised|revise)\W*/i, "")) || null : null;
  const labelled = /^[\s>*#_\-]*(pick(\s*key)?|chosen car|car|action|verdict|confidence|review|self[-\s]?review|challenge|evidence(\s*ids?)?)[\s*_]*[:=\-–—]/i;
  const evidenceLines = text
    .split(/\r?\n/)
    .filter((row) => /^[\s>*#_\-]*evidence(\s*ids?)?[\s*_]*[:=]/i.test(row))
    .join(" ");
  const rest = stripEvidenceTail(
    text
      .split(/\r?\n/)
      .filter((row) => row.trim() && !labelled.test(row))
      .join(" "),
  );
  const risk = line(/risk|main risk|watch[-\s]?out|check/);
  const reasonLine = line(/reason|why/);
  const reason = (reasonLine ? stripEvidenceTail(reasonLine) : clean(rest)) || null;
  return {
    pick: firstWordToken(pick),
    action: normalizeAction(action),
    confidence: firstWordToken(confidence).toLowerCase(),
    review,
    reviewNote,
    reason,
    risk,
    evidenceIds: evidenceFrom(text.split(/\r?\n/).filter((row) => !labelled.test(row) || /evidence/i.test(row)).join(" ") + " " + evidenceLines + " " + (risk ?? "") + " " + (reviewNote ?? "")),
  };
}

function flatten(value: unknown, path: string[] = [], out: Array<[string, unknown]> = []) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, [...path, k], out);
  } else {
    out.push([path.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "")).join("."), value]);
  }
  return out;
}

function fromJson(payload: Record<string, unknown>): Compact | null {
  const flat = flatten(payload);
  const strings = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : typeof v === "boolean" ? String(v) : null;
  const find = (names: string[]): string | null => {
    // Final / revised answers win over first drafts when both are present.
    for (const prefer of [/final|revised|after/, /.*/]) {
      for (const [key, v] of flat) {
        const leaf = key.split(".").at(-1) ?? "";
        if (!names.includes(leaf) || !prefer.test(key)) continue;
        const s = strings(v);
        if (s) return s;
      }
    }
    return null;
  };
  const pick = find(["pick", "pickkey", "pickedkey", "chosenkey", "carkey", "selectedkey", "finalpick", "finalpickkey", "key"]);
  const action = find(["action", "finalaction", "verdict", "recommendation"]);
  const confidence = find(["confidence", "finalconfidence"]);
  if (!pick || !action || !confidence) return null;
  const reviewRaw = find(["review", "reviewresult", "selfreview", "challengeresult", "kept", "revised", "agree"]);
  const review = reviewRaw
    ? /revis|false/i.test(reviewRaw) ? "revised" : /kept|keep|agree|true/i.test(reviewRaw) ? "kept" : null
    : null;
  const reason = find(["reason", "why", "rationale", "summary", "explanation", "confidencewhy"]);
  const risk = find(["risk", "mainrisk", "watchout", "unknown", "tocheck"]);
  const reviewNote = find(["reviewnote", "challengenote", "objection", "issue"]);
  const evidenceIds: string[] = [];
  for (const [key, v] of flat) {
    if (!/evidence/.test(key)) continue;
    for (const id of Array.isArray(v) ? v : [v]) if (typeof id === "string" && id.trim() && !evidenceIds.includes(id.trim())) evidenceIds.push(id.trim());
  }
  for (const [key, v] of Object.entries(payload)) {
    if (/evidence/i.test(key) && Array.isArray(v)) {
      for (const id of v) if (typeof id === "string" && id.trim() && !evidenceIds.includes(id.trim())) evidenceIds.push(id.trim());
    }
  }
  for (const id of evidenceFrom(`${reason ?? ""} ${risk ?? ""} ${reviewNote ?? ""}`)) if (!evidenceIds.includes(id)) evidenceIds.push(id);
  return {
    pick: firstWordToken(pick),
    action: normalizeAction(action),
    confidence: firstWordToken(confidence).toLowerCase(),
    review,
    reviewNote,
    reason: reason ? stripEvidenceTail(reason) || null : null,
    risk,
    evidenceIds,
  };
}

function toPayload(c: Compact): FindDecideGraphPayload {
  const evidenceIds = c.evidenceIds.length > 0 ? c.evidenceIds : [`car:${c.pick}`];
  const reason = c.reason ? c.reason.slice(0, 400) : null;
  const decide = {
    pickKey: c.pick,
    action: c.action,
    confidence: c.confidence,
    confidenceWhy: reason ? reason.slice(0, 280) : "",
    reasons: reason ? [{ text: reason, evidenceIds }] : [],
    watchOuts: c.risk ? [{ text: c.risk.slice(0, 400), evidenceIds }] : [],
    askSeller: [],
    alternatives: [],
    offerUsd: null,
  };
  const revised = c.review === "revised";
  const challenge = {
    agree: !revised,
    issues: revised
      ? [
          {
            kind: "wrong_pick",
            text: c.reviewNote || "The graph's own review revised its first choice.",
            evidenceIds: [`car:${c.pick}`, ...evidenceIds],
          },
        ]
      : [],
    // The reply is already the post-review answer; nothing left for code to revise.
    revised: { pickKey: null, action: null, confidence: null },
  };
  return { decide, challenge };
}

export function parseFindDecideGraphOutput(text: string | null | undefined): FindDecideGraphPayload | null {
  if (!text || !text.trim()) return null;
  const payload = tryExtractServJson(text);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>;
    if (row.decide && typeof row.decide === "object" && row.challenge && typeof row.challenge === "object") {
      return { decide: row.decide, challenge: row.challenge };
    }
    const compact = fromJson(row);
    if (compact) return toPayload(compact);
  }
  const compact = fromLines(text);
  return compact ? toPayload(compact) : null;
}
