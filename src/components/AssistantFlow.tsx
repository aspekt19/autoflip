"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SearchDirection } from "@/domain/directions";
import { USE_CASES, type FollowUp, type StructuredNeed } from "@/domain/need";
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
  source: string;
};

type MatchGroup = {
  direction: SearchDirection;
  listings: ListingCard[];
  note: string | null;
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

export function FindFlow() {
  return <AssistantFlow variant="find" />;
}

export function CheckFlow() {
  return <AssistantFlow variant="check" />;
}

function AssistantFlow({ variant }: { variant: "find" | "check" }) {
  const router = useRouter();
  const path = variant === "find" ? "choose" : "check";
  const [mode, setMode] = useState<Mode>("personal");
  const [text, setText] = useState("");
  const [budget, setBudget] = useState("");
  const [budgetKnown, setBudgetKnown] = useState(true);
  const [budgetScope, setBudgetScope] = useState<StructuredNeed["budgetScope"]>("unspecified");
  const [need, setNeed] = useState<StructuredNeed | null>(null);
  const [source, setSource] = useState<"model" | "form" | null>(null);
  const [questions, setQuestions] = useState<FollowUp[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<"need" | "budget" | "follow" | "confirm" | "results">("need");
  const [zipDraft, setZipDraft] = useState("");
  const [groups, setGroups] = useState<MatchGroup[]>([]);
  const [sample, setSample] = useState(false);
  const [affordability, setAffordability] = useState(true);
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

  async function understand(followUp?: { id: FollowUp["id"]; value: string }) {
    setError(null);
    setPending("need");
    try {
      const amount = Number(budget.replace(/[$,\s]/g, ""));
      const response = await fetch("/api/need", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          mode,
          budgetUsd: budgetKnown && Number.isFinite(amount) ? amount : null,
          budgetKnown,
          budgetScope,
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
        message?: string;
      };
      if (!response.ok || !body.need) {
        setError(body.message || "That note could not be read.");
        return;
      }
      setNeed(body.need);
      setSource(body.source ?? "form");
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
      setPending(null);
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
    setPending("match");
    try {
      const response = await fetch("/api/match", {
        method: "POST",
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
        affordabilityAssessed?: boolean;
      };
      if (!response.ok) {
        setError(body.message || "The search did not finish.");
        return;
      }
      setGroups(body.directions ?? []);
      setSample(Boolean(body.sample));
      setAffordability(body.affordabilityAssessed !== false);
      setStage("results");
    } catch {
      setError("The search did not finish.");
    } finally {
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
                }
              : {
                  models: direction.models.slice(0, 6),
                  yearMin: direction.yearMin,
                  yearMax: direction.yearMax,
                  priceMax,
                  zip: need.zip,
                  radiusMiles: 100,
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
            ? { mode: need.mode, url: car.vdp, zip: need.zip ?? undefined }
            : {
                mode: need.mode,
                vin: car.vin,
                askingPriceUsd: car.priceUsd ?? undefined,
                miles: car.miles ?? undefined,
                zip: need.zip ?? undefined,
              },
        ),
      });
      const body = (await response.json()) as { id?: string; message?: string; error?: string };
      if (response.status === 403 && body.error === "credits_required") {
        router.push("/credits?need=1");
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

  async function checkListing() {
    setError(null);
    setPending("report");
    const response = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        checkKind === "link"
          ? { mode, url: lookup.trim(), zip: vinZip.trim() || undefined }
          : {
              mode,
              vin: lookup.trim(),
              askingPriceUsd: Number(vinPrice),
              miles: Number(vinMiles),
              zip: vinZip.trim(),
            },
      ),
    });
    const body = (await response.json()) as { id?: string; message?: string; error?: string };
    if (response.status === 403 && body.error === "credits_required") {
      router.push("/credits?need=1");
      return;
    }
    if (!response.ok || !body.id) {
      setError(body.message || "The report could not be built.");
      setPending(null);
      return;
    }
    router.push(`/report/${body.id}`);
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
            <label htmlFor="budget">What&apos;s your budget?</label>
            <input id="budget" value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" disabled={!budgetKnown} placeholder="18000" />
            <label className="pill">
              <input type="checkbox" checked={!budgetKnown} onChange={(event) => setBudgetKnown(!event.target.checked)} /> Not sure yet
            </label>
          </div>
          <fieldset className="field">
            <legend>Is that the car only, or all-in?</legend>
            <div className="pills">
              <label className="pill">
                <input type="radio" name="scope" checked={budgetScope === "car"} onChange={() => setBudgetScope("car")} /> Car only
              </label>
              <label className="pill">
                <input type="radio" name="scope" checked={budgetScope === "all_in"} onChange={() => setBudgetScope("all_in")} /> All-in
              </label>
              <label className="pill">
                <input type="radio" name="scope" checked={budgetScope === "unspecified"} onChange={() => setBudgetScope("unspecified")} /> Not specified
              </label>
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="zip-draft">ZIP, if you know where you&apos;ll shop</label>
            <input id="zip-draft" value={zipDraft} onChange={(event) => setZipDraft(event.target.value)} inputMode="numeric" placeholder="33101" />
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
          <p className="hint">One or two questions. Nothing else.</p>
          {questions.map((question) => (
            <div className="field" key={question.id}>
              <label htmlFor={question.id}>{question.prompt}</label>
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
                  <option value="none">I won&apos;t do repairs</option>
                  <option value="minor">Minor repairs</option>
                  <option value="major">I can do major repairs</option>
                </select>
              ) : null}
              {question.id === "zip" || question.id === "profit" ? (
                <input id={question.id} value={answers[question.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />
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
              ? "A model extracted this from your note. Edit anything that is wrong. Directions below are AutoFlip guidance, not market data."
              : "No model reading was available, so this is only what you typed and the words we could match. Nothing was invented."}
          </p>
          <div className="field">
            <label htmlFor="note">Your note</label>
            <textarea id="note" rows={3} value={need.note} onChange={(event) => setNeed({ ...need, note: event.target.value })} />
          </div>
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
          <div className="field">
            <label htmlFor="zip-edit">ZIP</label>
            <input id="zip-edit" value={need.zip ?? ""} onChange={(event) => setNeed({ ...need, zip: event.target.value || null })} />
          </div>
          <div className="field">
            <label htmlFor="budget-edit">Budget</label>
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
        <div>
          {!affordability ? <p className="hint">Budget was not set, so affordability was not assessed.</p> : null}
          {sample ? <p className="warn-box">Sample. These rows are the labeled fixture, not live matches for your note.</p> : null}
          {groups.length === 0 ? <p>No directions yet. Choose what the car is for, then search again.</p> : null}
          {groups.map((group) => (
            <section key={group.direction.id}>
              <h3>{group.direction.segment}</h3>
              <p>{group.direction.why}</p>
              <p className="hint">
                Candidate models: {group.direction.models.map((item) => `${item.make} ${item.model}`).join(", ")}. Years {group.direction.yearMin}–{group.direction.yearMax}. {group.direction.yearBecause} One listings call uses {group.direction.search.make} {group.direction.search.model}.
              </p>
              <button className="quiet" type="button" onClick={() => void watch(group.direction)} disabled={pending === group.direction.id}>
                {need?.mode === "flip" ? "Watch this budget" : need?.budgetKnown ? "Watch these models" : "Watch these models (wide price cap, budget was not set)"}
              </button>
              {group.note ? <p className="hint">{group.note}</p> : null}
              <ul className="refuse">
                {group.listings.map((car) => (
                  <li key={car.vin}>
                    {car.year} {car.make} {car.model} {car.trim ?? ""} · {car.priceUsd === null ? "price n/a" : `$${car.priceUsd.toLocaleString("en-US")}`} ·{" "}
                    {car.miles === null ? "miles n/a" : `${car.miles.toLocaleString("en-US")} mi`}
                    {car.city ? ` · ${car.city}` : ""}
                    {car.source === "sample" ? " · Sample" : ""}
                    <div>
                      <button className="action" type="button" onClick={() => void analyze(car)} disabled={pending === car.vin}>
                        {pending === car.vin ? "Building…" : "Full analysis — 1 credit"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}

      {path === "check" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void checkListing();
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
          <div className="field">
            <label htmlFor="lookup">{checkKind === "link" ? "Listing link" : "VIN"}</label>
            <input id="lookup" value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder={checkKind === "link" ? "https://" : "17-character VIN"} />
          </div>
          {checkKind === "vin" ? (
            <>
              <p className="hint">A VIN identifies the car. It does not include the asking price, mileage, or where it is.</p>
              <div className="field">
                <label htmlFor="vin-price">Asking price</label>
                <input id="vin-price" value={vinPrice} onChange={(event) => setVinPrice(event.target.value)} inputMode="decimal" />
              </div>
              <div className="field">
                <label htmlFor="vin-miles">Mileage</label>
                <input id="vin-miles" value={vinMiles} onChange={(event) => setVinMiles(event.target.value)} inputMode="numeric" />
              </div>
            </>
          ) : null}
          <div className="field">
            <label htmlFor="vin-zip">ZIP</label>
            <input id="vin-zip" value={vinZip} onChange={(event) => setVinZip(event.target.value)} inputMode="numeric" />
          </div>
          <div className="btn-row">
            <button className="ghost" type="button" onClick={goBack}>
              Back
            </button>
            <button className="action" type="submit" disabled={pending === "report"}>
              {pending === "report" ? "Building report…" : "Full analysis — 1 credit"}
            </button>
          </div>
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
