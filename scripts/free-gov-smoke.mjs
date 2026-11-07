#!/usr/bin/env node
/**
 * Truly free public NHTSA smoke — four official families only (no Auto.dev / SERV / FuelEconomy).
 * Opt-in: npm run smoke:free-gov
 *
 * 1) vPIC DecodeVinValues — HTTP 200 is not success; note ErrorCode
 * 2) recallsByVehicle — make/model/year campaigns (not VIN unrepaired)
 * 3) complaintsByVehicle — model-level allegations
 * 4) SafetyRatings index — NCAP variants (Not Rated ≠ pass)
 */
// Official-style sample shape (contracts): partial VIN demonstrates ErrorCode inspection.
const VPIC_SMOKE_VIN = "5UXWX7C5*BA";
const YEAR = 2012;
const MAKE = "acura";
const MODEL = "rdx";
const NCAP_YEAR = 2013;
const NCAP_MAKE = "Acura";
const NCAP_MODEL = "rdx";

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
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(VPIC_SMOKE_VIN)}?format=json&modelyear=2011`;
  const r = await get(url);
  const row = r.json?.Results?.[0];
  const errorCode = row?.ErrorCode ?? null;
  // Reachable + Results present; ErrorCode must be inspected (partial VIN → non-zero is expected here).
  const reachable = r.ok && Array.isArray(r.json?.Results) && r.json.Results.length > 0;
  checks.push({
    name: "vPIC DecodeVinValues",
    ok: reachable && errorCode != null,
    status: r.status,
    url,
    note: reachable
      ? `http=200 ErrorCode=${errorCode} (${row?.ErrorText ?? "no ErrorText"}) — HTTP alone ≠ success`
      : "unavailable",
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
    note: r.ok
      ? `count=${results.length} (make/model/year campaigns — not VIN unrepaired/open)`
      : "unavailable",
  });
}

{
  const params = new URLSearchParams({ make: MAKE, model: MODEL, modelYear: String(YEAR) });
  const url = `https://api.nhtsa.gov/complaints/complaintsByVehicle?${params}`;
  const r = await get(url);
  const results = r.json?.results ?? r.json?.Results;
  checks.push({
    name: "NHTSA complaintsByVehicle",
    ok: r.ok && (typeof r.json?.count === "number" || Array.isArray(results)),
    status: r.status,
    url,
    note: r.ok
      ? `count=${r.json?.count ?? results?.length ?? "?"} (allegations — not VIN events)`
      : "unavailable",
  });
}

{
  const url = `https://api.nhtsa.gov/SafetyRatings/modelyear/${NCAP_YEAR}/make/${encodeURIComponent(NCAP_MAKE)}/model/${encodeURIComponent(NCAP_MODEL)}?format=json`;
  const r = await get(url);
  const results = r.json?.Results ?? r.json?.results;
  checks.push({
    name: "NHTSA SafetyRatings index",
    ok: r.ok && Array.isArray(results),
    status: r.status,
    url,
    note: r.ok
      ? `variants=${results.length} (Not Rated ≠ pass; RolloverPossibility 0 with Not Rated ≠ 0% risk)`
      : "unavailable",
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
      checkCount: checks.length,
      checks: checks.map(({ name, ok, status, note }) => ({ name, ok, status, note })),
      disclaimer:
        "Four free NHTSA GET smokes only — no FuelEconomy; not title/NMVTIS; not paid Auto.dev/SERV; not ready-for-prod claim.",
    },
    null,
    2,
  ),
);
process.exit(failed === 0 ? 0 : 1);
