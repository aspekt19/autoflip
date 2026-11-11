#!/usr/bin/env npx tsx
/**
 * Route-level Find → Watch → Radar Check acceptance over real HTTP.
 *
 * Live (preview/prod after deploy):
 *   BASE_URL=https://… COOKIE='authjs.session-token=…' npx tsx scripts/e2e-find-radar.ts
 *
 * CI / local stub (upstreams labelled STUB — never shown as live results):
 *   1. node scripts/e2e-find-radar-stub-upstreams.mjs
 *   2. Start Next with LEMONLESS_E2E_STUB=1, SERV_API_KEY=stub, SERV_BASE_URL + AUTODEV_BASE_URL
 *      pointing at the stub, AUTH_SECRET + dummy Google creds so authIsConfigured is true.
 *   3. BASE_URL=http://127.0.0.1:PORT npx tsx scripts/e2e-find-radar.ts
 *      (script calls /api/e2e/bootstrap for a stub session cookie when COOKIE is unset)
 *
 * Asserts lemonless.decision_proof.v1 on /api/need, Find settle (decide path), and radar Check.
 */
import { isDecisionProofRecord, type DecisionProofRecord } from "../src/domain/decision-proof-record";

const BASE = (process.env.BASE_URL || "").replace(/\/$/, "");
const NOTE =
  process.env.E2E_NOTE ||
  "Looking for a Toyota RAV4 near Miami under $18,000 with under 80,000 miles for commuting.";

if (!BASE) {
  console.error("BASE_URL is required (e.g. http://127.0.0.1:3000 or https://preview…)");
  process.exit(2);
}

function cookieJar(initial?: string | null) {
  let cookie = initial?.trim() || "";
  return {
    header(): string | undefined {
      return cookie || undefined;
    },
    absorb(res: Response) {
      const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      const list = raw.length
        ? raw
        : (() => {
            const single = res.headers.get("set-cookie");
            return single ? [single] : [];
          })();
      for (const row of list) {
        const part = row.split(";")[0]?.trim();
        if (!part) continue;
        const name = part.split("=")[0];
        if (!name) continue;
        const others = cookie
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((s) => !s.startsWith(`${name}=`));
        others.push(part);
        cookie = others.join("; ");
      }
    },
  };
}

async function api(
  jar: ReturnType<typeof cookieJar>,
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; body: Record<string, unknown> }> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  jar.absorb(res);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, body };
}

function assertProof(records: unknown, purpose: string, label: string): DecisionProofRecord {
  if (!Array.isArray(records)) {
    throw new Error(`${label}: missing proofRecords array`);
  }
  const typed = records.filter(isDecisionProofRecord);
  const hit = typed.find((row) => row.purpose === purpose);
  if (!hit) {
    throw new Error(`${label}: missing proof for ${purpose}; got ${typed.map((r) => r.purpose).join(",") || "none"}`);
  }
  if (hit.status === "ok") {
    if (!hit.servResponseId) throw new Error(`${label}: ${purpose} ok but no servResponseId`);
    if (!hit.rubricId) throw new Error(`${label}: ${purpose} ok but no rubricId`);
  } else if (!hit.reason?.trim()) {
    throw new Error(`${label}: ${purpose} status=${hit.status} missing reason`);
  }
  // Live / stub-ok path must surface a provider id when SERV was actually called.
  if (process.env.E2E_REQUIRE_OK_IDS === "1" && hit.status === "ok" && !hit.servResponseId) {
    throw new Error(`${label}: ${purpose} missing SERV id under E2E_REQUIRE_OK_IDS`);
  }
  return hit;
}

