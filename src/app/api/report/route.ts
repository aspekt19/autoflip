import { fitHeadline } from "@/domain/fit";
import { extractVin } from "@/domain/vin";
import { isVinOnlyLookup, vinDetailGaps } from "@/domain/vin-report";
import { findUserReport, persistReport, readPersistedReport, rememberUserReport, reportReusable } from "@/io/persist-report";
import { getKv } from "@/io/kv";
import { REPORT_FAILED_TEXT, reportReadyMessage } from "@/io/telegram";
import { assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode } from "@/server/mcp";
import { balanceOf, grantCredit, spendCredit, ledgerOwnerId } from "@/server/session";
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
  const askingPriceUsd = typeof body.askingPriceUsd === "number" ? body.askingPriceUsd : undefined;
  const miles = typeof body.miles === "number" ? body.miles : undefined;
  const repairAbility = body.repairAbility === "none" || body.repairAbility === "minor" || body.repairAbility === "major" || body.repairAbility === "unknown"
    ? body.repairAbility
    : undefined;
  const targetProfitUsd = typeof body.targetProfitUsd === "number" ? body.targetProfitUsd : undefined;
  const budgetUsd = typeof body.budgetUsd === "number" ? body.budgetUsd : undefined;
  const budgetKnown = body.budgetKnown === true || typeof budgetUsd === "number";
  const zip = typeof body.zip === "string" ? body.zip : undefined;
  if (isVinOnlyLookup({ url, vin })) {
    const missing = vinDetailGaps({ askingPriceUsd, miles, zip });
    if (missing.length > 0) {
      return Response.json(
        {
          error: "vin_needs_details",
          missing,
          message: `A VIN has no asking price of its own. Add ${missing.join(", ")} before the report.`,
        },
        { status: 400 },
      );
    }
  }

  const id = await ledgerOwnerId();
  const mode = parseMode(body.mode);
  const vinKey = extractVin(vin || url || "");
  if (vinKey) {
    const existingId = await findUserReport(getKv(), id, vinKey, mode);
    if (existingId) {
      const existing = await readPersistedReport(existingId);
      if (existing && reportReusable(existing, { mode, askingPriceUsd, miles })) {
        await rememberUserReport(getKv(), id, vinKey, existing.id, existing);
        return Response.json({ ...existing, balance: await balanceOf(id), alreadySaved: true });
      }
    }
  }
  if ((await balanceOf(id)) < 1) {
    return Response.json(
      {
        error: "credits_required",
        balance: 0,
        message: "A full report costs 1 credit.",
      },
      { status: 403 },
    );
  }

  const assembled = await assembleReport(
    {
      mode,
      vin,
      url,
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
    { ...runtimeDeps(), servSurface: body.surface === "check" ? "check" : "report" },
  );
  if (!assembled.ok) {
    await sendLinkedTelegram(id, REPORT_FAILED_TEXT);
    return Response.json({ error: assembled.error, message: assembled.message }, { status: assembled.status });
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
