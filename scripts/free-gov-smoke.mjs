#!/usr/bin/env node
/**
 * Truly free public endpoint smoke (no Auto.dev / SERV / secrets).
 * Opt-in: node scripts/free-gov-smoke.mjs
 */
const VIN = "4T1B11HK5JU123456";
const YEAR = 2020;
const MAKE = "TOYOTA";
const MODEL = "CAMRY";

async function get(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ac.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { ok: res.ok, status: res.status, json, url };
  } finally {
    clearTimeout(t);
  }
}

const checks = [];

{
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${VIN}?format=json`;
  const r = await get(url);
  checks.push({
    name: "vPIC DecodeVinValues",
    ok: r.ok && Array.isArray(r.json?.Results),
    status: r.status,
    url,
    note: r.ok ? `errorCode=${r.json?.Results?.[0]?.ErrorCode ?? "?"}` : "unavailable",
  });
}

{
  const params = new URLSearchParams({ make: MAKE, model: MODEL, modelYear: String(YEAR) });
  const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?${params}`;
  const r = await get(url);
  const results = r.json?.results ?? r.json?.Results;
  checks.push({
    name: "NHTSA recallsByVehicle",
    ok: r.ok && Array.isArray(results),
    status: r.status,
    url,
    note: r.ok ? `count=${results.length} (make/model/year — not VIN unrepaired)` : "unavailable",
  });
}

{
  const params = new URLSearchParams({ make: MAKE, model: MODEL, modelYear: String(YEAR) });
  const url = `https://api.nhtsa.gov/complaints/complaintsByVehicle?${params}`;
  const r = await get(url);
  checks.push({
    name: "NHTSA complaintsByVehicle",
    ok: r.ok && (typeof r.json?.count === "number" || Array.isArray(r.json?.results ?? r.json?.Results)),
    status: r.status,
    url,
    note: r.ok ? `count=${r.json?.count ?? (r.json?.results ?? r.json?.Results)?.length ?? "?"}` : "unavailable",
  });
}

{
  const url = `https://api.nhtsa.gov/SafetyRatings/modelyear/${YEAR}/make/${MAKE}/model/${MODEL}`;
  const r = await get(url);
  const results = r.json?.Results ?? r.json?.results;
  checks.push({
    name: "NHTSA SafetyRatings index",
    ok: r.ok && Array.isArray(results),
    status: r.status,
    url,
    note: r.ok ? `variants=${results.length}` : "unavailable",
  });
}

{
  const params = new URLSearchParams({ year: String(YEAR), make: MAKE, model: MODEL });
  const url = `https://www.fueleconomy.gov/ws/rest/vehicle/menu/options?${params}`;
  const r = await get(url);
  checks.push({
    name: "FuelEconomy.gov menu/options",
    ok: r.ok,
    status: r.status,
    url,
    note: r.ok ? "menu reachable" : "unavailable",
  });
}

let failed = 0;
for (const c of checks) {
  const mark = c.ok ? "OK" : "FAIL";
  if (!c.ok) failed += 1;
  console.log(`${mark}\t${c.name}\thttp=${c.status}\t${c.note}`);
}
console.log(
  JSON.stringify(
    {
      ok: failed === 0,
      failed,
      checks: checks.map(({ name, ok, status, note }) => ({ name, ok, status, note })),
      disclaimer:
        "Free public smoke only — not title/NMVTIS; not paid Auto.dev/SERV; not ready-for-prod claim.",
    },
    null,
    2,
  ),
);
process.exit(failed === 0 ? 0 : 1);