async function main() {
  const jar = cookieJar(process.env.COOKIE || null);

  if (!jar.header()) {
    console.log("No COOKIE set — requesting stub session via /api/e2e/bootstrap");
    const boot = await api(jar, "/api/e2e/bootstrap", { method: "POST", body: "{}" });
    if (!boot.res.ok || !boot.body.ok) {
      throw new Error(
        `bootstrap failed (${boot.res.status}): ${JSON.stringify(boot.body)}. For live runs set COOKIE=…`,
      );
    }
    if (boot.body.stub !== true) {
      throw new Error("bootstrap did not label stub:true — refusing to continue");
    }
    console.log("STUB session minted:", boot.body.label);
  }

  // 1) Free text → /api/need
  console.log("1) POST /api/need");
  const need = await api(jar, "/api/need", {
    method: "POST",
    body: JSON.stringify({ text: NOTE, mode: "personal", budgetKnown: true, budgetUsd: 18000 }),
  });
  if (!need.res.ok || !need.body.ok) {
    throw new Error(`/api/need failed (${need.res.status}): ${JSON.stringify(need.body)}`);
  }
  const needProof = assertProof(need.body.proofRecords, "find_plan", "/api/need");
  if (needProof.status !== "ok" || !needProof.servResponseId) {
    throw new Error(
      `/api/need find_plan must be ok with a SERV id (got status=${needProof.status} id=${needProof.servResponseId})`,
    );
  }
  console.log("   find_plan", needProof.status, needProof.servResponseId);

  const structuredNeed = need.body.need;
  if (!structuredNeed || typeof structuredNeed !== "object") {
    throw new Error("/api/need missing need object");
  }

  // 2) Find match → decide path (site default; FIND_DECIDE_PATH=0 keeps next-check)
  console.log("2) POST /api/match");
  const match = await api(jar, "/api/match", {
    method: "POST",
    body: JSON.stringify({ need: structuredNeed }),
  });
  if (!match.res.ok) {
    throw new Error(`/api/match failed (${match.res.status}): ${JSON.stringify(match.body)}`);
  }
  const token =
    typeof match.body.searchContextToken === "string" ? match.body.searchContextToken : null;
  if (!token) throw new Error("/api/match missing searchContextToken");
  const decidePath = match.body.decidePathEnabled === true;

  let settleProof: DecisionProofRecord | null = null;
  if (decidePath) {
    console.log("3) POST /api/find/decide (site decide path)");
    const decided = await api(jar, "/api/find/decide", {
      method: "POST",
      body: JSON.stringify({ searchContextToken: token }),
    });
    if (!decided.res.ok || !decided.body.ok) {
      throw new Error(
        `/api/find/decide failed (${decided.res.status}): ${JSON.stringify(decided.body)}`,
      );
    }
    const picks = decided.body.pickProofRecords;
    settleProof = assertProof(picks, "find_decide", "/api/find/decide");
    console.log("   find_decide", settleProof.status, settleProof.servResponseId ?? settleProof.reason);
    if (process.env.E2E_REQUIRE_FIND_SETTLE_OK === "1") {
      if (settleProof.status !== "ok" || !settleProof.servResponseId) {
        throw new Error(
          `Find decide must be ok with SERV id under E2E_REQUIRE_FIND_SETTLE_OK (got ${settleProof.status})`,
        );
      }
    }
  } else {
    console.log("3) POST /api/find/next-check (until verdict proof or stop)");
    let hopToken = token;
    for (let hop = 0; hop < 8; hop += 1) {
      const step = await api(jar, "/api/find/next-check", {
        method: "POST",
        body: JSON.stringify({ searchContextToken: hopToken }),
      });
      if (!step.res.ok || !step.body.ok) {
        throw new Error(
          `/api/find/next-check hop ${hop} failed (${step.res.status}): ${JSON.stringify(step.body)}`,
        );
      }
      if (typeof step.body.searchContextToken === "string") {
        hopToken = step.body.searchContextToken;
      }
      const picks = step.body.pickProofRecords;
      if (Array.isArray(picks) && picks.length > 0) {
        settleProof = assertProof(picks, "verdict_decide", `next-check hop ${hop}`);
        console.log("   verdict_decide", settleProof.status, settleProof.servResponseId ?? settleProof.reason);
        if (process.env.E2E_REQUIRE_FIND_SETTLE_OK === "1") {
          if (settleProof.status !== "ok" || !settleProof.servResponseId) {
            throw new Error(
              `Find settle must be ok with SERV id under E2E_REQUIRE_FIND_SETTLE_OK (got ${settleProof.status})`,
            );
          }
        }
        break;
      }
      const loop = step.body.loop as { continue?: boolean } | undefined;
      if (!loop?.continue) {
        throw new Error(
          `next-check stopped without pickProofRecords/verdict_decide (hop ${hop}): ${JSON.stringify(step.body.loop)}`,
        );
      }
    }
  }
  if (!settleProof) throw new Error("Find settle never returned a decide proof record");

  // 4) Watch
  console.log("4) POST /api/radar/searches (Watch)");
  const watch = await api(jar, "/api/radar/searches", {
    method: "POST",
    body: JSON.stringify({
      name: "E2E RAV4 stub watch",
      mode: "personal",
      criteria: {
        make: "Toyota",
        model: "RAV4",
        priceMax: 18000,
        zip: "33101",
        radiusMiles: 50,
        milesMax: 80000,
        freeText: NOTE,
        criteriaParseSource: "serv",
        criteriaResponseId: needProof.servResponseId,
        criteriaOrigin: "find",
      },
    }),
  });
  if (!watch.res.ok) {
    throw new Error(`/api/radar/searches failed (${watch.res.status}): ${JSON.stringify(watch.body)}`);
  }

  // 5) Radar Check
  console.log("5) POST /api/radar/check");
  const check = await api(jar, "/api/radar/check", { method: "POST", body: "{}" });
  if (!check.res.ok || !check.body.ok) {
    throw new Error(`/api/radar/check failed (${check.res.status}): ${JSON.stringify(check.body)}`);
  }
  const radarProofs = check.body.proofRecords;
  if (!Array.isArray(radarProofs) || radarProofs.length === 0) {
    // Honest empty is allowed only when SERV skipped with a proof — require at least one record.
    throw new Error(`/api/radar/check missing proofRecords: ${JSON.stringify(check.body)}`);
  }
  const radarDecide = assertProof(radarProofs, "verdict_decide", "/api/radar/check");
  if (radarDecide.status !== "ok" || !radarDecide.servResponseId) {
    throw new Error(
      `/api/radar/check verdict_decide must be ok with a SERV id (got status=${radarDecide.status} id=${radarDecide.servResponseId} reason=${radarDecide.reason})`,
    );
  }
  console.log(
    "   radar",
    radarDecide.purpose,
    radarDecide.status,
    radarDecide.servResponseId ?? radarDecide.reason,
  );

  console.log("OK — Find/Radar HTTP chain asserted proof records on each SERV step.");
  console.log(
    JSON.stringify(
      {
        need: { status: needProof.status, servResponseId: needProof.servResponseId },
        findSettle: { status: settleProof.status, servResponseId: settleProof.servResponseId },
        radar: { purpose: radarDecide.purpose, status: radarDecide.status, servResponseId: radarDecide.servResponseId },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
