/** Plain-English account of a decision. Built only from recorded check flags. */

export type DecisionScene = "find" | "check" | "report" | "personal_alert" | "flip";

export type DecisionProof = {
  purpose: string;
  tools: string[];
  features: string[];
  promptGuard: string;
  shadowOutcome: string;
  shadowMaxIterations: number | null;
  latencyMs: number;
  jsonSchema?: string | null;
  applicationTool?: string | null;
  fallbackUsed?: boolean;
  codeComputed?: string[];
};

const ASKED: Record<DecisionScene, string> = {
  find: "We asked for a reading of the car you described: what it is for, what you must have, and what you left blank.",
  check: "We asked whether this listing or VIN fits the way you plan to use the car.",
  report: "We asked for a plain-language reading of one car after the figures were already calculated.",
  personal_alert: "We asked whether a saved-search match was worth showing you.",
  flip: "We asked which cars in this scan were clear enough to show, after profit, similar listings, and speed of sale were already calculated.",
};

const CALCULATED: Record<DecisionScene, string> = {
  find: "Your budget and ZIP stay what you typed. The search directions come from a fixed guidance table, not from a market study.",
  check: "Asking price, mileage, recalls, complaints, and the price comparison are copied from the listing and public records, or calculated from those records.",
  report: "The price comparison, mileage adjustment, recalls, and complaint count are copied from the listing and public records, or calculated from those records.",
  personal_alert: "Whether the car matches your saved search, and any price drop, is calculated from the listing and the last price we stored.",
  flip: "The profit range, the count of similar listings, and how fast they appear to sell are calculated from this scan. Fewer than three similar listings is left out.",
};

export function visibleProof(proof: DecisionProof): DecisionProof {
  return {
    purpose: proof.purpose,
    tools: proof.tools,
    features: proof.features,
    promptGuard: proof.promptGuard,
    shadowOutcome: proof.shadowOutcome,
    shadowMaxIterations: proof.shadowMaxIterations,
    latencyMs: proof.latencyMs,
    jsonSchema: proof.jsonSchema ?? null,
    applicationTool: proof.applicationTool ?? null,
    fallbackUsed: proof.fallbackUsed,
    codeComputed: proof.codeComputed,
  };
}

const NUMBER_TOKEN = /[-+]?\$?\d[\d,]*(?:\.\d+)?/g;
const VIN_TOKEN = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
const MODEL_CODE = /\b[A-Z]{1,4}-\d+\b/gi;
const NON_NUMERIC_STRING_KEYS = new Set(["vin", "make", "model", "trim", "engine", "fuel", "bodyStyle", "style"]);

function normalizedNumbers(text: string): string[] {
  const cleaned = text.replace(VIN_TOKEN, " ").replace(MODEL_CODE, " ");
  return (cleaned.match(NUMBER_TOKEN) ?? []).map((token) => token.replace(/[,$]/g, ""));
}

function numericTokens(value: unknown): Set<string> {
  const tokens = new Set<string>();
  const add = (text: string) => {
    for (const token of normalizedNumbers(text)) {
      tokens.add(token);
      const numeric = Number(token);
      if (Number.isFinite(numeric)) tokens.add(String(numeric));
    }
  };
  const visit = (item: unknown, key?: string): void => {
    if (typeof item === "number" && Number.isFinite(item)) {
      add(String(item));
    } else if (typeof item === "string") {
      if (!key || !NON_NUMERIC_STRING_KEYS.has(key)) add(item);
    } else if (Array.isArray(item)) {
      item.forEach((child) => visit(child));
    } else if (item && typeof item === "object") {
      for (const [childKey, child] of Object.entries(item as Record<string, unknown>)) {
        visit(child, childKey);
      }
    }
  };
  visit(value);
  return tokens;
}

export function quotedNumbersStayIn(text: string, allowed: string): boolean {
  let facts: unknown = allowed;
  try {
    facts = JSON.parse(allowed) as unknown;
  } catch {
    // Preserve compatibility with callers that pass a plain text evidence string.
  }
  const available = numericTokens(facts);
  return normalizedNumbers(text).every((token) => available.has(token) || available.has(String(Number(token))));
}

export function whyWeDecided(scene: DecisionScene, proofs: DecisionProof[]): string[] {
  const guard = proofs.find((item) => item.tools.includes("serv_prompt_guard") || item.purpose.endsWith("_guard"));
  const secondPass = proofs.some((item) => item.tools.includes("serv_shadow_agent") || item.shadowOutcome !== "not_used");
  const paths = proofs.some((item) => item.features.includes("multipath"));
  const rules = proofs.some((item) => item.features.includes("kronos"));
  const fixedForm = proofs.some((item) => Boolean(item.jsonSchema));
  const readFigures = proofs.some((item) => Boolean(item.applicationTool));
  const fallback = proofs.some((item) => item.fallbackUsed) || proofs.some((item) => item.promptGuard === "unavailable" || item.promptGuard === "not_configured");
  const blocked = proofs.some((item) => item.promptGuard === "block");

  const paragraphs = [ASKED[scene]];
  if (guard) {
    const outcome =
      guard.promptGuard === "allow" || guard.promptGuard === "passed"
        ? "It read as a car question, so the check continued."
        : guard.promptGuard === "block"
          ? "It did not read as a car question, so the check stopped."
          : guard.promptGuard === "not_configured"
            ? "That safety check is not turned on for this preview, so only the calculated result is shown."
            : "The safety check did not finish. The calculated result is unchanged.";
    paragraphs.push(`A safety check read what you submitted before any writing. ${outcome}`);
  } else if (proofs.length === 0) {
    paragraphs.push("A safety check on your note was not recorded for this result.");
  }
  if (secondPass) paragraphs.push("A second pass reviewed the wording against the figures it was given.");
  if (paths) paragraphs.push("The choice compared more than one way of reading the same facts.");
  if (rules) paragraphs.push("The wording had to follow a fixed set of rules for this kind of check.");
  if (fixedForm) paragraphs.push("The answer had to fit a fixed form before we accepted it.");
  if (readFigures) paragraphs.push("The writer had to read the figures the site had already calculated.");
  paragraphs.push(CALCULATED[scene]);
  paragraphs.push("The assistant only explains those figures. It does not recalculate a price, a mileage, or a profit estimate.");
  if (blocked) {
    paragraphs.push("Nothing was written after the safety check stopped the request.");
  } else if (fallback || proofs.length === 0) {
    paragraphs.push("Where a written check was missing or unusable, you still see the calculated result. Nothing was invented to fill the gap.");
  } else if (scene === "flip") {
    paragraphs.push("A car stays on the short list only when the calculated estimate is clear enough to show. A thin estimate is left off.");
  } else if (scene === "find") {
    paragraphs.push("You can edit the reading before the search runs. A blank budget stays blank.");
  } else {
    paragraphs.push("The verdict follows the calculated price gap. The writing does not replace it.");
  }
  paragraphs.push("Limits: public records can be incomplete, asking prices are not sale prices, and a recall on a model year is not proof that this car was repaired.");
  return paragraphs;
}
