/**
 * Hand-written upstream bodies for the Nov 12 live Find defects.
 * These are not recorded SERV calls. They reproduce the inventory the shopper saw.
 */

function car(input: {
  vin: string;
  year: number;
  make: string;
  model: string;
  bodyStyle: string;
  price: number;
  miles?: number;
  distance: number;
  drivetrain?: string | null;
  city?: string;
  state?: string;
  zip?: string;
}) {
  return {
    vin: input.vin,
    vehicle: {
      year: input.year,
      make: input.make,
      model: input.model,
      bodyStyle: input.bodyStyle,
      drivetrain: input.drivetrain ?? null,
      trim: input.model === "Forester" ? "2.5i Premium PZEV" : null,
    },
    retailListing: {
      price: input.price,
      miles: input.miles ?? 30_000,
      used: true,
      city: input.city ?? "Chicago",
      state: input.state ?? null,
      zip: input.zip ?? "60601",
      distance: input.distance,
      dealer: "Example Motors",
      vdpURL: `https://dealer.example/${input.vin}`,
      primaryImage: null,
    },
  };
}

const LIVE_A = [
  car({ vin: "1HD1KRP14NB000001", year: 2022, make: "Harley-Davidson", model: "Nightster", bodyStyle: "Motorcycle", price: 9000, distance: 800 }),
  car({ vin: "ZDM1UB5W5NB000002", year: 2021, make: "Ducati", model: "Monster", bodyStyle: "Motorcycle", price: 9500, distance: 900 }),
  car({ vin: "JYARM06E5NA000003", year: 2020, make: "Yamaha", model: "MT-07", bodyStyle: "Motorcycle", price: 8000, distance: 700 }),
  car({ vin: "JKBVNKC15NA000004", year: 2019, make: "Kawasaki", model: "Vulcan", bodyStyle: "Motorcycle", price: 7000, distance: 650 }),
  car({ vin: "1C9CK15G5N1000005", year: 2018, make: "Coachman", model: "Clipper", bodyStyle: "RV", price: 11000, distance: 1200 }),
  car({ vin: "2HGFC2F79NH000006", year: 2021, make: "Honda", model: "Civic", bodyStyle: "Sedan", price: 11500, distance: 400 }),
];

const LIVE_B = [
  car({ vin: "5N1AT2MT5LC000010", year: 2019, make: "Nissan", model: "Rogue", bodyStyle: "SUV", price: 22000, distance: 20, drivetrain: "FWD" }),
  car({ vin: "2T3R1RFV5NW000011", year: 2020, make: "Toyota", model: "RAV4", bodyStyle: "SUV", price: 23000, distance: 30, drivetrain: null }),
  car({ vin: "1C4RJFBG5LC000012", year: 2019, make: "Jeep", model: "Grand Cherokee", bodyStyle: "SUV", price: 24000, distance: 400, drivetrain: "AWD" }),
  car({ vin: "5XYZU3LB5HG000013", year: 2019, make: "Hyundai", model: "Tucson", bodyStyle: "SUV", price: 21000, distance: 40, drivetrain: "AWD" }),
];

const LIVE_C = [
  car({ vin: "4T1BF1FK5HU000021", year: 2017, make: "Toyota", model: "Camry", bodyStyle: "Sedan", price: 10900, miles: 88_000, distance: 18 }),
  car({ vin: "2T3R1RFV5HW000022", year: 2016, make: "Toyota", model: "RAV4", bodyStyle: "SUV", price: 11200, miles: 96_000, distance: 22 }),
];

const LIVE_D = [
  car({ vin: "5N1AT2MT5LC000031", year: 2019, make: "Nissan", model: "Rogue", bodyStyle: "SUV", price: 16000, distance: 12, drivetrain: "FWD" }),
  car({ vin: "2T3R1RFV5NW000032", year: 2018, make: "Toyota", model: "RAV4", bodyStyle: "SUV", price: 17000, distance: 15, drivetrain: null }),
  car({ vin: "5XYZU3LB5HG000033", year: 2018, make: "Hyundai", model: "Tucson", bodyStyle: "SUV", price: 16500, distance: 10, drivetrain: "AWD" }),
];

