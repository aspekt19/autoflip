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
import {
  claimFindAnalysis,
  clearOrphanFindAnalysisReceipt,
  completeFindAnalysis,
  findAnalysisSpendKey,
  legacyReportUuidSpendKey,
  releaseFindAnalysis,
  waitForFindAnalysisReceipt,
  type ReportAnalysisIdentity,
} from "@/server/report-analysis-idempotency";
import { commitFreeCheck, releaseFreeCheck, reserveFreeCheck } from "@/io/free-check-quota";
import {
  balanceOf,
  compensateSpendCredit,
  spendCredit,
  ledgerOwnerId,
  requireVerifiedAccountForChecks,
} from "@/server/session";
import { sendLinkedTelegram } from "@/server/telegram-notify";
import { originOf } from "@/server/secrets";
import { freeCheckMonthKey } from "@/domain/free-check-quota";

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

  const mode = parseMode(body.mode);
  const vinKey = identity.vin;
  const claimingFind = claimsFindAnalysisHandoff({
    surface: typeof body.surface === "string" ? body.surface : null,
    cta,
    findContextToken,
  });
  // VIN / listing-URL checks (not Find handoff) require a verified Auth.js account.
  // Anonymous af_uid cannot mint a fresh monthly free allotment by clearing cookies.
  const vehicleCheckSurface = !claimingFind;
  let id: string;
  if (vehicleCheckSurface) {
    const access = await requireVerifiedAccountForChecks();
    if (!access.ok) return access.response;
    id = access.id;
  } else {
    id = await ledgerOwnerId();
  }
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

  /**
   * Free monthly CHECK allotment (VIN / own listing URL only).
   * Find handoff never uses free checks — always report credits + claim fence.
   */
  let freeCheckKey: string | null = null;
  let usedFreeCheck = false;
  if (vehicleCheckSurface && !trustedFind) {
    const month = freeCheckMonthKey();
    freeCheckKey = `free-check:report:${id}:${month}:${vinKey}:${mode}`;
    const reserved = await reserveFreeCheck(getKv(), id, freeCheckKey);
    if (reserved.ok) {
      usedFreeCheck = true;
    } else if (reserved.reason === "lock_busy") {
      return Response.json(
        {
          error: "quota_busy",
          message: "Could not reserve a free vehicle check right now. Retry in a moment. No credit was charged.",
          charge: false,
          freeChecks: reserved.view,
          cta,
          surface,
        },
        { status: 503 },
      );
    }
    // exhausted → fall through to paid credits
  }

  if (!usedFreeCheck && (await balanceOf(id)) < 1) {
    return Response.json(
      {
        error: "credits_required",
        balance: 0,
        message: vehicleCheckSurface
          ? "You have used this month’s 3 free vehicle checks. A full report costs 1 credit, or wait until the UTC month reset."
          : "A full report costs 1 credit.",
        cta,
        surface,
      },
      { status: 403 },
    );
  }

  // Selected-listing analysis identity: one findContextToken → at most one charged report.
  // Claim BEFORE assemble so parallel first submits cannot each mint a UUID and double-spend.
  const analysisIdentity: ReportAnalysisIdentity | null =
    trustedFind && findContextToken?.trim()
      ? { userId: id, findContextToken: findContextToken.trim() }
      : null;
  /** Fence for this request's in_progress claim — required for release/complete. */
  let heldClaimId: string | null = null;
  if (analysisIdentity) {
    let claim = await claimFindAnalysis(getKv(), analysisIdentity);
    if (claim.kind === "replay") {
      const existing = await readPersistedReport(claim.receipt.reportId);
      if (existing) {
        if (vinKey) await rememberUserReport(getKv(), id, vinKey, existing.id, existing);
        return Response.json({
          ...existing,
          balance: await balanceOf(id),
          alreadySaved: true,
          cta,
          surface,
        });
      }
      // Completed receipt without durable report — clear orphan and reclaim once.
      await clearOrphanFindAnalysisReceipt(getKv(), analysisIdentity);
      claim = await claimFindAnalysis(getKv(), analysisIdentity);
      if (claim.kind === "replay") {
        const again = await readPersistedReport(claim.receipt.reportId);
        if (again) {
          if (vinKey) await rememberUserReport(getKv(), id, vinKey, again.id, again);
          return Response.json({
            ...again,
            balance: await balanceOf(id),
            alreadySaved: true,
            cta,
            surface,
          });
        }
        return Response.json(
          {
            error: "analysis_conflict",
            reason: "orphan_receipt",
            message:
              "That find analysis receipt is inconsistent. Run Find again and choose the same car. No credit was charged.",
            charge: false,
            cta,
            surface,
          },
          { status: 409 },
        );
      }
      // Fall through — reclaimed claim may be proceed / in_progress / conflict.
    }
    if (claim.kind === "in_progress") {
      const receipt = await waitForFindAnalysisReceipt(getKv(), analysisIdentity);
      if (receipt) {
        const existing = await readPersistedReport(receipt.reportId);
        if (existing) {
          if (vinKey) await rememberUserReport(getKv(), id, vinKey, existing.id, existing);
          return Response.json({
            ...existing,
            balance: await balanceOf(id),
            alreadySaved: true,
            cta,
            surface,
          });
        }
      }
      return Response.json(
        {
          error: "analysis_in_progress",
          message:
            "That full analysis is already running for this listing. Wait a moment and retry — you will not be charged twice.",
          charge: false,
          cta,
          surface,
        },
        { status: 409 },
      );
    }
    if (claim.kind === "conflict") {
      return Response.json(
        {
          error: "analysis_conflict",
          reason: claim.reason,
          message:
            "That find analysis request could not be claimed safely. Run Find again and choose the same car. No credit was charged.",
          charge: false,
          cta,
          surface,
        },
        { status: 409 },
      );
    }
    if (claim.kind !== "proceed") {
      return Response.json(
        {
          error: "analysis_conflict",
          reason: "unexpected_claim_state",
          message:
            "That find analysis request could not be claimed safely. Run Find again and choose the same car. No credit was charged.",
          charge: false,
          cta,
          surface,
        },
        { status: 409 },
      );
    }
    // Exclusive assemble/commit for this token — fence required for release/complete.
    heldClaimId = claim.claimId;
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
      // Trusted find context carries seller-feed ask/miles — do not label them "typed in".
      factSource: trustedFind ? "find_feed" : "typed",
      repairAbility,
      targetProfitUsd,
      budgetUsd: budgetUsd ?? null,
      budgetKnown,
    },
    { ...runtimeDeps(), servSurface: surface === "check" ? "check" : "report" },
  );
  if (!assembled.ok) {
    if (analysisIdentity && heldClaimId) await releaseFindAnalysis(getKv(), analysisIdentity, heldClaimId);
    if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(getKv(), id, freeCheckKey);
    await sendLinkedTelegram(id, REPORT_FAILED_TEXT);
    return Response.json({ error: assembled.error, message: assembled.message }, { status: assembled.status });
  }

  // Incident-class unusable ask / missing critical input → clear refusal, 0 debit.
  const chargeDecision = decideReportCharge(assembled.report.computed);
  if (!chargeDecision.charge) {
    if (analysisIdentity && heldClaimId) await releaseFindAnalysis(getKv(), analysisIdentity, heldClaimId);
    if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(getKv(), id, freeCheckKey);
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

  // Find path: analysis-scoped spend key (not report UUID). Manual path keeps UUID key.
  // Free monthly check path: no credit debit — commit only after durable persist.
  const spendKey = analysisIdentity
    ? findAnalysisSpendKey(analysisIdentity)
    : legacyReportUuidSpendKey(assembled.report.id);
  let spentBalance = await balanceOf(id);
  if (!usedFreeCheck) {
    const spent = await spendCredit(id, spendKey);
    if (!spent.ok) {
      if (analysisIdentity && heldClaimId) await releaseFindAnalysis(getKv(), analysisIdentity, heldClaimId);
      return Response.json(
        { error: "credits_required", balance: spent.balance, message: "A full report costs 1 credit." },
        { status: 403 },
      );
    }
    spentBalance = spent.balance;
  }
  try {
    await persistReport(assembled.report);
    if (vinKey) await rememberUserReport(getKv(), id, vinKey, assembled.report.id, assembled.report);
    if (analysisIdentity && heldClaimId) {
      const completed = await completeFindAnalysis(
        getKv(),
        analysisIdentity,
        assembled.report.id,
        heldClaimId,
      );
      if (!completed.ok) throw new Error(`complete_failed:${completed.reason}`);
    }
    if (usedFreeCheck && freeCheckKey) {
      const committed = await commitFreeCheck(getKv(), id, freeCheckKey);
      if (!committed.ok) throw new Error("free_check_commit_failed");
    }
  } catch {
    // Durable report already saved → finish receipt / return it. Do NOT compensate
    // (would open FREE_REPORT) and do NOT drop a successful paid artifact.
    const saved = await readPersistedReport(assembled.report.id);
    if (saved) {
      if (analysisIdentity && heldClaimId) {
        await completeFindAnalysis(getKv(), analysisIdentity, saved.id, heldClaimId);
      }
      if (usedFreeCheck && freeCheckKey) await commitFreeCheck(getKv(), id, freeCheckKey);
      const carSaved = saved.computed.subject;
      const readySaved = reportReadyMessage({
        car: `${carSaved.year} ${carSaved.make} ${carSaved.model}`,
        recommendation: fitHeadline(saved.computed),
        origin: originOf(request),
        reportId: saved.id,
      });
      await sendLinkedTelegram(id, readySaved.text, readySaved.reply_markup.inline_keyboard[0]?.[0]);
      return Response.json({
        ...saved,
        balance: spentBalance,
        charged: !usedFreeCheck,
        freeCheck: usedFreeCheck,
      });
    }
    // Persist never landed — compensate spend (clears spend event) + fenced release.
    if (!usedFreeCheck) await compensateSpendCredit(id, spendKey);
    if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(getKv(), id, freeCheckKey);
    if (analysisIdentity && heldClaimId) await releaseFindAnalysis(getKv(), analysisIdentity, heldClaimId);
    await sendLinkedTelegram(id, REPORT_FAILED_TEXT);
    return Response.json(
      {
        error: "save_failed",
        message: usedFreeCheck
          ? "The report did not finish. No free check was used."
          : "The report did not finish. No credit was used.",
      },
      { status: 500 },
    );
  }
  const car = assembled.report.computed.subject;
  const ready = reportReadyMessage({
    car: `${car.year} ${car.make} ${car.model}`,
    recommendation: fitHeadline(assembled.report.computed),
    origin: originOf(request),
    reportId: assembled.report.id,
  });
  await sendLinkedTelegram(id, ready.text, ready.reply_markup.inline_keyboard[0]?.[0]);
  return Response.json({
    ...assembled.report,
    balance: spentBalance,
    charged: !usedFreeCheck,
    freeCheck: usedFreeCheck,
  });
}
