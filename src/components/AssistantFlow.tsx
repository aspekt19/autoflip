"use client";

import { parseCountInput, parseUsdInput } from "@/domain/budget";
import type { PriceBadge } from "@/domain/price-badge";
import { whyThisCar } from "@/domain/why-car";
import { PriceBadgeView, PriceRatingHow } from "./PriceBadge";
import { budgetFromText } from "@/domain/need";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { DecisionProof } from "@/domain/decision-note";
import type { SearchDirection } from "@/domain/directions";
import { CoverageLine } from "./CoverageNote";
import { DecisionNote } from "./DecisionNote";
import { findEmptyCopy, type FindEmptyReason } from "@/domain/find-empty";
import { SEARCH_RADII_MILES, USE_CASES, searchScopeLabel, type FollowUp, type StructuredNeed } from "@/domain/need";
import type { Mode } from "@/domain/types";
import { MakeModelFields } from "./MakeModelFields";

type ListingCard = {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  priceUsd: number | null;
  miles: number | null;
  city: string | null;
  state: string | null;
  vdp: string | null;
  primaryImage: string | null;
  source: string;
  bodyStyle?: string | null;
  style?: string | null;
  overBudget?: boolean;
  badge?: PriceBadge;
  flipNote?: string | null;
  clearsTarget?: boolean | null;
};

type MatchGroup = {
  direction: SearchDirection;
  searchedModels?: Array<{ make: string; model: string }>;
  listings: ListingCard[];
  note: string | null;
  coverage?: string;
  coverageLevel?: "low" | "medium" | "high";
  providerWarning?: string | null;
};

const USE_LABEL: Record<(typeof USE_CASES)[number], string> = {
  family: "Family",
  commute: "Commute",
  haul: "Haul or tow",
  first_car: "First car",
  comfort: "Comfort",
  unspecified: "Not sure yet",
};

const FIND_STEPS = ["Need", "Budget", "Confirm", "Results"] as const;

export function FindFlow({ initialNote, initialMode }: { initialNote?: string; initialMode?: "personal" | "flip" }) {
  return <AssistantFlow variant="find" initialNote={initialNote} initialMode={initialMode} />;
}

export function CheckFlow() {
  return <AssistantFlow variant="check" />;
}