const LIVE_RANK = [
  car({ vin: "JF1SJADC8HH000001", year: 2014, make: "Subaru", model: "Forester", bodyStyle: "SUV", price: 6500, miles: 219_000, distance: 12, drivetrain: "AWD" }),
  car({ vin: "JF1SJADC8HH000002", year: 2016, make: "Subaru", model: "Forester", bodyStyle: "SUV", price: 9000, miles: 80_000, distance: 14, drivetrain: "AWD" }),
  car({ vin: "JF1SJADC8HH000003", year: 2017, make: "Subaru", model: "Forester", bodyStyle: "SUV", price: 9800, miles: 62_000, distance: 9, drivetrain: "AWD" }),
];

const LIVE_SUV = [
  car({ vin: "JF2SJAKC0FH550958", year: 2015, make: "Subaru", model: "Forester", bodyStyle: "SUV", price: 7396, miles: 65298, distance: 40, drivetrain: "AWD" }),
  car({ vin: "JF2SJAECXEH443264", year: 2014, make: "Subaru", model: "Forester", bodyStyle: "SUV", price: 12789, miles: 71568, distance: 18, drivetrain: "AWD" }),
  car({ vin: "2T3BF4DV3BW082762", year: 2011, make: "Toyota", model: "RAV4", bodyStyle: "SUV", price: 13529, miles: 94001, distance: 12, drivetrain: "AWD" }),
  car({ vin: "JF2GPABCXG9264082", year: 2016, make: "Subaru", model: "Crosstrek", bodyStyle: "SUV", price: 9300, miles: 169533, distance: 22, drivetrain: "AWD" }),
  car({ vin: "5J6RE4H52AL015464", year: 2010, make: "Honda", model: "CR-V", bodyStyle: "SUV", price: 10199, miles: 164010, distance: 50, drivetrain: "AWD" }),
  car({ vin: "JF2GTAMC6KH204551", year: 2019, make: "Subaru", model: "Crosstrek", bodyStyle: "SUV", price: 9498, miles: 174074, distance: 8, drivetrain: "AWD" }),
  car({ vin: "5J6RW2H81HL019561", year: 2017, make: "Honda", model: "CR-V", bodyStyle: "SUV", price: 12298, miles: 206977, distance: 60, drivetrain: "AWD" }),
];

const LIVE_ODD = [
  car({ vin: "7FARW2H85LE016314", year: 2020, make: "Honda", model: "CR-V", bodyStyle: "SUV", price: 12500, miles: 274026, distance: 30, drivetrain: "AWD" }),
  car({ vin: "JF2SJAKC0FH550111", year: 2016, make: "Subaru", model: "Forester", bodyStyle: "SUV", price: 14000, miles: 72000, distance: 12, drivetrain: "AWD" }),
];

const LIVE_STARTER = [
  // The live feed tags these as "Car", not "Sedan". A body filter that omits Car returns nothing.
  car({ vin: "2T1BURHE0JC000221", year: 2018, make: "Toyota", model: "Corolla", bodyStyle: "Car", price: 10900, miles: 78000, distance: 12 }),
  car({ vin: "2HGFC2F79JH000222", year: 2018, make: "Honda", model: "Civic", bodyStyle: "Car", price: 11200, miles: 64000, distance: 18 }),
  car({ vin: "4T1BF1FK5JU000223", year: 2018, make: "Toyota", model: "Camry", bodyStyle: "Car", price: 11500, miles: 70000, distance: 20 }),
  car({ vin: "1HGCV1F36JA000224", year: 2018, make: "Honda", model: "Accord", bodyStyle: "Car", price: 11800, miles: 72000, distance: 22 }),
  car({ vin: "KMHD84LF5JU000225", year: 2018, make: "Hyundai", model: "Elantra", bodyStyle: "Car", price: 9800, miles: 81000, distance: 14 }),
  car({ vin: "3N1AB7AP5JY000229", year: 2018, make: "Nissan", model: "Sentra", bodyStyle: "Car", price: 8900, miles: 77000, distance: 15 }),
  car({ vin: "JM1BL1UG0J1000226", year: 2018, make: "Mazda", model: "Mazda3", bodyStyle: "Car", price: 10200, miles: 69000, distance: 16 }),
  car({ vin: "JF2SHABCXJH000227", year: 2018, make: "Subaru", model: "Forester", bodyStyle: "SUV", price: 11900, miles: 74000, distance: 24, drivetrain: "AWD" }),
  car({ vin: "2T3BFREV5JW000228", year: 2018, make: "Toyota", model: "RAV4", bodyStyle: "SUV", price: 12100, miles: 88000, distance: 26, drivetrain: "AWD" }),
];

