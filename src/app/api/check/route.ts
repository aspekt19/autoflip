import { checkCreditsNeedMessage, freeCheckMonthKey } from "@/domain/free-check-quota";
import { isValidVin } from "@/domain/vin";
import { creditEventSeen } from "@/io/credit-book";
import { commitFreeCheck, freeCheckSlotsRemaining, releaseFreeCheck, reserveFreeCheck } from "@/io/free-check-quota";
import { getKv } from "@/io/kv";
import {
  CHECK_DELIVERY_LOGIC_VERSION,
  checkDeliveryKey,
  isDegradedCheckDeliveryResult,
  legacyCheckDeliveryKey,
  readCheckDelivery,
  storeCheckDelivery,
} from "@/server/check/check-delivery";
import { checkResultIsCacheable, runCheck, type CheckRunInput } from "@/server/check/run-check";
import { runtimeDeps } from "@/server/deps";
import { balanceOf, requireVerifiedAccountForChecks, spendCredit } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function vinKeyForInput(input: CheckRunInput, resultVin: string | null): string {
  if (resultVin && isValidVin(resultVin)) return resultVin;
  if (input.kind === "vin" && isValidVin(input.vin)) return input.vin;
  const seed = input.kind === "link" ? input.url : input.kind === "vin" ? input.vin : "paste";
  return `novin:${Buffer.from(seed).toString("base64url").slice(0, 24)}`;
}

/**
 * Check a car by listing link, pasted listing text, or VIN.
 * Requires verified Auth.js account.
 *
 * Settlement rule: free-check slots and report credits are reserved/spent only
 * after a successful delivered result. Failed, blocked, and redirected checks
 * never consume. Capability is gated up front so exhausted accounts are not
 * kept waiting on a listing fetch.
 *
 * Billing honesty: a second delivery of the same vehicle in the same month
 * returns the saved result without claiming a new free-check or credit spend.
 */
