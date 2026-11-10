/**
 * Fetch + parse + optional SERV LLM extract for a listing URL or pasted text.
 */
import { parseListingHtml, parseListingText } from "@/domain/listing/parse-html";
import type { ExtractedListingFields, ListingFetchOutcome, ListingPageParse } from "@/domain/listing/types";
import { groundLlmFieldsInPage, mergeLlmExtraction } from "@/domain/listing/validate";
import { screenUserInput } from "@/domain/screen";
import { fetchListingPage, type ListingFetchDeps } from "@/io/listing-fetch";
import { interpretGuard, runServ } from "@/server/serv";

export type ListingExtractDeps = ListingFetchDeps & {
  servKey?: string;
  servModel?: string;
  servBaseUrl?: string;
};

export type ListingExtractResult =
  | {
      ok: true;
      blocked: false;
      fetch: ListingFetchOutcome & { ok: true };
      parse: ListingPageParse;
      fields: ExtractedListingFields;
      llmUsed: boolean;
    }
  | {
      ok: true;
      blocked: false;
      fetch: null;
      parse: ListingPageParse;
      fields: ExtractedListingFields;
      llmUsed: boolean;
      fromPaste: true;
    }
  | {
      ok: false;
      blocked: true;
      fetch: ListingFetchOutcome & { ok: false };
      message: string;
      alternatives: Array<"paste_text" | "enter_vin">;
    }
  | {
      ok: false;
      blocked: false;
      error: string;
      message: string;
    };

async function runLlmFill(
  parse: ListingPageParse,
  deps: ListingExtractDeps,
): Promise<{ fields: ExtractedListingFields; llmUsed: boolean }> {
  let fields = parse.deterministic;
  // A car already identified from the page does not spend extract calls.
  // Check's verdict budget is verdict_decide + verdict_challenge (2).
  if (fields.year.value && fields.make.value && fields.model.value) {
    return { fields, llmUsed: false };
  }
  if (!deps.servKey || !parse.llmText.trim()) return { fields, llmUsed: false };

  const guarded = await runServ(
    "check_guard",
    { user: parse.llmText.slice(0, 500) },
    {
      fetch: deps.fetch,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model: deps.servModel,
    },
  );
  if (!guarded.ok || interpretGuard(guarded.text) === "block") {
    return { fields, llmUsed: false };
  }

  const extracted = await runServ(
    "listing_extract",
    { user: parse.llmText },
    {
      fetch: deps.fetch,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model: deps.servModel,
    },
  );
  if (!extracted.ok) return { fields, llmUsed: false };
  try {
    const json = JSON.parse(extracted.text) as Record<string, unknown>;
    const merged = mergeLlmExtraction(fields, json);
    // Never keep LLM values that were not present on the page/URL text.
    const grounded = groundLlmFieldsInPage(merged, `${parse.llmText}\n${parse.url ?? ""}`);
    return { fields: grounded, llmUsed: true };
  } catch {
    return { fields, llmUsed: false };
  }
}

export async function extractFromListingUrl(
  url: string,
  deps: ListingExtractDeps = {},
): Promise<ListingExtractResult> {
  const screened = screenUserInput(url);
  if (!screened.ok) {
    return { ok: false, blocked: false, error: "rejected_input", message: screened.reason };
  }
  const fetched = await fetchListingPage(screened.text, deps);
  if (!fetched.ok) {
    return {
      ok: false,
      blocked: true,
      fetch: fetched,
      message: `${fetched.reason} Keep this URL, then paste the listing text or enter the VIN.`,
      alternatives: ["paste_text", "enter_vin"],
    };
  }
  const parse = parseListingHtml(fetched.html, fetched.finalUrl || fetched.url);
  const filled = await runLlmFill(parse, deps);
  return {
    ok: true,
    blocked: false,
    fetch: fetched,
    parse,
    fields: filled.fields,
    llmUsed: filled.llmUsed,
  };
}

export async function extractFromPastedText(
  text: string,
  deps: ListingExtractDeps = {},
  url?: string | null,
): Promise<ListingExtractResult> {
  const screened = screenUserInput(text.slice(0, 2000));
  if (!screened.ok) {
    return { ok: false, blocked: false, error: "rejected_input", message: screened.reason };
  }
  // Full paste can be long; screen only the head for injection, parse the body.
  // If the paste looks like saved HTML (dealer “view source”), use the HTML parser.
  const looksHtml = /<html[\s>]|<script\b|application\/ld\+json|<meta\b/i.test(text);
  const parse = looksHtml ? parseListingHtml(text, url ?? null) : parseListingText(text, url ?? null);
  const filled = await runLlmFill(parse, deps);
  return {
    ok: true,
    blocked: false,
    fetch: null,
    parse,
    fields: filled.fields,
    llmUsed: filled.llmUsed,
    fromPaste: true,
  };
}