function AssistantFlow({
  variant,
  initialNote,
  initialMode,
}: {
  variant: "find" | "check";
  initialNote?: string;
  initialMode?: "personal" | "flip";
}) {
  const router = useRouter();
  const path = variant === "find" ? "choose" : "check";
  const [mode, setMode] = useState<Mode>("personal");
  const [text, setText] = useState("");
  const [budget, setBudget] = useState("");
  const [budgetKnown, setBudgetKnown] = useState(true);
  const [need, setNeed] = useState<StructuredNeed | null>(null);
  const [source, setSource] = useState<"model" | "form" | null>(null);
  const [checks, setChecks] = useState<DecisionProof[]>([]);
  const [questions, setQuestions] = useState<FollowUp[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<"need" | "budget" | "follow" | "confirm" | "results">("need");
  const [zipDraft, setZipDraft] = useState("");
  const [groups, setGroups] = useState<MatchGroup[]>([]);
  const [sample, setSample] = useState(false);
  const [affordability, setAffordability] = useState(true);
  const [matchMessage, setMatchMessage] = useState<string | null>(null);
  const [matchHeadline, setMatchHeadline] = useState<string | null>(null);
  const [matchNextStep, setMatchNextStep] = useState<string | null>(null);
  const [matchScope, setMatchScope] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<FindEmptyReason | null>(null);
  const [partialFailure, setPartialFailure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [refine, setRefine] = useState(false);
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [yearMin, setYearMin] = useState("");
  const [yearMax, setYearMax] = useState("");
  const [checkKind, setCheckKind] = useState<"link" | "vin">("link");
  const [lookup, setLookup] = useState("");
  const [vinPrice, setVinPrice] = useState("");
  const [vinMiles, setVinMiles] = useState("");
  const [vinZip, setVinZip] = useState("");
  const booted = useRef(false);
  const [freeCheck, setFreeCheck] = useState<{
    title: string;
    sample?: boolean;
    badge: PriceBadge;
    reasons: string[];
    coverage: string;
    coverageLevel: "low" | "medium" | "high";
  } | null>(null);

  async function understand(followUp?: { id: FollowUp["id"]; value: string }) {
    setError(null);
    setPending("need");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const amount = parseUsdInput(budget) ?? Number.NaN;
      const response = await fetch("/api/need", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          mode,
          budgetUsd: budgetKnown && Number.isFinite(amount) ? amount : null,
          budgetKnown,
          zip: zipDraft.trim() || need?.zip || null,
          repairAbility: need?.repairAbility,
          useCase: need?.useCase,
          targetProfitUsd: need?.targetProfitUsd,
          followUp,
        }),
      });
      const body = (await response.json()) as {
        source?: "model" | "form";
        need?: StructuredNeed;
        followUps?: FollowUp[];
        checks?: DecisionProof[];
        message?: string;
      };
      if (!response.ok || !body.need) {
        setError(body.message || "That note could not be read.");
        return;
      }
      setNeed(body.need);
      setSource(body.source ?? "form");
      setChecks(body.checks ?? []);
      const next = body.followUps ?? [];
      if (!followUp && next.length > 0) {
        setQuestions(next);
        setStage("follow");
        return;
      }
      setQuestions([]);
      setStage("confirm");
    } catch {
      setError("The request did not finish.");
    } finally {
      window.clearTimeout(timer);
      setPending(null);
    }
  }

  useEffect(() => {
    if (booted.current || variant !== "find" || !initialNote?.trim()) return;
    booted.current = true;
    setText(initialNote);
    setMode(initialMode === "flip" ? "flip" : "personal");
    const amount = budgetFromText(initialNote);
    if (amount) setBudget(String(amount));
    setStage("budget");
  }, [initialMode, initialNote, variant]);

  useEffect(() => {
    if (variant !== "find" || initialNote?.trim()) return;
    try {
      const raw = sessionStorage.getItem("af-flow");
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        need?: StructuredNeed;
        stage?: "need" | "budget" | "follow" | "confirm" | "results";
        groups?: MatchGroup[];
        source?: "model" | "form";
        checks?: DecisionProof[];
        affordability?: boolean;
        sample?: boolean;
        matchMessage?: string | null;
        matchScope?: string | null;
        emptyReason?: FindEmptyReason | null;
        matchHeadline?: string | null;
        matchNextStep?: string | null;
        partialFailure?: boolean;
      };
      if (!saved.need || !saved.stage || saved.stage === "need") return;
      setNeed(saved.need);
      setStage(saved.stage);
      setGroups(saved.groups ?? []);
      setSource(saved.source ?? "form");
      setChecks(saved.checks ?? []);
      setAffordability(saved.affordability ?? true);
      setSample(false);
      setMatchMessage(saved.matchMessage ?? null);
      setMatchHeadline(saved.matchHeadline ?? null);
      setMatchNextStep(saved.matchNextStep ?? null);
      setMatchScope(saved.matchScope ?? null);
      setEmptyReason(saved.emptyReason ?? null);
      setPartialFailure(Boolean(saved.partialFailure));
      if (saved.need.budgetUsd) setBudget(String(saved.need.budgetUsd));
      if (saved.need.zip) setZipDraft(saved.need.zip);
    } catch {
      /* ignore a bad saved draft */
    }
  }, [initialNote, variant]);

  useEffect(() => {
    if (stage !== "results") return;
    document.getElementById("find-results")?.scrollIntoView({ block: "start" });
  }, [stage]);

  function rememberFlow() {
    try {
      sessionStorage.setItem(
        "af-flow",
        JSON.stringify({ need, stage, groups, source, checks, affordability, sample, matchMessage, matchScope, emptyReason }),
      );
    } catch {
      /* the browser may block storage */
    }
  }

  async function answerFollowUps() {
    if (!need) return;
    let current = need;
    for (const question of questions) {
      const value = answers[question.id]?.trim();
      if (!value) {
        setError("Answer the question, or go back and add it to your note.");
        return;
      }
      const response = await fetch("/api/need", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...current, text, followUp: { id: question.id, value } }),
      });
      const body = (await response.json()) as { need?: StructuredNeed; followUps?: FollowUp[]; message?: string };
      if (!response.ok || !body.need) {
        setError(body.message || "That answer could not be saved.");
        return;
      }
      current = body.need;
    }
    setNeed(current);
    setQuestions([]);
    setStage("confirm");
  }

  async function findCars() {
    if (!need) return;
    setError(null);
    setMatchMessage(null);
    setMatchHeadline(null);
    setMatchNextStep(null);
    setEmptyReason(null);
    setPartialFailure(false);
    setPending("match");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch("/api/match", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          need,
          refine: {
            make: make.trim() || undefined,
            model: model.trim() || undefined,
            yearMin: yearMin ? Number(yearMin) : undefined,
            yearMax: yearMax ? Number(yearMax) : undefined,
          },
        }),
      });
      const body = (await response.json()) as {
        directions?: MatchGroup[];
        sample?: boolean;
        message?: string;
        headline?: string;
        nextStep?: string;
        scope?: string;
        emptyReason?: FindEmptyReason | null;
        partialFailure?: boolean;
        affordabilityAssessed?: boolean;
      };
      if (!response.ok) {
        const reason = body.emptyReason ?? "provider_failure";
        const copy = findEmptyCopy(reason, need, body.message);
        setError(copy.detail);
        setMatchHeadline(body.headline ?? copy.headline);
        setMatchNextStep(body.nextStep ?? copy.nextStep);
        setMatchMessage(copy.detail);
        setEmptyReason(reason);
        setStage("results");
        setGroups([]);
        setSample(false);
        return;
      }
      // Consumer /find never accepts sample rows as live inventory.
      const nextGroups = (body.directions ?? []).map((group) => ({
        ...group,
        listings: (group.listings ?? []).filter((car) => car.source !== "sample"),
      }));
      if (body.sample) {
        const copy = findEmptyCopy("listings_unconfigured", need, "Sample fixtures were rejected for this consumer search.");
        setGroups([]);
        setSample(false);
        setEmptyReason(copy.reason);
        setMatchHeadline(copy.headline);
        setMatchMessage(copy.detail);
        setMatchNextStep(copy.nextStep);
        setStage("results");
        return;
      }
      setGroups(nextGroups);
      setSample(false);
      setAffordability(body.affordabilityAssessed !== false);
      setMatchMessage(body.message ?? null);
      setMatchHeadline(body.headline ?? null);
      setMatchNextStep(body.nextStep ?? null);
      setMatchScope(body.scope ?? searchScopeLabel(need));
      setPartialFailure(Boolean(body.partialFailure));
      setEmptyReason(body.emptyReason ?? (nextGroups.length === 0 ? "no_directions" : null));
      setStage("results");
      try {
        sessionStorage.setItem(
          "af-flow",
          JSON.stringify({
            need,
            stage: "results",
            groups: nextGroups,
            source,
            checks,
            affordability: body.affordabilityAssessed !== false,
            sample: false,
            matchMessage: body.message ?? null,
            matchHeadline: body.headline ?? null,
            matchNextStep: body.nextStep ?? null,
            matchScope: body.scope ?? searchScopeLabel(need),
            emptyReason: body.emptyReason ?? null,
            partialFailure: Boolean(body.partialFailure),
          }),
        );
      } catch {
        /* ignore */
      }
    } catch (err) {
      const reason: FindEmptyReason = err instanceof DOMException && err.name === "AbortError" ? "provider_timeout" : "provider_failure";
      const copy = findEmptyCopy(reason, need);
      setError(copy.detail);
      setMatchHeadline(copy.headline);
      setMatchMessage(copy.detail);
      setMatchNextStep(copy.nextStep);
      setEmptyReason(reason);
      setGroups([]);
      setStage("results");
    } finally {
      window.clearTimeout(timer);
      setPending(null);
    }
  }

  async function watch(direction: SearchDirection) {
    if (!need?.zip) {
      setError("Add a ZIP on the confirmation step before saving a watch.");
      return;
    }
    setPending(direction.id);
    try {
      const priceMax = need.budgetKnown && need.budgetUsd ? need.budgetUsd : 40_000;
      const response = await fetch("/api/radar/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: direction.segment,
          mode: need.mode,
          criteria:
            need.mode === "flip"
              ? {
                  priceMax,
                  zip: need.zip,
                  radiusMiles: 50,
                  repairAbility: need.repairAbility,
                  minProfitUsd: need.targetProfitUsd ?? undefined,
                }
              : {
                  models: direction.models.slice(0, 6),
                  yearMin: direction.yearMin,
                  yearMax: direction.yearMax,
                  priceMax,
                  zip: need.zip,
                  radiusMiles: need.distanceMiles ?? 100,
                },
        }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) {
        setError(body.message || "The search was not saved.");
        return;
      }
      router.push("/radar");
    } catch {
      setError("The search was not saved.");
    } finally {
      setPending(null);
    }
  }

  async function analyze(car: ListingCard) {
    if (!need) return;
    setPending(car.vin);
    try {
      const listingLink = car.vdp && /^https?:\/\//i.test(car.vdp);
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          listingLink
            ? { mode: need.mode, url: car.vdp, zip: need.zip ?? undefined, surface: "check", repairAbility: need.repairAbility, targetProfitUsd: need.targetProfitUsd }
            : {
                mode: need.mode,
                surface: "check",
                vin: car.vin,
                askingPriceUsd: car.priceUsd ?? undefined,
                miles: car.miles ?? undefined,
                zip: need.zip ?? undefined,
                repairAbility: need.repairAbility,
                targetProfitUsd: need.targetProfitUsd,
              },
        ),
      });
      const body = (await response.json()) as { id?: string; message?: string; error?: string };
      if (response.status === 403 && body.error === "credits_required") {
        rememberFlow();
        router.push("/credits?need=1&return=%2Ffind");
        return;
      }
      if (!response.ok || !body.id) {
        setError(body.message || "The report could not be built.");
        return;
      }
      router.push(`/report/${body.id}`);
    } catch {
      setError("The report request did not finish.");
    } finally {
      setPending(null);
    }
  }

  function checkPayload() {
    const price = checkKind === "vin" ? parseUsdInput(vinPrice) : null;
    const miles = checkKind === "vin" ? parseCountInput(vinMiles) : null;
    return checkKind === "link"
      ? { mode, url: lookup.trim(), zip: vinZip.trim() || undefined }
      : { mode, vin: lookup.trim(), askingPriceUsd: price, miles, zip: vinZip.trim() };
  }

  async function previewCheck() {
    setError(null);
    if (!lookup.trim()) {
      setError(checkKind === "vin" ? "Enter a 17-character VIN." : "Paste a listing link.");
      return;
    }
    const price = checkKind === "vin" ? parseUsdInput(vinPrice) : null;
    const miles = checkKind === "vin" ? parseCountInput(vinMiles) : null;
    if (checkKind === "vin" && (price === null || miles === null || !vinZip.trim())) {
      setError(price === null ? "Enter the asking price, like $18,773." : miles === null ? "Enter the mileage, like 109,333." : "Enter a ZIP.");
      return;
    }
    setPending("preview");
    setFreeCheck(null);
    try {
      const response = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checkPayload()),
      });
      const body = (await response.json()) as { title?: string; badge?: PriceBadge; reasons?: string[]; coverage?: string; coverageLevel?: "low" | "medium" | "high"; sample?: boolean; message?: string };
      if (!response.ok || !body.badge || !body.title) {
        setError(body.message || "The price check did not finish.");
        return;
      }
      setFreeCheck({
        title: body.title,
        sample: body.sample,
        badge: body.badge,
        reasons: body.reasons ?? [],
        coverage: body.coverage ?? "",
        coverageLevel: body.coverageLevel ?? "low",
      });
    } catch {
      setError("The price check did not finish.");
    } finally {
      setPending(null);
    }
  }

  async function checkListing() {
    setError(null);
    if (!lookup.trim()) {
      setError(checkKind === "vin" ? "Enter a 17-character VIN." : "Paste a listing link.");
      return;
    }
    const price = checkKind === "vin" ? parseUsdInput(vinPrice) : null;
    const miles = checkKind === "vin" ? parseCountInput(vinMiles) : null;
    if (checkKind === "vin" && (price === null || miles === null || !vinZip.trim())) {
      setError(price === null ? "Enter the asking price, like $18,773." : miles === null ? "Enter the mileage, like 109,333." : "Enter a ZIP.");
      return;
    }
    setPending("report");
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          checkKind === "link"
            ? { mode, surface: "check", url: lookup.trim(), zip: vinZip.trim() || undefined }
            : {
                mode,
                surface: "check",
                vin: lookup.trim(),
                askingPriceUsd: price,
                miles,
                zip: vinZip.trim(),
              },
        ),
      });
      const body = (await response.json()) as { id?: string; message?: string; error?: string };
      if (response.status === 403 && body.error === "credits_required") {
        sessionStorage.setItem("af-check", JSON.stringify({ mode, checkKind, lookup, vinPrice, vinMiles, vinZip }));
        router.push("/credits?need=1&return=%2Fcheck");
        return;
      }
      if (!response.ok || !body.id) {
        setError(body.message || "The report could not be built.");
        return;
      }
      router.push(`/report/${body.id}`);
    } catch {
      setError("The report request did not finish.");
    } finally {
      setPending(null);
    }
  }

  const findStep = stage === "need" ? 0 : stage === "budget" || stage === "follow" ? 1 : stage === "confirm" ? 2 : 3;

  function goBack() {
    setError(null);
    if (variant === "check" || stage === "need") {
      router.push("/");
      return;
    }
    if (stage === "budget" || stage === "follow") setStage("need");
    else if (stage === "confirm") setStage("budget");
    else setStage("confirm");
  }

  return (
    <div className="panel">
      {variant === "find" ? (
        <ol className="progress" aria-label="Progress">
          {FIND_STEPS.map((label, index) => (
            <li key={label} className={index === findStep ? "is-current" : index < findStep ? "is-done" : undefined}>
              {label}
            </li>
          ))}
        </ol>
      ) : null}

      {path === "choose" && stage === "need" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setStage("budget");
          }}
        >
          <ModePills mode={mode} onMode={setMode} />
          <p className="hint">
            {mode === "flip"
              ? "For resale: say the kind of car, the capital you can put into the deal, and whether you can do repairs. Repair ability is not a risk level."
              : "For you: say what the car is for, what matters, and anything it must have."}
          </p>
          <div className="field">
            <label htmlFor="need">What do you need?</label>
            <textarea id="need" rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder="Need a reliable family car under $18,000, mostly city driving." />
          </div>
          <div className="btn-row">
            <button className="ghost" type="button" onClick={goBack}>
              Back
            </button>
            <button className="action" type="submit" disabled={text.trim().length < 8}>
              Continue
            </button>
          </div>
          {text.trim().length < 8 ? <p className="hint">Write a short note first, at least a few words.</p> : null}
        </form>
      ) : null}

      {path === "choose" && stage === "budget" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void understand();
          }}
        >
          <div className="field">
            <label htmlFor="budget">{mode === "flip" ? "Cash available for the purchase and repairs" : "Maximum vehicle price (before taxes and fees)"}</label>
            <input id="budget" value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" disabled={!budgetKnown} placeholder="e.g. 18000" />
            <label className="pill">
              <input type="checkbox" checked={!budgetKnown} onChange={(event) => setBudgetKnown(!event.target.checked)} /> Not sure yet
            </label>
          </div>
          <p className="hint">{mode === "flip" ? "This is the cash available for the deal. Repair estimates are assumptions, not a quote." : "We use this as the vehicle asking-price limit. Taxes, title, registration and dealer fees are not included."}</p>
          <div className="field">
            <label htmlFor="zip-draft">U.S. ZIP code near where you&apos;ll shop (optional)</label>
            <input id="zip-draft" value={zipDraft} onChange={(event) => setZipDraft(event.target.value)} inputMode="numeric" placeholder="Leave blank for nationwide" />
            <p className="hint">Blank ZIP searches nationwide across the U.S. Add a ZIP on confirm if you want a mileage radius.</p>
          </div>
          <div className="btn-row">
            <button className="ghost" type="button" onClick={goBack}>
              Back
            </button>
            <button className="action" type="submit" disabled={pending === "need"}>
              {pending === "need" ? "Reading…" : "Continue"}
            </button>
          </div>
        </form>
      ) : null}

      {path === "choose" && stage === "follow" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void answerFollowUps();
          }}
        >
          <p className="hint">{need?.mode === "flip" ? "These answers change the reconditioning assumption and the profit target. They are not a quote." : "A couple of questions. Nothing else."}</p>
          {questions.map((question) => (
            <div className="field" key={question.id}>
              <label htmlFor={question.id}>{question.prompt}</label>
              {question.id === "profit" ? (
                <div className="pills">
                  {[
                    ["1000", "$1,000"],
                    ["1500", "$1,500"],
                    ["2500", "$2,500+"],
                  ].map(([value, label]) => (
                    <label className="pill" key={value}>
                      <input type="radio" name="profit" checked={answers.profit === value} onChange={() => setAnswers({ ...answers, profit: value })} /> {label}
                    </label>
                  ))}
                </div>
              ) : null}
              {question.id === "use" ? (
                <select id={question.id} value={answers.use ?? ""} onChange={(event) => setAnswers({ ...answers, use: event.target.value })}>
                  <option value="">Choose</option>
                  {USE_CASES.filter((item) => item !== "unspecified").map((item) => (
                    <option key={item} value={item}>
                      {USE_LABEL[item]}
                    </option>
                  ))}
                </select>
              ) : null}
              {question.id === "repair" ? (
                <select id={question.id} value={answers.repair ?? ""} onChange={(event) => setAnswers({ ...answers, repair: event.target.value })}>
                  <option value="">Choose</option>
                  <option value="none">None</option>
                  <option value="minor">Basic</option>
                  <option value="major">Can do mechanical work</option>
                </select>
              ) : null}
              {question.id === "zip" || question.id === "cash" ? (
                <input id={question.id} value={answers[question.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} inputMode="decimal" placeholder={question.id === "cash" ? "for example 12000" : "ZIP"} />
              ) : null}
            </div>
          ))}
          <div className="btn-row">
            <button className="ghost" type="button" onClick={goBack}>
              Back
            </button>
            <button className="action" type="submit">
              Continue
            </button>
          </div>
        </form>
      ) : null}

      {path === "choose" && need && stage === "confirm" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void findCars();
          }}
        >
          <h3>Here&apos;s what I understood</h3>
          <p className="hint">
            {source === "model"
              ? "We read this from your note. Edit anything that is wrong. Directions below are guidance, not a market study."
              : "This is only what you typed and the words we could match. Nothing was invented."}
          </p>
          <div className="field">
            <label htmlFor="note">Your note</label>
            <textarea id="note" rows={3} value={need.note} onChange={(event) => setNeed({ ...need, note: event.target.value })} />
          </div>
          {need.mode === "flip" ? (
            <p className="hint">
              Profit target {need.targetProfitUsd === null ? "not set" : `$${need.targetProfitUsd.toLocaleString("en-US")}`}. Repair skill{" "}
              {need.repairAbility === "none" ? "none" : need.repairAbility === "minor" ? "basic" : need.repairAbility === "major" ? "mechanical work" : "not set"}.
            </p>
          ) : (
          <div className="field">
            <label htmlFor="use-edit">Use</label>
            <select id="use-edit" value={need.useCase} onChange={(event) => setNeed({ ...need, useCase: event.target.value as StructuredNeed["useCase"] })}>
              {USE_CASES.map((item) => (
                <option key={item} value={item}>
                  {USE_LABEL[item]}
                </option>
              ))}
            </select>
          </div>
          )}
          <div className="field">
            <label htmlFor="zip-edit">ZIP (optional)</label>
            <input
              id="zip-edit"
              value={need.zip ?? ""}
              onChange={(event) => {
                const nextZip = event.target.value.trim() || null;
                setNeed({
                  ...need,
                  zip: nextZip,
                  distanceMiles: nextZip ? need.distanceMiles ?? 100 : null,
                });
              }}
              placeholder="Leave blank for nationwide"
            />
          </div>
          {need.zip ? (
            <div className="field">
              <label htmlFor="radius-edit">Search radius</label>
              <select
                id="radius-edit"
                value={need.distanceMiles ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setNeed({
                    ...need,
                    distanceMiles: value === "" ? null : Number(value),
                  });
                }}
              >
                <option value="">Nationwide</option>
                {SEARCH_RADII_MILES.map((miles) => (
                  <option key={miles} value={miles}>
                    {miles} miles
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="hint">No ZIP — searching nationwide across the U.S.</p>
          )}
          <div className="field">
            <label htmlFor="miles-edit">Maximum mileage (optional)</label>
            <input
              id="miles-edit"
              value={need.milesMax ?? ""}
              inputMode="numeric"
              placeholder="No cap"
              onChange={(event) => {
                const amount = Number(event.target.value.replace(/,/g, ""));
                setNeed({ ...need, milesMax: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null });
              }}
            />
          </div>
          {need.preferredMakes?.length ? (
            <p className="hint">
              {need.openToOtherMakes
                ? `Preferred makes: ${need.preferredMakes.join(", ")}${
                    need.preferredModels?.length
                      ? ` (${need.preferredModels.map((item) => `${item.make} ${item.model}`).join(", ")})`
                      : ""
                  }. Other makes stay in the mix.`
                : `Makes: ${need.preferredMakes.join(", ")}. Other makes are left out.`}
            </p>
          ) : need.make ? (
            <p className="hint">Make: {need.make}. Other makes are left out.</p>
          ) : null}
          <div className="field">
            <label htmlFor="budget-edit">{need.mode === "flip" ? "Cash available for the purchase and repairs" : "Maximum vehicle price (before taxes and fees)"}</label>
            <input
              id="budget-edit"
              value={need.budgetUsd ?? ""}
              onChange={(event) => {
                const amount = Number(event.target.value);
                setNeed({
                  ...need,
                  budgetUsd: Number.isFinite(amount) && amount > 0 ? amount : null,
                  budgetKnown: Number.isFinite(amount) && amount > 0,
                });
              }}
            />
          </div>
          {need.mode === "personal" ? <p className="hint">This limit applies to the vehicle asking price only; taxes, title and dealer fees are not estimated.</p> : null}
          <button className="quiet" type="button" onClick={() => setRefine((open) => !open)}>
            {refine ? "Hide refine" : "Refine"}
          </button>
          {refine ? (
            <MakeModelFields
              make={make}
              model={model}
              yearMin={yearMin}
              yearMax={yearMax}
              onMake={(value) => {
                setMake(value);
                setModel("");
              }}
              onModel={setModel}
              onYearMin={setYearMin}
              onYearMax={setYearMax}
            />
          ) : null}
          <div className="btn-row">
            <button className="ghost" type="button" onClick={goBack}>
              Back
            </button>
            <button className="action" type="submit" disabled={pending === "match"}>
              {pending === "match" ? "Searching…" : "Find matching cars"}
            </button>
          </div>
        </form>
      ) : null}

      {stage === "results" ? (
        <div id="find-results">
          <h2>Cars that fit</h2>
          <PriceRatingHow />
          <DecisionNote scene="find" proofs={checks} />
          {need ? <p className="hint">Scope: {matchScope ?? searchScopeLabel(need)}</p> : null}
          {!affordability ? <p className="hint">Budget was not set, so affordability was not assessed.</p> : null}
          {partialFailure ? (
            <p className="warn-box" role="status">
              {matchMessage || "Some listing sources failed. Results below are partial and are not an exhaustive market scan."}
            </p>
          ) : null}
          {groups.length === 0 || (groups.length > 0 && groups.every((group) => group.listings.length === 0)) ? (
            <div className="warn-box" role="status">
              <p>
                <strong>{matchHeadline || findEmptyCopy(emptyReason ?? (groups.length === 0 ? "no_directions" : "empty_inventory"), need, matchMessage).headline}</strong>
              </p>
              <p>{matchMessage || error || findEmptyCopy(emptyReason ?? (groups.length === 0 ? "no_directions" : "empty_inventory"), need).detail}</p>
              <p className="hint">{matchNextStep || findEmptyCopy(emptyReason ?? (groups.length === 0 ? "no_directions" : "empty_inventory"), need).nextStep}</p>
            </div>
          ) : null}
          {groups.map((group) => (
            <section key={group.direction.id}>
              <h3>{group.direction.segment}</h3>
              <p>{group.direction.why}</p>
              <p className="hint">Editorial guidance for where to look — not verified inventory by itself.</p>
              {group.coverage && group.coverageLevel ? <CoverageLine confidence={group.coverageLevel} sentence={group.coverage} /> : null}
              {group.providerWarning ? <p className="warn-box">{group.providerWarning}</p> : null}
              <p className="hint">
                {group.searchedModels?.length
                  ? `Live models checked: ${group.searchedModels.map((item) => `${item.make} ${item.model}`).join(", ")}.`
                  : "No live model search completed for this group."}{" "}
                Years {group.direction.yearMin}–{group.direction.yearMax}. {group.direction.yearBecause}
              </p>
              <button className="quiet" type="button" onClick={() => void watch(group.direction)} disabled={pending === group.direction.id}>
                {pending === group.direction.id ? "Saving alert…" : need?.mode === "flip" ? "Get alerts for this budget" : "Get new-listing alerts"}
              </button>
              <p className="hint">The one-time search is free. Ongoing new-listing alerts require a separate monthly Radar plan.</p>
              {error && pending === null ? (
                <p className="warn" role="alert">
                  {error} {/plan|watch/i.test(error) ? <a href="/pricing">See radar plans</a> : null}
                </p>
              ) : null}
              {group.note ? <p className="hint">{group.note}</p> : null}
              <div className="listing-grid">
                {group.listings.map((car) => (
                  <article className="listing-card" key={car.vin}>
                    {car.primaryImage ? (
                      <img src={car.primaryImage} alt="" width={640} height={400} />
                    ) : (
                      <div className="photo-fallback" role="img" aria-label="No photo from the listing" />
                    )}
                    <div className="listing-body">
                    <h3 className="car-title">
                      {car.year} {car.make} {car.model} {car.trim ?? ""}
                    </h3>
                    <p className="listing-meta">
                      {car.priceUsd === null ? "Price not listed" : `$${car.priceUsd.toLocaleString("en-US")}`}
                      {" · "}
                      {car.miles === null ? "Mileage not listed" : `${car.miles.toLocaleString("en-US")} mi`}
                      {car.city ? ` · ${car.city}${car.state ? `, ${car.state}` : ""}` : ""}
                    </p>
                    {car.overBudget ? <p className="budget-flag">Slightly over budget</p> : null}
                    {car.source !== "autodev" ? <p className="hint">Source {car.source}: not treated as verified live inventory.</p> : null}
                    {car.badge ? <PriceBadgeView badge={car.badge} /> : null}
                    {car.flipNote ? <p className="hint">{car.flipNote}</p> : null}
                    {car.clearsTarget === false ? <p className="hint">Under the profit target, so it ranks lower.</p> : null}
                    {car.clearsTarget === true ? <p className="hint">Clears the profit target. That target is an assumption, not a promised sale.</p> : null}
                    {car.vdp ? (
                      <>
                        {" "}
                        · <a href={car.vdp}>Dealer listing</a>
                      </>
                    ) : null}
                    <p>
                      {whyThisCar({
                        year: car.year,
                        make: car.make,
                        model: car.model,
                        miles: car.miles,
                        milesMax: need?.milesMax ?? null,
                        priceUsd: car.priceUsd,
                        budgetUsd: need?.budgetUsd ?? null,
                        overBudget: car.overBudget,
                        bodyStyle: car.bodyStyle,
                        style: car.style,
                        requestedMake: need?.preferredMakes?.length ? need.preferredMakes.join("/") : need?.make ?? null,
                      })}
                    </p>
                    <div>
                      <button className="action" type="button" onClick={() => void analyze(car)} disabled={pending === car.vin}>
                        {pending === car.vin ? "Building…" : "Full analysis — 1 credit"}
                      </button>
                    </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {path === "check" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void previewCheck();
          }}
        >
          <ModePills mode={mode} onMode={setMode} />
          <div className="pills">
            <label className="pill">
              <input type="radio" name="check" checked={checkKind === "link"} onChange={() => setCheckKind("link")} /> By listing link
            </label>
            <label className="pill">
              <input type="radio" name="check" checked={checkKind === "vin"} onChange={() => setCheckKind("vin")} /> By VIN
            </label>
          </div>
          {checkKind === "link" ? <p className="hint">Paste a dealer listing link that contains the car&apos;s VIN. Lemonless looks up the VIN in its listings data; it does not read or scrape the listing page itself.</p> : null}
          <div className="field">
            <label htmlFor="lookup">{checkKind === "link" ? "Listing link" : "17-character VIN"}</label>
            <input id="lookup" value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder={checkKind === "link" ? "https://" : "17-character VIN"} />
          </div>
          {checkKind === "vin" ? (
            <>
              <p className="hint">A VIN identifies the car. It does not include the asking price, mileage, or where it is.</p>
              <div className="field">
                <label htmlFor="vin-price">Asking price</label>
                <input id="vin-price" value={vinPrice} onChange={(event) => setVinPrice(event.target.value)} inputMode="decimal" placeholder="e.g. 18,773" />
              </div>
              <div className="field">
                <label htmlFor="vin-miles">Mileage</label>
                <input id="vin-miles" value={vinMiles} onChange={(event) => setVinMiles(event.target.value)} inputMode="numeric" placeholder="e.g. 109,333" />
              </div>
            </>
          ) : null}
          <div className="field">
            <label htmlFor="vin-zip">{checkKind === "vin" ? "U.S. ZIP code where the car is located" : "U.S. ZIP code for distance (optional)"}</label>
            <input id="vin-zip" value={vinZip} onChange={(event) => setVinZip(event.target.value)} inputMode="numeric" placeholder="e.g. 33101" />
          </div>
          <div className="btn-row">
            <button className="ghost" type="button" onClick={goBack}>
              Back
            </button>
            <button className="action" type="submit" disabled={pending === "preview"}>
              {pending === "preview" ? "Checking the price…" : "Check the price"}
            </button>
          </div>
          <p className="hint">The quick price check is free. A full report costs 1 report credit and adds the broader vehicle assessment, recalls, complaints, available history flags and comparable listings.</p>
          {freeCheck ? (
            <article className="warn-box">
              <h2>{freeCheck.title}</h2>
              {freeCheck.sample ? <p className="hint">Sample. This is the labeled fixture, not a live listing.</p> : null}
              <PriceBadgeView badge={freeCheck.badge} />
              <ul className="refuse">
                {freeCheck.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <CoverageLine confidence={freeCheck.coverageLevel} sentence={freeCheck.coverage} />
              <PriceRatingHow />
              <p className="hint">This quick result rates the asking price only. The full report adds broader safety and vehicle context; it costs 1 report credit.</p>
              <button className="action" type="button" onClick={() => void checkListing()} disabled={pending === "report"}>
                {pending === "report" ? "Building report…" : "Full analysis — 1 credit"}
              </button>
            </article>
          ) : null}
        </form>
      ) : null}

      {variant === "find" && stage === "results" ? (
        <div className="btn-row">
          <button className="ghost" type="button" onClick={goBack}>
            Back
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ModePills({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  return (
    <fieldset className="field">
      <legend>Who is this for?</legend>
      <div className="pills" role="radiogroup" aria-label="Report mode">
        <label className="pill">
          <input type="radio" name="who" checked={mode === "personal"} onChange={() => onMode("personal")} /> For me
        </label>
        <label className="pill">
          <input type="radio" name="who" checked={mode === "flip"} onChange={() => onMode("flip")} /> For resale
        </label>
      </div>
    </fieldset>
  );
}