const LIVE_SAFETY = [
  car({ vin: "1HGCD7261RA043976", year: 1994, make: "Honda", model: "Accord", bodyStyle: "Sedan", price: 2761, miles: 73392, distance: 30, city: "Chesterton", state: "IN" }),
  car({ vin: "JHMES96625S024987", year: 2005, make: "Honda", model: "Civic", bodyStyle: "Sedan", price: 3495, miles: 104424, distance: 22 }),
  car({ vin: "2T1BURHE9GC669191", year: 2016, make: "Toyota", model: "Corolla", bodyStyle: "Sedan", price: 8000, miles: 106833, distance: 18 }),
  car({ vin: "1HGFA16896L133231", year: 2006, make: "Honda", model: "Civic", bodyStyle: "Sedan", price: 5900, miles: 82641, distance: 20 }),
];

const LIVE_TAX = [
  car({
    vin: "JTMBK33V286041380",
    year: 2008,
    make: "Toyota",
    model: "RAV4",
    bodyStyle: "SUV",
    price: 8094,
    miles: 112173,
    distance: 20,
    drivetrain: "4WD",
    city: "Hammond",
    state: "IN",
    zip: "46320",
  }),
  car({ vin: "2HGFC2F79JH000331", year: 2018, make: "Honda", model: "Civic", bodyStyle: "Sedan", price: 9900, miles: 60000, distance: 8 }),
];

type ScriptedKind = "live-a" | "live-b" | "live-c" | "live-d" | "live-rank" | "live-suv" | "live-odd" | "live-starter" | "live-tax" | "live-safety" | "length-retry" | "length-stop";

function rowsFor(kind: ScriptedKind, href: string) {
  if (kind === "live-a") return LIVE_A;
  if (kind === "live-b") return LIVE_B;
  if (kind === "live-d") return LIVE_D;
  if (kind === "live-suv") {
    return LIVE_SUV.map((row) =>
      row.vin === "JF2SJAECXEH443264" ? { ...row, history: { accidentCount: 1 } } : { ...row, history: { accidentCount: 0 } },
    );
  }
  if (kind === "live-odd") return LIVE_ODD;
  if (kind === "live-tax") return LIVE_TAX;
  if (kind === "live-safety") return LIVE_SAFETY;
  if (kind === "live-starter") {
    let model = "";
    let body = "";
    try {
      const url = new URL(href);
      model = url.searchParams.get("vehicle.model")?.toLowerCase() ?? "";
      body = url.searchParams.get("vehicle.bodyStyle")?.toLowerCase() ?? "";
    } catch {
      model = "";
    }
    const compact = /corolla|civic|camry|accord|elantra|mazda3|sentra/.test(model);
    if (compact && /^(suv|truck|van|minivan)$/i.test(body)) return [];
    const rows = !model ? LIVE_STARTER : LIVE_STARTER.filter((row) => String(row.vehicle.model).toLowerCase() === model);
    if (!body) return rows;
    const allowed = new Set(body.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
    return rows.filter((row) => allowed.has(String(row.vehicle.bodyStyle).toLowerCase()));
  }
  if (kind === "length-retry" || kind === "length-stop") {
    let model = "";
    try {
      model = new URL(href).searchParams.get("vehicle.model")?.toLowerCase() ?? "";
    } catch {
      model = "";
    }
    if (!model) return LIVE_C;
    return LIVE_C.filter((row) => String(row.vehicle.model).toLowerCase() === model);
  }
  if (kind === "live-rank") {
    return LIVE_RANK.map((row, index) => (index === 1 ? { ...row, history: { accidentCount: 1 } } : row));
  }
  let model = "";
  try {
    model = new URL(href).searchParams.get("vehicle.model")?.toLowerCase() ?? "";
  } catch {
    model = "";
  }
  return LIVE_C.filter((row) => String(row.vehicle.model).toLowerCase() === model);
}

function completion(id: string, content: unknown): Response {
  return Response.json({
    id,
    object: "chat.completion",
    created: 1,
    model: "gpt-6.1-sol",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content), refusal: null },
        finish_reason: "stop",
      },
    ],
  });
}

/**
 * Offline SERV stand-in for golden only. Production SERV interprets the note;
 * domain code must not. Keep this local to test/golden — never import into src/.
 */
