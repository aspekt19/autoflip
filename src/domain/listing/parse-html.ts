/**
 * Deterministic listing-page HTML parse.
 * Layers: JSON-LD/schema.org Vehicle|Offer → OpenGraph/meta → microdata → visible text.
 * No network. Treats page text as untrusted data for later LLM use.
 */
import { extractVin } from "@/domain/vin";
import { redactUntrustedPromptText } from "@/domain/screen";
import {
  emptyExtractedFields,
  type ExtractedListingFields,
  type ListingFieldSource,
  type ListingPageParse,
  type ListingParseLayer,
} from "./types";
import { mergeLayer, validateVinCandidate } from "./validate";

const SCRIPT_STYLE_RE = /<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(SCRIPT_STYLE_RE, " ").replace(TAG_RE, " ").replace(WS_RE, " ").trim());
}

function metaContent(html: string, key: string): string | null {
  const prop = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]).trim();
  }
  return null;
}

function pageTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? stripTags(match[1]).slice(0, 200) : null;
}

function collectJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return blocks;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function typeNames(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  return asArray(raw)
    .map((item) => String(item).toLowerCase())
    .filter(Boolean);
}

function walkJsonLd(node: unknown, out: Record<string, unknown>[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, out);
    return;
  }
  if (typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record["@graph"]) walkJsonLd(record["@graph"], out);
  const types = typeNames(record);
  if (
    types.some((t) =>
      /vehicle|car|offer|product|autodealer|autodealership|vehicellisting/.test(t),
    )
  ) {
    out.push(record);
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") walkJsonLd(value, out);
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.name === "string" && record.name.trim()) return record.name.trim();
      if (typeof record["@value"] === "string" && record["@value"].trim()) return record["@value"].trim();
    }
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number(value.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n)) return n;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.value === "number") return record.value;
      if (typeof record["@value"] === "number") return record["@value"];
    }
  }
  return null;
}

function jsonLdToPartial(nodes: Record<string, unknown>[]): Record<string, unknown> {
  const partial: Record<string, unknown> = {};
  for (const node of nodes) {
    const types = typeNames(node);
    const isOffer = types.some((t) => t.includes("offer"));
    const isVehicle = types.some((t) => /vehicle|car/.test(t));
    const isProduct = types.some((t) => t.includes("product"));

    if (isVehicle || isProduct) {
      partial.year ??= firstNumber(node.vehicleModelDate, node.modelDate, node.productionDate, node.year);
      partial.make ??= firstString(node.manufacturer, node.brand, node.make);
      if (partial.make && typeof partial.make === "object") {
        partial.make = firstString((partial.make as { name?: unknown }).name);
      }
      partial.model ??= firstString(node.model, node.name);
      partial.trim ??= firstString(node.vehicleConfiguration, node.trim);
      partial.vin ??= firstString(node.vehicleIdentificationNumber, node.vin, node.serialNumber);
      partial.miles ??= firstNumber(node.mileageFromOdometer, node.mileage);
      partial.color ??= firstString(node.color, node.bodyColor);
      partial.fuel ??= firstString(node.fuelType);
      partial.transmission ??= firstString(node.vehicleTransmission, node.transmission);
      partial.drivetrain ??= firstString(node.driveWheelConfiguration, node.drivetrain);
      partial.description ??= firstString(node.description);
      if (Array.isArray(node.image)) partial.photoCount ??= node.image.length;
      else if (node.image) partial.photoCount ??= 1;
      const offers = asArray(node.offers);
      for (const offer of offers) {
        if (!offer || typeof offer !== "object") continue;
        const o = offer as Record<string, unknown>;
        partial.priceUsd ??= firstNumber(o.price, o.lowPrice);
        const seller = o.seller ?? o.offeredBy;
        partial.sellerName ??= firstString(seller);
      }
    }
    if (isOffer) {
      partial.priceUsd ??= firstNumber(node.price, node.lowPrice);
      partial.sellerName ??= firstString(node.seller, node.offeredBy);
      const item = node.itemOffered;
      if (item && typeof item === "object") {
        walkJsonLd(item, nodes);
      }
    }
  }
  return partial;
}

