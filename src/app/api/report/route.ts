import { claimsFindAnalysisHandoff, verifyFindAnalysisContext } from "@/server/find-analysis-context";
import { prechargeAnalysisGate } from "@/domain/find-analysis-handoff";
import { decideReportCharge } from "@/domain/report-chargeability";
import { fitHeadline } from "@/domain/fit";
import { isVinOnlyLookup, vinDetailGaps } from "@/domain/vin-report";
import { findUserReport, persistReport, readPersistedReport, rememberUserReport, reportReusable } from "@/io/persist-report";
import { getKv } from "@/io/kv";
import { REPORT_FAILED_TEXT, reportReadyMessage } from "@/io/telegram";
import { assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode } from "@/server/mcp";
import { balanceOf, grantCredit, spendCredit, userId } from "@/server/session";
import { sendLinkedTelegram } from "@/server/telegram-notify";
import { originOf } from "@/server/secrets";

export const dynamic = "force-dynamic";
/** Listings, government data, then a rules call and a two-step explanation. Hobby allows 60s. */
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const url = typeof body.url === "string" ? body.url : undefined;
  const vin = typeof body.vin === "string" ? body.vin : undefined;
  let askingPriceUsd = typeof body.askingPriceUsd === "number" ? body.askingPriceUsd : undefined;
  let miles = typeof body.miles === "number" ? body.miles : undefined;
  const repairAbility = body.repairAbility === "none" || body.repairAbility === "minor" || body.repairAbility === "major" || body.repairAbility === "unknown"
    ? body.repairAbility
    : undefined;
  const targetProfitUsd = typeof body.targetProfitUsd === "number" ? body.targetProfitUsd : undefined;
  const budgetUsd = typeof body.budgetUsd === "number" ? body.budgetUsd : undefined;
  const budgetKnown = body.budgetKnown === true || typeof budgetUsd === "number";
  let zip = typeof body.zip === "string" ? body.zip : undefined;
  const cta = typeof body.cta === "string" ? body.cta : null;
  const selectedVin = typeof body.selectedVin === "string" ? body.selectedVin : undefined;
  const selectedVdp = typeof body.selectedVdp === "string" ? body.selectedVdp : null;
  const findContextToken = typeof body.findContextToken === "string" ? body.findContextToken : undefined;

  // Identity must be resolvable BEFORE any credit gate — never charge then ask for a URL.
  const identity = prechargeAnalysisGate({ url, vin });
  if (!identity.ok) {
    const surfaceHint = body.surface === "check" || body.surface === "find" ? body.surface : "report";
    return Response.json(
      {
        error: identity.error,
        message: identity.message,
        cta,
        surface: surfaceHint,
      },
      { status: 400 },
    );
  }

  // Client-selected VIN must match resolved identity when both are present.
  if (selectedVin && selectedVin.trim().toUpperCase() !== identity.vin) {
    return Response.json(
      {
        error: "find_context_invalid",
        reason: "vin_mismatch",
        message:
          "That find result is no longer trusted for full analysis. Run Find again and choose the same car, or paste a listing URL on Check a car. No credit was charged.",
        cta,
        surface: "find",
        charge: false,
        outcome: "refused_invalid_find_context",
      },
      { status: 400 },
    );
  }

  const id = await userId();
  const mode = parseMode(body.mode);
  const vinKey = identity.vin;
  const claimingFind = claimsFindAnalysisHandoff({
    surface: typeof body.surface === "string" ? body.surface : null,
    cta,
    findContextToken,
  });
  const surfaceHint = claimingFind ? "find" : body.surface === "check" ? "check" : "report";

  // Idempotent resume for an already-saved report — same car, 0 additional debit.
  // Checked before find-context so back/refresh still works after token expiry.
  if (vinKey) {
    const existingId = await findUserReport(getKv(), id, vinKey, mode);
    if (existingId) {
      const existing = await readPersistedReport(existingId);
      if (existing && reportReusable(existing, { mode, askingPriceUsd, miles })) {
        await rememberUserReport(getKv(), id, vinKey, existing.id, existing);
        return Response.json({
          ...existing,
          balance: await balanceOf(id),
          alreadySaved: true,
          cta,
          surface: surfaceHint,
        });
      }
    }
  }

  // Server-origin find trust — verified BEFORE balance / assemble / spend.
  // Client surface/cta/VDP heuristics alone never grant trust.
  let trustedFind = false;
  let resolvedUrl = url;
  if (claimingFind) {
    const verified = await verifyFindAnalysisContext(getKv(), {
      userId: id,
      token: findContextToken,
      vin: identity.vin,
      claimedVdp: selectedVdp ?? url ?? null,
      claimedMiles: miles ?? null,
      claimedZip: zip ?? null,
    });
    if (!verified.ok) {
      return Response.json(
        {
          error: verified.error,
          reason: verified.reason,
          message: verified.message,
          cta,
          surface: "find",
          charge: false,
          outcome: "refused_invalid_find_context",
        },
        { status: 400 },
      );
    }
    trustedFind = true;
    // Prefer server-stored facts — do not trust client overlays for ask/miles/ZIP/VDP.
    const ctx = verified.record;
    resolvedUrl = ctx.vdp ?? url;
    if (ctx.miles != null) miles = ctx.miles;
    if (ctx.zip) zip = ctx.zip;
    if (ctx.askingPriceUsd != null) askingPriceUsd = ctx.askingPriceUsd;
    else askingPriceUsd = undefined;
  }

  const surface = trustedFind ? "find" : body.surface === "check" ? "check" : "report";

  // Manual VIN entry still needs typed ask/miles/ZIP. Trusted /find handoff already
  // selected a discovered listing — re-fetch by VIN; do not demand re-typed feed fields.
  if (!trustedFind && isVinOnlyLookup({ url: resolvedUrl, vin: vin ?? identity.vin })) {
    const missing = vinDetailGaps({ askingPriceUsd, miles, zip });
    if (missing.length > 0) {
      return Response.json(
        {
          error: "vin_needs_details",
          missing,
          message: `A VIN has no asking price of its own. Add ${missing.join(", ")} before the report.`,
          cta,
          surface,
        },
        { status: 400 },
      );
    }
  }

  if ((await balanceOf(id)) < 1) {
    return Response.json(
      {
        error: "credits_required",
        balance: 0,
        message: "A full report costs 1 credit.",
        cta,
        surface,
      },
      { status: 403 },
    );
  }

  const assembled = await assembleReport(
    {
      mode,
      vin: vin ?? vinKey,
      url: resolvedUrl,
      make: typeof body.make === "string" ? body.make : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      zip,
      year: typeof body.year === "number" ? body.year : undefined,
      askingPriceUsd,
      miles,
      repairAbility,
      targetProfitUsd,
      budgetUsd: budgetUsd ?? null,
      budgetKnown,
    },
    { ...runtimeDeps(), servSurface: surface === "check" ? "check" : "report" },
  );
  if (!assembled.ok) {
    await sendLinkedTelegram(id, REPORT_FAILED_TEXT);
    return Response.json({ error: assembled.error, message: assembled.message }, { status: assembled.status });
  }

  // Incident-class unusable ask / missing critical input → clear refusal, 0 debit.
  const chargeDecision = decideReportCharge(assembled.report.computed);
  if (!chargeDecision.charge) {
    return Response.json(
      {
        error: chargeDecision.error,
        outcome: chargeDecision.outcome,
        message: chargeDecision.message,
        charge: false,
        cta,
        surface,
        // Provenance only — not a completed paid report.
        observedNotes: assembled.report.computed.dataNotes.slice(0, 4),
      },
      { status: 422 },
    );
  }

  const spent = await spendCredit(id, `report:${assembled.report.id}`);
  if (!spent.ok) {
    return Response.json(
      { error: "credits_required", balance: spent.balance, message: "A full report costs 1 credit." },
      { status: 403 },
    );
  }
  try {
    await persistReport(assembled.report);
    if (vinKey) await rememberUserReport(getKv(), id, vinKey, assembled.report.id, assembled.report);
  } catch {
    await grantCredit(id, 1, `refund:${assembled.report.id}`);
    await sendLinkedTelegram(id, REPORT_FAILED_TEXT);
    return Response.json({ error: "save_failed", message: "The report did not finish. No credit was used." }, { status: 500 });
  }
  const car = assembled.report.computed.subject;
  const ready = reportReadyMessage({
    car: `${car.year} ${car.make} ${car.model}`,
    recommendation: fitHeadline(assembled.report.computed),
    origin: originOf(request),
    reportId: assembled.report.id,
  });
  await sendLinkedTelegram(id, ready.text, ready.reply_markup.inline_keyboard[0]?.[0]);
  return Response.json({ ...assembled.report, balance: spent.balance });
}
