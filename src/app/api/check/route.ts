import { checkCreditsNeedMessage, freeCheckMonthKey } from "@/domain/free-check-quota";
import { isValidVin } from "@/domain/vin";
import { commitFreeCheck, freeCheckSlotsRemaining, releaseFreeCheck, reserveFreeCheck } from "@/io/free-check-quota";
import { getKv } from "@/io/kv";
import { runCheck, type CheckRunInput } from "@/server/check/run-check";
import { runtimeDeps } from "@/server/deps";
import { balanceOf, requireVerifiedAccountForChecks, spendCredit } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Check a car by listing link, pasted listing text, or VIN.
 * Requires verified Auth.js account.
 *
 * Settlement rule: free-check slots and report credits are reserved/spent only
 * after a successful delivered result. Failed, blocked, and redirected checks
 * never consume. Capability is gated up front so exhausted accounts are not
 * kept waiting on a listing fetch.
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

  let freeCheckKey: string | null = null;
  let usedFreeCheck = false;
  let needsCredit = false;
  let spentCredit = false;

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
        },
        { status: result.status },
      );
    }

    // Deliverable exists — now reserve free slot or spend a credit.
    const vinKey =
      result.result.vin && isValidVin(result.result.vin)
        ? result.result.vin
        : `novin:${Buffer.from(
            input.kind === "link" ? input.url : input.kind === "vin" ? input.vin : "paste",
          )
            .toString("base64url")
            .slice(0, 24)}`;
    freeCheckKey = `free-check:check:${access.id}:${month}:${vinKey}`;
    const reserved = await reserveFreeCheck(kv, access.id, freeCheckKey);
    if (reserved.ok) {
      usedFreeCheck = true;
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
        },
        { status: 403 },
      );
    } else {
      needsCredit = true;
    }

    if (needsCredit) {
      const spendKey = `check:${access.id}:${month}:${result.result.vin ?? "novin"}:${result.result.title}`;
      const spent = await spendCredit(access.id, spendKey);
      if (!spent.ok) {
        if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(kv, access.id, freeCheckKey);
        return Response.json(
          { error: "credits_required", message: checkCreditsNeedMessage() },
          { status: 403 },
        );
      }
      spentCredit = true;
    }

    let freeChecks = (await freeCheckSlotsRemaining(kv, access.id)).view;
    if (usedFreeCheck && freeCheckKey) {
      const committed = await commitFreeCheck(kv, access.id, freeCheckKey);
      freeChecks = committed.view;
    }

    return Response.json({ ok: true, ...result.result, usedFreeCheck, spentCredit, freeChecks });
  } catch (error) {
    if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(kv, access.id, freeCheckKey);
    const message = error instanceof Error ? error.message : "Check failed.";
    return Response.json({ error: "check_failed", message }, { status: 500 });
  }
}