function stubPlanFromNote(note: string): Record<string, unknown> {
  const money =
    note.match(/\b(?:under|below|max(?:imum)?|budget|around|about|tops?)\s*\$?\s*(\d{1,3}(?:,\d{3})+)\b/i) ||
    note.match(/\$\s*(\d{1,3}(?:,\d{3})+)\b/) ||
    note.match(/\b(?:under|below|max(?:imum)?|budget|around|about)\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*k\b/i) ||
    note.match(/\$\s*(\d{1,3}(?:,\d{3})+|\d+)\s*k\b/i) ||
    note.match(/\b(?:under|below|max(?:imum)?|budget|around|about)\s+(\d{1,3})\s*grand\b/i) ||
    note.match(/\b(\d{1,3})\s*grand\b/i) ||
    note.match(/\bbudget\s+(\d{2,3})\s*[-–]\s*(\d{2,3})\s*k\b/i);
  let maxUsd: number | null = null;
  let quote: string | null = null;
  if (money) {
    const raw = (money[2] ?? money[1]!).replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) {
      maxUsd = n < 1000 ? Math.round(n * 1000) : Math.round(n);
      quote = money[0]!.trim();
    }
  }
  const milesHit =
    note.match(/\b(?:less than|under|up to|max(?:imum)?)\s+(\d{1,3})\s*k\s*miles\b/i) ||
    note.match(/\b(?:less than|under|up to|max(?:imum)?)\s+(\d{2,3}(?:,\d{3})+)\s*miles\b/i) ||
    note.match(/\b(\d{1,3})\s*k\s*miles\b/i);
  let milesMax: number | null = null;
  if (milesHit) {
    const raw = milesHit[1]!.replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) milesMax = n < 1000 ? Math.round(n * 1000) : Math.round(n);
  }
  const yearHit =
    note.match(/\b(20\d{2}|19\d{2})\s+or\s+newer\b/i) ||
    note.match(/\bnothing older than\s+(20\d{2}|19\d{2})\b/i) ||
    note.match(/\bnewer than\s+(20\d{2}|19\d{2})\b/i);
  let yearMin: number | null = null;
  if (yearHit) {
    yearMin = Number(yearHit[1]);
    if (/newer than/i.test(yearHit[0])) yearMin += 1;
  }
  const body = /\bminivan|3-row|three[\s-]?row\b/i.test(note)
    ? "minivan"
    : /\bsuv|crossover\b/i.test(note)
      ? "suv"
      : /\btruck|pickup\b/i.test(note)
        ? "truck"
        : /\bsedan\b/i.test(note)
          ? "sedan"
          : "any";
  const hybrid = /\bhybrid\b/i.test(note);
  const awd = /\b(?:awd|4wd|4x4|all[\s-]?wheel)\b/i.test(note);
  const chicago = /\bchicago\b/i.test(note);
  const seats = note.match(/\b(\d+)\s*seats?\b/i);
  const seatsMin = seats ? Number(seats[1]) : /\b7\s*seats?\b|\b3-row\b/i.test(note) ? 7 : null;
  const namedModels: { make: string; model: string }[] = [];
  if (/\bcivic\b/i.test(note)) namedModels.push({ make: "Honda", model: "Civic" });
  if (/\bcorolla\b/i.test(note)) namedModels.push({ make: "Toyota", model: "Corolla" });
  const excludedMakes: string[] = [];
  if (/\bnot a kia\b|\bno kia\b/i.test(note)) excludedMakes.push("Kia");
  const directionModels =
    namedModels.length > 0
      ? namedModels
      : body === "suv"
        ? [{ make: "Toyota", model: "RAV4" }]
        : [{ make: "Toyota", model: "Camry" }];
  return {
    summary: note.trim().slice(0, 200) || "Car shopping request.",
    bodyStyles: [body],
    budget: { maxUsd, approximate: /\baround|about|approximately|roughly|~\b/i.test(note), quote },
    yearMin,
    yearMax: null,
    milesMax,
    drivetrain: awd
      ? { value: "awd_4wd", strength: "required", quote: "AWD" }
      : { value: "any", strength: "none", quote: null },
    fuel: hybrid
      ? { value: "hybrid", strength: "preferred", quote: "hybrid" }
      : { value: "any", strength: "none", quote: null },
    seatsMin,
    location: chicago
      ? { zip: "60601", phrase: "Chicago", needsZip: false }
      : { zip: null, phrase: null, needsZip: false },
    priorities: [],
    namedModels,
    excludedMakes,
    question: maxUsd == null ? { id: "budget", text: "What is your maximum budget?" } : { id: "none", text: null },
    directions: [
      {
        label: body === "suv" ? "SUVs and crossovers" : namedModels.length ? "Named models" : "Starting search",
        why: "Golden SERV stub plan for offline gate.",
        bodyStyle: body,
        models: directionModels,
      },
    ],
  };
}