export async function POST(request: Request) {
  const access = await requireVerifiedAccountForChecks();
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });

  const kindRaw = typeof body.kind === "string" ? body.kind : null;
  const optionalZip =
    typeof body.optionalZip === "string"
      ? body.optionalZip
      : typeof body.zip === "string"
        ? body.zip
        : null;

  let input: CheckRunInput | null = null;
  if (kindRaw === "link" || (!kindRaw && typeof body.url === "string")) {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) {
      return Response.json({ error: "missing_url", message: "Paste a listing link." }, { status: 400 });
    }
    input = { kind: "link", url, optionalZip };
  } else if (kindRaw === "paste") {
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return Response.json({ error: "missing_text", message: "Paste the listing text." }, { status: 400 });
    }
    input = {
      kind: "paste",
      text,
      url: typeof body.url === "string" ? body.url : null,
      optionalZip,
    };
  } else if (kindRaw === "vin" || (!kindRaw && typeof body.vin === "string")) {
    const vin = typeof body.vin === "string" ? body.vin.trim().toUpperCase() : "";
    if (!isValidVin(vin)) {
      return Response.json({ error: "invalid_vin", message: "Enter a valid 17-character VIN." }, { status: 400 });
    }
    input = { kind: "vin", vin, optionalZip };
  } else {
    return Response.json(
      { error: "invalid_kind", message: "Send kind: link, paste, or vin." },
      { status: 400 },
    );
  }

  const deps = runtimeDeps();
  const month = freeCheckMonthKey();
  const kv = getKv();

  // Gate before any fetch / decode work — exhausted accounts redirect immediately.
  const slots = await freeCheckSlotsRemaining(kv, access.id);
  const balance = await balanceOf(access.id);
  if (slots.remaining < 1 && balance < 1) {
    return Response.json(
      {
        error: "credits_required",
        message: checkCreditsNeedMessage(),
        freeChecks: slots.view,
        credits: balance,
      },
      { status: 403 },
    );
  }

  const forceFresh = body.forceFresh === true || body.fresh === true;

  // VIN checks can short-circuit on a prior delivery before running SERV again.
  // Logic-versioned key: pre-fix and degraded caches are never served as current.
  if (input.kind === "vin" && !forceFresh) {
    const priorKey = checkDeliveryKey(access.id, month, input.vin);
    const prior = await readCheckDelivery(kv, priorKey);
    if (prior && !isDegradedCheckDeliveryResult(prior.result)) {
      const creditsNow = await balanceOf(access.id);
      return Response.json({
        ok: true,
        ...prior.result,
        usedFreeCheck: false,
        spentCredit: false,
        fromCache: true,
        staleLogic: false,
        logicVersion: prior.logicVersion ?? CHECK_DELIVERY_LOGIC_VERSION,
        settledAt: prior.settledAt,
        billingNote: prior.spentCredit
          ? "Returning saved check; no additional credit spent."
          : prior.usedFreeCheck
            ? "Returning saved check; free check already used for this vehicle this month."
            : "Returning saved check; no charge.",
        freeChecks: slots.view,
        credits: creditsNow,
        balance: creditsNow,
      });
    }
    // Legacy / degraded row — do not replay as the current verdict.
    const legacy = await readCheckDelivery(kv, legacyCheckDeliveryKey(access.id, month, input.vin));
    if (legacy || (prior && isDegradedCheckDeliveryResult(prior.result))) {
      const when = (legacy ?? prior)!.settledAt.slice(0, 10);
      return Response.json(
        {
          ok: false,
          error: "stale_check_cache",
          message: `A saved check from ${when} predates current Check logic (v${CHECK_DELIVERY_LOGIC_VERSION}) or is incomplete. Run a fresh check to apply today’s stop flags and confidence rules.`,
          fromCache: true,
          staleLogic: true,
          offerFreshCheck: true,
          logicVersion: (legacy ?? prior)?.logicVersion ?? 1,
          settledAt: (legacy ?? prior)!.settledAt,
          freeChecks: slots.view,
          credits: await balanceOf(access.id),
        },
        { status: 409 },
      );
    }
  }

  let freeCheckKey: string | null = null;
  let usedFreeCheck = false;
  let needsCredit = false;
  let spentCredit = false;
  let billingNote = "";

  try {
    const result = await runCheck(input, {
      servKey: deps.servKey,
      servModel: deps.servModel,
      servBaseUrl: deps.servBaseUrl,
      autodevKey: deps.autodevKey,
      autodev: deps.autodev,
    });

    // Failed / blocked / thin — never settle quota or credits.
    if (!result.ok) {
      return Response.json(
        {
          error: result.error,
          message: result.message,
          blocked: result.blocked === true,
          alternatives: result.alternatives,
          freeChecks: slots.view,
          creditCharged: false,
          spentCredit: false,
          usedFreeCheck: false,
          focusVin: result.focusVin === true,
          urlHints: result.urlHints ?? null,
        },
        { status: result.status },
      );
    }

    const vinKey = vinKeyForInput(input, result.result.vin);
    const deliveryKey = checkDeliveryKey(access.id, month, vinKey);
    if (!forceFresh) {
      const prior = await readCheckDelivery(kv, deliveryKey);
      if (prior && !isDegradedCheckDeliveryResult(prior.result)) {
        const creditsNow = await balanceOf(access.id);
        return Response.json({
          ok: true,
          ...prior.result,
          usedFreeCheck: false,
          spentCredit: false,
          fromCache: true,
          staleLogic: false,
          settledAt: prior.settledAt,
          billingNote: prior.spentCredit
            ? "Returning saved check; no additional credit spent."
            : prior.usedFreeCheck
              ? "Returning saved check; free check already used for this vehicle this month."
              : "Returning saved check; no charge.",
          freeChecks: slots.view,
          credits: creditsNow,
          balance: creditsNow,
        });
      }
    }

    // Deliverable exists — now reserve free slot or spend a credit.
    freeCheckKey = `free-check:check:${access.id}:${month}:${vinKey}`;
    // Order: free monthly check first, then report credit.
    // reserveFreeCheck is preferred whenever a free slot remains; credit only when
    // the monthly free allotment is exhausted (or this VIN already used its free check).
    const reserved = await reserveFreeCheck(kv, access.id, freeCheckKey);
    if (reserved.ok) {
      usedFreeCheck = true;
      billingNote = "Free vehicle check used (no report credit).";
    } else if (reserved.reason === "lock_busy") {
      return Response.json(
        {
          error: "quota_busy",
          message: "Could not reserve a free vehicle check right now. Retry in a moment.",
          freeChecks: reserved.view,
        },
        { status: 503 },
      );
    } else if ((await balanceOf(access.id)) < 1) {
      // Result was computed but cannot be settled — do not commit free or spend.
      return Response.json(
        {
          error: "credits_required",
          message: checkCreditsNeedMessage(),
          freeChecks: reserved.view,
          reservedReason: reserved.reason,
        },
        { status: 403 },
      );
    } else {
      // exhausted or already_completed for this VIN — credit path
      needsCredit = true;
    }

    if (needsCredit) {
      const spendKey = `check:${access.id}:${month}:${result.result.vin ?? "novin"}:${result.result.title}`;
      const alreadyPaid = await creditEventSeen(kv, spendKey);
      if (alreadyPaid) {
        spentCredit = false;
        billingNote = "Report already charged for this check; no additional credit spent.";
      } else {
        const spent = await spendCredit(access.id, spendKey);
        if (!spent.ok) {
          if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(kv, access.id, freeCheckKey);
          return Response.json(
            { error: "credits_required", message: checkCreditsNeedMessage() },
            { status: 403 },
          );
        }
        spentCredit = true;
        billingNote = "1 report credit spent.";
      }
    }

    let freeChecks = (await freeCheckSlotsRemaining(kv, access.id)).view;
    if (usedFreeCheck && freeCheckKey) {
      const committed = await commitFreeCheck(kv, access.id, freeCheckKey);
      freeChecks = committed.view;
    }

    const cacheable = checkResultIsCacheable(result.result);
    const payload = { ...result.result } as Record<string, unknown>;
    if (cacheable) {
      await storeCheckDelivery(kv, deliveryKey, {
        settledAt: new Date().toISOString(),
        result: payload,
        usedFreeCheck,
        spentCredit,
        logicVersion: CHECK_DELIVERY_LOGIC_VERSION,
      });
    }

    const creditsAfter = await balanceOf(access.id);
    return Response.json({
      ok: true,
      ...result.result,
      usedFreeCheck,
      spentCredit,
      billingNote,
      freeChecks,
      credits: creditsAfter,
      balance: creditsAfter,
      // Degraded SERV/recall runs are not month-cached — offer a fresh check.
      ...(cacheable
        ? {}
        : {
            staleLogic: true,
            offerFreshCheck: true,
            billingNote:
              `${billingNote} This result was not saved for the month because SERV or recall evidence was incomplete — run a fresh check when ready.`.trim(),
          }),
    });
  } catch (error) {
    if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(kv, access.id, freeCheckKey);
    const message = error instanceof Error ? error.message : "Check failed.";
    return Response.json({ error: "check_failed", message }, { status: 500 });
  }
}