function openGraphPartial(html: string): Record<string, unknown> {
  const title = metaContent(html, "og:title") ?? metaContent(html, "twitter:title");
  const description = metaContent(html, "og:description") ?? metaContent(html, "description");
  const price =
    metaContent(html, "product:price:amount") ??
    metaContent(html, "og:price:amount") ??
    metaContent(html, "twitter:data1");
  const partial: Record<string, unknown> = {};
  if (description) partial.description = description;
  if (price) partial.priceUsd = price;
  if (title) {
    const yearMatch = title.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) partial.year = yearMatch[0];
    // "2021 Toyota Camry LE" style
    const named = title.match(/\b(?:19|20)\d{2}\s+([A-Za-z][A-Za-z0-9\-]+)\s+([A-Za-z0-9][A-Za-z0-9\- ]{1,40})/);
    if (named) {
      partial.make = named[1];
      const rest = named[2]!.trim().split(/\s+/);
      partial.model = rest[0];
      if (rest.length > 1) partial.trim = rest.slice(1).join(" ");
    }
  }
  return partial;
}

function microdataPartial(html: string): Record<string, unknown> {
  const partial: Record<string, unknown> = {};
  const itempropRe = /itemprop=["']([^"']+)["'][^>]*(?:content=["']([^"']*)["'])?/gi;
  let match: RegExpExecArray | null;
  const bag: Record<string, string> = {};
  while ((match = itempropRe.exec(html))) {
    const key = match[1]!.toLowerCase();
    const content = match[2] ? decodeEntities(match[2]).trim() : "";
    if (content) bag[key] = content;
  }
  partial.priceUsd ??= bag.price ?? bag.lowprice;
  partial.vin ??= bag.vehicleidentificationnumber ?? bag.vin;
  partial.miles ??= bag.mileagefromodometer ?? bag.mileage;
  partial.year ??= bag.vehiclemodeledate ?? bag.modeldate ?? bag.year;
  partial.make ??= bag.manufacturer ?? bag.brand ?? bag.make;
  partial.model ??= bag.model;
  partial.trim ??= bag.vehicleconfiguration ?? bag.trim;
  partial.color ??= bag.color;
  partial.fuel ??= bag.fueltype;
  partial.transmission ??= bag.vehicletransmission;
  partial.drivetrain ??= bag.drivewheelconfiguration;
  partial.description ??= bag.description;
  partial.sellerName ??= bag.seller ?? bag.name;
  return partial;
}

function milesFromVisible(text: string): string | null {
  const thousands = text.match(/(?:mileage|odometer|miles)\s*[:\-]?\s*([0-9]{1,3}(?:\.[0-9])?)\s*k\b/i);
  if (thousands) return String(Math.round(Number(thousands[1]) * 1000));
  const labeled = text.match(/(?:mileage|odometer)\s*[:\-]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,6})\b/i);
  if (labeled) return labeled[1]!;
  const loose = text.match(/\b([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})\s*(?:miles|mi)\b/i);
  return loose?.[1] ?? null;
}