/** Valid plan / decide / challenge answers for the offline full Find path. */
export function scriptedServResponse(body: string): Response | null {
  let name = "";
  try {
    const parsed = JSON.parse(body) as { response_format?: { json_schema?: { name?: string } }; messages?: { role?: string; content?: string }[] };
    name = parsed.response_format?.json_schema?.name ?? "";
    if (name === "find_plan") {
      const user = parsed.messages?.find((message) => message.role === "user")?.content ?? "";
      let note = "";
      try {
        const payload = JSON.parse(user) as { note?: unknown };
        note = typeof payload.note === "string" ? payload.note : user;
      } catch {
        note = user;
      }
      return completion("chatcmpl-goldenplan", stubPlanFromNote(note));
    }
    if (name === "find_decide") {
      const user = parsed.messages?.find((message) => message.role === "user")?.content ?? "";
      const facts = JSON.parse(user).facts as {
        shortlistKeys?: string[];
        shortlist?: { key?: string; vin?: string; make?: string; model?: string; miles?: number }[];
      };
      // Prefer a lower-mile AWD Subaru when present — mirrors a SERV preference pick offline.
      const shortlist = facts.shortlist ?? [];
      const preferred =
        shortlist.find(
          (row) =>
            /subaru/i.test(row.make ?? "") &&
            /forester|crosstrek/i.test(row.model ?? "") &&
            (row.miles == null || row.miles < 100_000),
        ) ?? shortlist[0];
      const key =
        preferred?.key ||
        preferred?.vin ||
        facts.shortlistKeys?.[0] ||
        shortlist[0]?.key ||
        "";
      return completion("chatcmpl-goldendecide", {
        pickKey: key,
        action: "negotiate",
        confidence: "medium",
        confidenceWhy: "This car fits the budget and has fewer miles than the next one.",
        reasons: [{ text: "It fits the budget and has fewer miles than the next car in the list.", evidenceIds: [`car:${key}`] }],
        watchOuts: [],
        askSeller: [],
        alternatives: [],
        offerUsd: null,
      });
    }
    if (name === "find_challenge") {
      return completion("chatcmpl-goldenchallenge", {
        agree: true,
        issues: [],
        revised: { pickKey: null, action: null, confidence: null },
      });
    }
  } catch {
    return null;
  }
  return null;
}

function emptyLength(id: string): Response {
  return Response.json({
    id,
    object: "chat.completion",
    created: 1,
    model: "gpt-6.1-sol",
    choices: [{ index: 0, message: { role: "assistant", content: "", refusal: null }, finish_reason: "length" }],
    usage: {
      prompt_tokens: 800,
      completion_tokens: 65536,
      total_tokens: 66336,
      completion_tokens_details: { reasoning_tokens: 65536 },
    },
  });
}

function schemaName(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { response_format?: { json_schema?: { name?: string } } };
    return parsed.response_format?.json_schema?.name ?? "serv";
  } catch {
    return "serv";
  }
}

export function scriptedGoldenFetch(
  kind: ScriptedKind,
  urls: string[],
): typeof fetch {
  const attempts = new Map<string, number>();
  return async (input, init) => {
    const href = String(input);
    urls.push(href);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    if (href.includes("/chat/completions") || href.includes("/responses")) {
      if (kind === "length-retry" || kind === "length-stop") {
        const name = schemaName(rawBody);
        const count = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, count);
        if (kind === "length-stop" || count === 1) return emptyLength(`chatcmpl-len${name}${count}`);
      }
      const serv = scriptedServResponse(rawBody);
      if (serv) return serv;
    }
    if (href.includes("/listings")) return Response.json({ data: rowsFor(kind, href) });
    if (href.includes("recallsByVehicle")) {
      return Response.json({ Count: 0, Message: "Results returned successfully", results: [] });
    }
    if (href.includes("DecodeVinValues")) {
      return Response.json({ Results: [{ DriveType: "FWD", ErrorCode: "0" }] });
    }
    return new Response(JSON.stringify({ error: "fixture" }), { status: 503, headers: { "content-type": "application/json" } });
  };
}
