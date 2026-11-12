/**
 * Inventory for flip golden cases when no live recording exists.
 * The real ranker, P&L, and decision code still run. SERV answers are
 * unusable on purpose so a missed review cannot publish High confidence.
 */
import type { GoldenCase } from "./cases";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function row(input: {
  vin: string;
  price: number;
  miles: number;
  ageDays: number;
  zip: string | null;
}): unknown {
  return {
    vin: input.vin,
    createdAt: daysAgo(input.ageDays),
    vehicle: {
      year: 2016,
      make: "Honda",
      model: "Civic",
      trim: "LX",
      fuel: "Gasoline",
      drivetrain: "FWD",
      bodyStyle: "Sedan",
    },
    retailListing: {
      price: input.price,
      miles: input.miles,
      city: "Dallas",
      state: "TX",
      zip: input.zip ?? "75201",
      dealer: "Dallas Honda",
      vdp: `https://www.dallashonda.example/used/${input.vin}`,
      distance: input.zip ? 12 : null,
      used: true,
    },
    history: { accidentCount: 0, oneOwner: true, ownerCount: 1 },
  };
}

export function resaleFixtureFetch(specCase: GoldenCase): typeof fetch {
  if (specCase.id === "L27") {
    return async (input) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!/\/listings\/?/.test(href)) {
        return new Response(JSON.stringify({ error: "no serv in fixture" }), { status: 503 });
      }
      const peers = [0, 1, 2, 3, 4].map((index) =>
        row({
          vin: `1HGCM82633A40${String(index).padStart(4, "0")}`,
          price: 7_200 + index * 100,
          miles: 70_000 + index * 2_000,
          ageDays: 14,
          zip: "75201",
        }),
      );
      peers.push(
        row({ vin: "2T1BURHE2GC640812", price: 5_900, miles: 150_733, ageDays: 20, zip: "75201" }),
        row({ vin: "1HGCM82633A400099", price: 6_400, miles: 82_000, ageDays: 12, zip: "75201" }),
      );
      return new Response(JSON.stringify({ data: peers }), { status: 200, headers: { "content-type": "application/json" } });
    };
  }
  if (specCase.id === "L5") {
    return async (input) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!/\/listings\/?/.test(href)) {
        return new Response(JSON.stringify({ error: "no serv in fixture" }), { status: 503 });
      }
      const rows = [0, 1, 2, 3, 4].map((index) =>
        row({
          vin: `1HGCM82633A20${String(index).padStart(4, "0")}`,
          price: 10_000 + index,
          miles: 70_000,
          ageDays: 20,
          zip: "10001",
        }),
      );
      rows.push(
        row({
          vin: "1HGCM82633A200016",
          price: 9_984,
          miles: 71_000,
          ageDays: 18,
          zip: "10001",
        }),
      );
      return new Response(JSON.stringify({ data: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }
  const budget = specCase.expect.budgetUsd ?? 10_000;
  const zip = specCase.location === "nationwide" || specCase.location === "from-note" ? null : specCase.location.zip;
  const peerPrice = Math.round(budget * 0.7);
  const rows = [0, 1, 2, 3, 4, 5].map((index) =>
    row({
      vin: `1HGCM82633A13${String(index).padStart(4, "0")}`,
      price: peerPrice + index * 80,
      miles: 55_000 + index * 1_200,
      ageDays: 12 + index,
      zip,
    }),
  );
  rows.push(
    row({
      vin: "1HGCM82633A004012",
      price: Math.round(budget * 0.5),
      miles: 60_000,
      ageDays: 10,
      zip,
    }),
  );
  rows.push(
    row({
      vin: "19XFB2F54CE000500",
      price: Math.round(budget * 0.35),
      miles: 64_000,
      ageDays: 500,
      zip,
    }),
  );
  return async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (/\/listings\/?/.test(href)) {
      return new Response(JSON.stringify({ data: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/chat\/completions|\/responses(?:\?|$)/.test(href)) {
      return new Response(JSON.stringify({ error: { message: "fixture review unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ Results: [], data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