function visibleTextPartial(text: string): Record<string, unknown> {
  const partial: Record<string, unknown> = {};
  const vin = extractVin(text) ?? validateVinCandidate(text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i)?.[0] ?? "");
  if (vin) partial.vin = vin;

  const priceMatch =
    text.match(/(?:price|asking|listed\s+at|sale\s+price)\s*[:\-]?\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)/i) ??
    text.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)/);
  if (priceMatch) partial.priceUsd = priceMatch[1];

  const miles = milesFromVisible(text);
  if (miles) partial.miles = miles;

  const yearMakeModel = text.match(
    /\b((?:19|20)\d{2})\s+([A-Za-z][A-Za-z0-9\-]+)\s+([A-Za-z0-9][A-Za-z0-9\-]+(?:\s+[A-Za-z0-9][A-Za-z0-9\-]*){0,3})/,
  );
  if (yearMakeModel) {
    partial.year = yearMakeModel[1];
    partial.make = yearMakeModel[2];
    const bits = yearMakeModel[3]!.trim().split(/\s+/);
    partial.model = bits[0];
    if (bits.length > 1) partial.trim = bits.slice(1).join(" ");
  }

  const zipMatch = text.match(/\b([0-9]{5})(?:-[0-9]{4})?\b/);
  if (zipMatch) partial.zip = zipMatch[1];

  const stateZip = text.match(/\b([A-Z]{2})\s+[0-9]{5}\b/);
  if (stateZip) partial.state = stateZip[1];

  const colorMatch = text.match(/(?:exterior\s+color|color)\s*[:\-]\s*([A-Za-z][A-Za-z\s\-]{1,30})/i);
  if (colorMatch) partial.color = colorMatch[1]!.trim();

  const transmissionMatch = text.match(/\b(automatic|manual|cvt|dual[\s-]?clutch)\b/i);
  if (transmissionMatch) partial.transmission = transmissionMatch[1];

  const drivetrainMatch = text.match(/\b(AWD|FWD|RWD|4WD|four[\s-]?wheel|all[\s-]?wheel|front[\s-]?wheel|rear[\s-]?wheel)\b/i);
  if (drivetrainMatch) partial.drivetrain = drivetrainMatch[1];

  const fuelMatch = text.match(/\b(gasoline|gas|diesel|hybrid|electric|plug-?in hybrid|E85)\b/i);
  if (fuelMatch) partial.fuel = fuelMatch[1];

  const accidentMatch = text.match(/\b(\d+)\s+accident/i) ?? text.match(/\b(no accidents?|accident free|accident-free)\b/i);
  if (accidentMatch) partial.accidentsStated = accidentMatch[0];

  const ownerMatch = text.match(/\b(one[\s-]?owner|1[\s-]?owner|single[\s-]?owner|\d+\s+owners?)\b/i);
  if (ownerMatch) partial.ownersStated = ownerMatch[0];

  const titleMatch = text.match(/\b(clean title|salvage|rebuilt|reconditioned|flood|lemon|junk|branded title|clear title)\b/i);
  if (titleMatch) partial.titleStatus = titleMatch[0];

  const photoMatch = text.match(/\b(\d+)\s+(?:photos?|images?|pictures?)\b/i);
  if (photoMatch) partial.photoCount = photoMatch[1];

  const dealerMatch =
    text.match(/(?:dealer|seller|sold by|listed by)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 &.'\-]{2,60})/i);
  if (dealerMatch) partial.sellerName = dealerMatch[1]!.trim();

  return partial;
}

function urlPartial(url: string | null): Record<string, unknown> {
  if (!url) return {};
  const partial: Record<string, unknown> = {};
  const vin = extractVin(url);
  if (vin) partial.vin = vin;
  const yearMake = url.match(/\/((?:19|20)\d{2})[-_/]([A-Za-z]+)[-_/]([A-Za-z0-9]+)/);
  if (yearMake) {
    partial.year = yearMake[1];
    partial.make = yearMake[2];
    partial.model = yearMake[3];
  }
  return partial;
}

/** A search-results page is not one car. Do not pick the first card as the subject. */
function isMultiVehiclePage(html: string): boolean {
  let products = 0;
  let listItems = 0;
  let search = false;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const types = typeNames(record);
    if (types.some((type) => type.includes("searchresultspage"))) search = true;
    if (types.some((type) => type === "itemlist") && Array.isArray(record.itemListElement)) {
      listItems += record.itemListElement.length;
    }
    if (types.some((type) => type === "product" || type === "vehicle" || type === "car")) products += 1;
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") walk(value);
    }
  };
  for (const block of collectJsonLdBlocks(html)) walk(block);
  return search || listItems > 1 || products > 1;
}

