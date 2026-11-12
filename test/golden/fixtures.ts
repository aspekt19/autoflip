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
}) {
  return {
    vin: input.vin,
    vehicle: {
      year: input.year,
      make: input.make,
      model: input.model,
      bodyStyle: input.bodyStyle,
      drivetrain: input.drivetrain ?? null,
      trim: null,
    },
    retailListing: {
      price: input.price,
      miles: input.miles ?? 30_000,
      used: true,
      city: "Chicago",
      state: "IL",
      zip: "60601",
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

export function scriptedGoldenFetch(kind: "live-a" | "live-b", urls: string[]): typeof fetch {
  const rows = kind === "live-a" ? LIVE_A : LIVE_B;
  return async (input) => {
    const href = String(input);
    urls.push(href);
    if (href.includes("/listings")) return Response.json({ data: rows });
    if (href.includes("recallsByVehicle")) {
      return Response.json({ Count: 0, Message: "Results returned successfully", results: [] });
    }
    if (href.includes("DecodeVinValues")) {
      return Response.json({ Results: [{ DriveType: "FWD", ErrorCode: "0" }] });
    }
    return new Response(JSON.stringify({ error: "fixture" }), { status: 503, headers: { "content-type": "application/json" } });
  };
}