function applyLayer(
  fields: ExtractedListingFields,
  source: ListingFieldSource,
  partial: Record<string, unknown>,
  snippets: string[],
): { fields: ExtractedListingFields; layer: ListingParseLayer } {
  return {
    fields: mergeLayer(fields, partial, source),
    layer: { source, fields: partial, textSnippets: snippets },
  };
}

/**
 * Parse listing HTML into layered fields + LLM-ready text.
 * Structured sources overwrite nothing already set (first non-null wins by priority order).
 */
export function parseListingHtml(html: string, url: string | null = null): ListingPageParse {
  const title = pageTitle(html);
  const visible = stripTags(html).slice(0, 50_000);
  const layers: ListingParseLayer[] = [];
  let fields = emptyExtractedFields();

  {
    const applied = applyLayer(fields, "url", urlPartial(url), url ? [url] : []);
    fields = applied.fields;
    layers.push(applied.layer);
  }

  const multi = isMultiVehiclePage(html);
  const jsonNodes: Record<string, unknown>[] = [];
  if (!multi) {
    for (const block of collectJsonLdBlocks(html)) walkJsonLd(block, jsonNodes);
  }
  {
    const applied = applyLayer(
      fields,
      "json_ld",
      multi ? {} : jsonLdToPartial(jsonNodes),
      jsonNodes.map((n) => JSON.stringify(n).slice(0, 400)),
    );
    fields = applied.fields;
    layers.push(applied.layer);
  }

  {
    const applied = applyLayer(fields, "open_graph", multi ? {} : openGraphPartial(html), []);
    fields = applied.fields;
    layers.push(applied.layer);
  }

  {
    const applied = applyLayer(fields, "meta", multi ? {} : {
      description: metaContent(html, "description"),
    }, []);
    fields = applied.fields;
    layers.push(applied.layer);
  }

  {
    const applied = applyLayer(fields, "microdata", multi ? {} : microdataPartial(html), []);
    fields = applied.fields;
    layers.push(applied.layer);
  }

  {
    const applied = applyLayer(fields, "visible_text", multi ? {} : visibleTextPartial(visible), [visible.slice(0, 500)]);
    fields = applied.fields;
    layers.push(applied.layer);
  }

  if (!fields.description.value && visible) {
    fields = mergeLayer(fields, { description: visible.slice(0, 2000) }, "visible_text");
  }

  // Build LLM text: title + structured crumbs + visible body. Redact injection phrases.
  const crumbs = [
    title ? `Title: ${title}` : "",
    fields.year.value ? `Year: ${fields.year.value}` : "",
    fields.make.value ? `Make: ${fields.make.value}` : "",
    fields.model.value ? `Model: ${fields.model.value}` : "",
    fields.priceUsd.value ? `Price: ${fields.priceUsd.value}` : "",
    fields.vin.value ? `VIN: ${fields.vin.value}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const llmText = redactUntrustedPromptText(`${crumbs}\n\n${visible}`, 12_000);

  return {
    url,
    title,
    layers,
    llmText,
    deterministic: fields,
  };
}

/** Parse pasted listing text the same way as visible text (no HTML layers). */
export function parseListingText(text: string, url: string | null = null): ListingPageParse {
  const cleaned = text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 50_000);
  let fields = emptyExtractedFields();
  const layers: ListingParseLayer[] = [];
  if (url) {
    const applied = applyLayer(fields, "url", urlPartial(url), [url]);
    fields = applied.fields;
    layers.push(applied.layer);
  }
  {
    const applied = applyLayer(fields, "pasted_text", visibleTextPartial(cleaned), [cleaned.slice(0, 500)]);
    fields = applied.fields;
    layers.push(applied.layer);
  }
  if (!fields.description.value) {
    fields = mergeLayer(fields, { description: cleaned.slice(0, 2000) }, "pasted_text");
  }
  return {
    url,
    title: null,
    layers,
    llmText: redactUntrustedPromptText(cleaned, 12_000),
    deterministic: fields,
  };
}
