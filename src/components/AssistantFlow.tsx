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
import { decideAfFlowRestore } from "@/domain/af-flow-session";
import {
  resolveManualCheckHandoff,
  resolveSelectedListingHandoff,
  type FindAnalysisPayload,
} from "@/domain/find-analysis-handoff";
import { isReportHardRefusal, reportRefusalUserMessage } from "@/domain/report-refusal-ui";
import { findEmptyCopy, type FindEmptyReason } from "@/domain/find-empty";
import type { FindListingPriceView } from "@/domain/find-listing-price";
import {
  compareObservedModels,
  formatModelCompareRow,
  observedModelSnapshots,
} from "@/domain/find-model-observe";
import { proposeFindNextChecks } from "@/domain/find-next-checks";
import {
  rematchRefineFromReplan,
  shouldAutoContinueFindNextCheck,
  shouldAutoStartFindNextCheck,
} from "@/domain/find-next-check-ui";
import { buildGroundedShortlist } from "@/domain/find-path";
import { USE_CASES, searchScopeLabel, softPrefGapsFromText, type FollowUp, type StructuredNeed } from "@/domain/need";
import type { Mode } from "@/domain/types";
import { isValidVin } from "@/domain/vin";
import { MakeModelFields } from "./MakeModelFields";
import { ZipRadiusFields } from "./ZipRadiusFields";

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
  priceView?: FindListingPriceView;
  /** Opaque server-minted token from /api/match — required for trusted full analysis. */
  analysisContextToken?: string | null;
};

type MatchGroup = {
  direction: SearchDirection;
  /** Models with successful provider response (ok/empty) — UI "checked". */
  searchedModels?: Array<{ make: string; model: string }>;
  /** Dispatched but failed/timed out — attempted, not successfully checked. */
  failedModels?: Array<{ make: string; model: string; outcome?: string }>;
  plannedModels?: Array<{ make: string; model: string }>;
  skippedModels?: Array<{ make: string; model: string; reason?: string }>;
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

export function FindFlow({
  initialNote,
  initialMode,
  initialZip,
  initialDistanceMiles,
}: {
  initialNote?: string;
  initialMode?: "personal" | "flip";
  initialZip?: string;
  /** Null = nationwide. Undefined = not provided by the entry URL. */
  initialDistanceMiles?: number | null;
}) {
  return (
    <AssistantFlow
      variant="find"
      initialNote={initialNote}
      initialMode={initialMode}
      initialZip={initialZip}
      initialDistanceMiles={initialDistanceMiles}
    />
  );
}

export function CheckFlow() {
  return <AssistantFlow variant="check" />;
}

function AssistantFlow({
  variant,
  initialNote,
  initialMode,
  initialZip,
  initialDistanceMiles,
}: {
  variant: "find" | "check";
  initialNote?: string;
  initialMode?: "personal" | "flip";
  initialZip?: string;
  initialDistanceMiles?: number | null;
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
  const [zipDraft, setZipDraft] = useState(initialZip ?? "");
  const [distanceDraft, setDistanceDraft] = useState<number | null>(
    initialDistanceMiles === undefined ? null : initialDistanceMiles,
  );
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
  /** Owner-bound search context from /api/match — required for next-check. */
  const [searchContextToken, setSearchContextToken] = useState<string | null>(null);
  const [servNextCheckEnabled, setServNextCheckEnabled] = useState(false);
  /** Find next-check live path — ids already applied this session (loop guard). */
  const [appliedNextChecks, setAppliedNextChecks] = useState<string[]>([]);
  const [nextCheckNote, setNextCheckNote] = useState<string | null>(null);
  /** Auto-start next-check once per searchContextToken when SERV keyed. */
  const autoNextCheckTokenRef = useRef<string | null>(null);

  async function understand(followUp?: { id: FollowUp["id"]; value: string }) {
    setError(null);
    const zipForNeed = zipDraft.trim() || need?.zip || null;
    if (distanceDraft != null && !zipForNeed) {
      setError("Add a ZIP for a seller-distance radius, or choose Nationwide.");
      return;
    }
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
          zip: zipForNeed,
          // Always send the user-selected radius (null = Nationwide). Never drop it silently.
          distanceMiles: distanceDraft,
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
      setZipDraft(body.need.zip ?? "");
      setDistanceDraft(body.need.distanceMiles);
      if (body.need.yearMin != null) setYearMin(String(body.need.yearMin));
      if (body.need.yearMax != null) setYearMax(String(body.need.yearMax));
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
    if (initialZip) setZipDraft(initialZip);
    if (initialDistanceMiles !== undefined) setDistanceDraft(initialDistanceMiles);
    const amount = budgetFromText(initialNote);
    if (amount) setBudget(String(amount));
    setStage("budget");
  }, [initialDistanceMiles, initialMode, initialNote, initialZip, variant]);

  useEffect(() => {
    if (variant !== "find" || initialNote?.trim()) return;
    try {
      const raw = sessionStorage.getItem("af-flow");
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        v?: number;
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

      const decision = decideAfFlowRestore(saved);
      const groups = saved.groups ?? [];
      if (decision.action === "drop_results") {
        sessionStorage.removeItem("af-flow");
        setNeed(saved.need);
        setStage("confirm");
        setGroups([]);
        setSample(false);
        setMatchMessage(decision.reason);
        if (saved.need.budgetUsd) setBudget(String(saved.need.budgetUsd));
        if (saved.need.zip) setZipDraft(saved.need.zip);
        return;
      }

      setNeed(saved.need);
      setStage(saved.stage);
      setGroups(groups);
      setSource(saved.source ?? "form");
      setChecks(saved.checks ?? []);
      setAffordability(saved.affordability ?? true);
      setSample(decision.sample);
      if (decision.warnUnknownSource) {
        setMatchMessage(
          saved.matchMessage ??
            "Some restored listings have an unrecognized source — not treated as confirmed live Autodev inventory.",
        );
      } else {
        setMatchMessage(saved.matchMessage ?? null);
      }
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

  // After credit purchase, resume the exact selected listing — do not ask for a URL we already hold.
  const pendingRetry = useRef(false);
  useEffect(() => {
    if (variant !== "find" || stage !== "results" || !need || pendingRetry.current) return;
    try {
      const raw = sessionStorage.getItem("af-pending-analysis");
      if (!raw) return;
      const payload = JSON.parse(raw) as FindAnalysisPayload;
      if (!payload?.selectedVin || payload.surface !== "find") return;
      pendingRetry.current = true;
      const resumed: FindAnalysisPayload = { ...payload, cta: "find_pending_retry" };
      void submitAnalysis(resumed);
    } catch {
      /* ignore corrupt pending payload */
    }
  }, [variant, stage, need]);

  // After credit purchase from /check, restore the form (Find already restores via af-pending-analysis).
  const checkRestored = useRef(false);
  useEffect(() => {
    if (variant !== "check" || checkRestored.current) return;
    try {
      const raw = sessionStorage.getItem("af-check");
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        mode?: Mode;
        checkKind?: "link" | "vin";
        lookup?: string;
        vinPrice?: string;
        vinMiles?: string;
        vinZip?: string;
      };
      checkRestored.current = true;
      if (saved.mode === "flip" || saved.mode === "personal") setMode(saved.mode);
      if (saved.checkKind === "link" || saved.checkKind === "vin") setCheckKind(saved.checkKind);
      if (typeof saved.lookup === "string") setLookup(saved.lookup);
      if (typeof saved.vinPrice === "string") setVinPrice(saved.vinPrice);
      if (typeof saved.vinMiles === "string") setVinMiles(saved.vinMiles);
      if (typeof saved.vinZip === "string") setVinZip(saved.vinZip);
    } catch {
      /* ignore corrupt check payload */
    }
  }, [variant]);

  function rememberFlow() {
    try {
      sessionStorage.setItem(
        "af-flow",
        JSON.stringify({
          v: 2,
          need,
          stage,
          groups,
          source,
          checks,
          affordability,
          sample,
          matchMessage,
          matchScope,
          emptyReason,
        }),
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
    if (current.yearMin != null) setYearMin(String(current.yearMin));
    if (current.yearMax != null) setYearMax(String(current.yearMax));
    setQuestions([]);
    setStage("confirm");
  }

  /**
   * Live Find next-check via owner-bound searchContextToken.
   * Server loads need/listings, claims keyed SERV, applies, rematches with NEW need.
   * Client yearMin/yearMax UI state is never sent as rematch authority.
   */
  async function applyLiveNextCheck(opts?: { token?: string; auto?: boolean }) {
    if (variant !== "find") return;
    const token = opts?.token ?? searchContextToken;
    if (!token) {
      if (!opts?.auto) setError("Search context missing — run Find again before next check.");
      return;
    }
    setError(null);
    setNextCheckNote(null);
    setPending("next-check");
    let continueToken: string | null = null;
    try {
      const response = await fetch("/api/find/next-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchContextToken: token }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        message?: string;
        chosenId?: string;
        source?: string;
        autonomousServ?: boolean;
        research?: boolean;
        servNote?: string | null;
        needAfter?: StructuredNeed;
        appliedCheckIds?: string[];
        searchContextToken?: string;
        replan?: { need: StructuredNeed; refine: { yearMin?: number; yearMax?: number; make?: string; model?: string }; note: string };
        rematch?: {
          ok?: boolean;
          status?: number;
          body?: {
            directions?: MatchGroup[];
            sample?: boolean;
            message?: string;
            headline?: string;
            nextStep?: string;
            scope?: string;
            emptyReason?: FindEmptyReason | null;
            partialFailure?: boolean;
            affordabilityAssessed?: boolean;
            searchContextToken?: string | null;
            servNextCheckEnabled?: boolean;
          };
        } | null;
        loop?: { continue?: boolean; reason?: string; detail?: string };
        honesty?: string;
      };
      if (!response.ok || !body.ok || !body.replan?.need) {
        setError(body.message || "Next check could not be applied.");
        return;
      }
      // Always adopt NEW need from server apply — never stale same-tick UI years.
      const nextNeed = body.needAfter ?? body.replan.need;
      setNeed(nextNeed);
      if (body.replan.refine.yearMin != null) setYearMin(String(body.replan.refine.yearMin));
      else if (nextNeed.yearMin != null) setYearMin(String(nextNeed.yearMin));
      if (body.replan.refine.yearMax != null) setYearMax(String(body.replan.refine.yearMax));
      else if (nextNeed.yearMax != null) setYearMax(String(nextNeed.yearMax));
      if (Array.isArray(body.appliedCheckIds)) setAppliedNextChecks(body.appliedCheckIds);
      else if (body.chosenId) setAppliedNextChecks((prev) => [...prev, body.chosenId!]);
      const nextTok =
        typeof body.searchContextToken === "string" ? body.searchContextToken : token;
      if (typeof body.searchContextToken === "string") setSearchContextToken(body.searchContextToken);
      const keyedDiag = (body as {
        keyedAutonomyDiag?: {
          keyed?: boolean;
          mintSaidKeyed?: boolean | null;
          source?: string;
          failureCategory?: string | null;
          failureReasonCode?: string | null;
          configHint?: string | null;
        };
        failureDiag?: { category?: string; reasonCode?: string } | null;
      }).keyedAutonomyDiag;
      const failCat =
        keyedDiag?.failureCategory ??
        (body as { failureDiag?: { category?: string } | null }).failureDiag?.category ??
        null;
      const failCode =
        keyedDiag?.failureReasonCode ??
        (body as { failureDiag?: { reasonCode?: string } | null }).failureDiag?.reasonCode ??
        null;
      setNextCheckNote(
        [
          body.autonomousServ ? "SERV chose" : "Code fallback (not autonomous SERV)",
          body.chosenId,
          "—",
          body.replan.note,
          body.servNote ? `(${body.servNote})` : "",
          body.loop?.reason ? `[${body.loop.reason}]` : "",
          failCat ? `diag=${failCat}${failCode ? `/${failCode}` : ""}` : "",
          keyedDiag?.configHint ? `hint=${keyedDiag.configHint}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (
        shouldAutoContinueFindNextCheck({
          servNextCheckEnabled: servNextCheckEnabled || Boolean(opts?.auto),
          autonomousServ: Boolean(body.autonomousServ),
          searchContextToken: nextTok,
          loop: body.loop
            ? { continue: Boolean(body.loop.continue), reason: body.loop.reason ?? "" }
            : null,
        })
      ) {
        continueToken = nextTok;
      }

      // Prefer server rematch (NEW need). Fallback client rematch uses replan only — never yearMin UI state.
      if (body.research && body.rematch?.body) {
        const matchBody = body.rematch.body;
        if (!body.rematch.ok) {
          const reason = matchBody.emptyReason ?? "provider_failure";
          const copy = findEmptyCopy(reason, nextNeed, matchBody.message);
          setError(copy.detail);
          setMatchHeadline(matchBody.headline ?? copy.headline);
          setMatchNextStep(matchBody.nextStep ?? copy.nextStep);
          setMatchMessage(copy.detail);
          setEmptyReason(reason);
          setGroups([]);
          return;
        }
        const nextGroups = (matchBody.directions ?? []).map((group) => ({
          ...group,
          listings: (group.listings ?? []).filter((car) => car.source !== "sample"),
        }));
        setGroups(nextGroups);
        setSample(Boolean(matchBody.sample));
        setAffordability(matchBody.affordabilityAssessed !== false);
        setMatchScope(matchBody.scope ?? null);
        setMatchHeadline(matchBody.headline ?? null);
        setMatchNextStep(matchBody.nextStep ?? null);
        setMatchMessage(matchBody.message ?? null);
        setEmptyReason(matchBody.emptyReason ?? null);
        setPartialFailure(Boolean(matchBody.partialFailure));
        if (typeof matchBody.searchContextToken === "string") {
          setSearchContextToken(matchBody.searchContextToken);
        }
        if (typeof matchBody.servNextCheckEnabled === "boolean") {
          setServNextCheckEnabled(matchBody.servNextCheckEnabled);
        }
        setStage("results");
      } else if (body.research) {
        // Server did not rematch — client rematch with NEW need/refine only (stale-year fix).
        setPending("match");
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 45_000);
        try {
          const matchResponse = await fetch("/api/match", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              need: nextNeed,
              refine: rematchRefineFromReplan({
                replanRefine: body.replan.refine,
                needAfter: nextNeed,
                uiYearMin: yearMin,
                uiYearMax: yearMax,
              }),
            }),
          });
          const matchBody = (await matchResponse.json()) as {
            directions?: MatchGroup[];
            sample?: boolean;
            message?: string;
            headline?: string;
            nextStep?: string;
            scope?: string;
            emptyReason?: FindEmptyReason | null;
            partialFailure?: boolean;
            affordabilityAssessed?: boolean;
            searchContextToken?: string | null;
            servNextCheckEnabled?: boolean;
          };
          if (!matchResponse.ok) {
            const reason = matchBody.emptyReason ?? "provider_failure";
            const copy = findEmptyCopy(reason, nextNeed, matchBody.message);
            setError(copy.detail);
            setMatchHeadline(matchBody.headline ?? copy.headline);
            setMatchNextStep(matchBody.nextStep ?? copy.nextStep);
            setMatchMessage(copy.detail);
            setEmptyReason(reason);
            setGroups([]);
            return;
          }
          const nextGroups = (matchBody.directions ?? []).map((group) => ({
            ...group,
            listings: (group.listings ?? []).filter((car) => car.source !== "sample"),
          }));
          setGroups(nextGroups);
          setSample(Boolean(matchBody.sample));
          setAffordability(matchBody.affordabilityAssessed !== false);
          setMatchScope(matchBody.scope ?? null);
          setMatchHeadline(matchBody.headline ?? null);
          setMatchNextStep(matchBody.nextStep ?? null);
          setMatchMessage(matchBody.message ?? null);
          setEmptyReason(matchBody.emptyReason ?? null);
          setPartialFailure(Boolean(matchBody.partialFailure));
          if (typeof matchBody.searchContextToken === "string") {
            setSearchContextToken(matchBody.searchContextToken);
          }
          if (typeof matchBody.servNextCheckEnabled === "boolean") {
            setServNextCheckEnabled(matchBody.servNextCheckEnabled);
          }
          setStage("results");
        } finally {
          window.clearTimeout(timer);
        }
      }
    } catch {
      setError("Next check failed — try again.");
    } finally {
      setPending(null);
    }
    // Continue loop after pending clears — evidence→replan until server stop reason.
    if (continueToken) {
      void applyLiveNextCheck({ token: continueToken, auto: true });
    }
  }

  async function findCars() {
    if (!need) return;
    // Geography must be coherent before inventory: radius requires ZIP; Nationwide is explicit null.
    if (need.distanceMiles != null && !need.zip) {
      setError("Add a ZIP for a seller-distance radius, or choose Nationwide.");
      return;
    }
    setError(null);
    setMatchMessage(null);
    setMatchHeadline(null);
    setMatchNextStep(null);
    setEmptyReason(null);
    setPartialFailure(false);
    setPending("match");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 45_000);
    /** Fired after finally so we do not clear next-check pending. */
    let autoNextToken: string | null = null;
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
            yearMin: yearMin ? Number(yearMin) : need.yearMin ?? undefined,
            yearMax: yearMax ? Number(yearMax) : need.yearMax ?? undefined,
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
        searchContextToken?: string | null;
        servNextCheckEnabled?: boolean;
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
      const nextToken =
        typeof body.searchContextToken === "string" && body.searchContextToken.trim()
          ? body.searchContextToken.trim()
          : null;
      setSearchContextToken(nextToken);
      setServNextCheckEnabled(Boolean(body.servNextCheckEnabled && nextToken));
      setAppliedNextChecks([]);
      try {
        sessionStorage.setItem(
          "af-flow",
          JSON.stringify({
            v: 2,
            need,
            stage: "results",
            groups: nextGroups,
            source,
            checks,
            affordability: body.affordabilityAssessed !== false,
            // Honest flag — never write sample:false over fixture rows.
            sample: Boolean(body.sample),
            matchMessage: body.message ?? null,
            matchHeadline: body.headline ?? null,
            matchNextStep: body.nextStep ?? null,
            matchScope: body.scope ?? searchScopeLabel(need),
            emptyReason: body.emptyReason ?? null,
            partialFailure: Boolean(body.partialFailure),
            searchContextToken: nextToken,
            servNextCheckEnabled: Boolean(body.servNextCheckEnabled && nextToken),
          }),
        );
      } catch {
        /* ignore */
      }
      // Ordinary NL→Find auto-starts next-check when SERV keyed — not a manual-only path.
      const auto = shouldAutoStartFindNextCheck({
        servNextCheckEnabled: Boolean(body.servNextCheckEnabled),
        searchContextToken: nextToken,
        alreadyAutoStartedForToken: autoNextCheckTokenRef.current,
      });
      if (auto) {
        autoNextCheckTokenRef.current = auto;
        autoNextToken = auto;
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
    if (autoNextToken) {
      void applyLiveNextCheck({ token: autoNextToken, auto: true });
    }
  }

  async function watch(direction: SearchDirection) {
    // Watches require explicit ZIP + seller-distance radius — never invent 50/100 after Nationwide.
    if (!need?.zip?.trim() || need.distanceMiles == null) {
      setError("Saved searches need a ZIP and a seller-distance radius. Choose a radius (Nationwide watches are not supported).");
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
                  radiusMiles: need.distanceMiles,
                  repairAbility: need.repairAbility,
                  minProfitUsd: need.targetProfitUsd ?? undefined,
                }
              : {
                  models: direction.models.slice(0, 6),
                  yearMin: direction.yearMin,
                  yearMax: direction.yearMax,
                  priceMax,
                  zip: need.zip,
                  radiusMiles: need.distanceMiles,
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

  async function submitAnalysis(payload: FindAnalysisPayload) {
    setPending(payload.selectedVin);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as {
        id?: string;
        message?: string;
        error?: string;
        alreadySaved?: boolean;
        charge?: boolean;
        outcome?: string;
      };
      if (response.status === 403 && body.error === "credits_required") {
        rememberFlow();
        try {
          sessionStorage.setItem("af-pending-analysis", JSON.stringify(payload));
        } catch {
          /* ignore */
        }
        router.push("/credits?need=1&return=%2Ffind");
        return;
      }
      // Hard refusal (unusable ask / invalid find context) — clear reason, no fake completion.
      if (isReportHardRefusal({ status: response.status, error: body.error })) {
        setError(reportRefusalUserMessage({ message: body.message, error: body.error }));
        return;
      }
      if (!response.ok || !body.id) {
        setError(body.message || "The report could not be built.");
        return;
      }
      try {
        sessionStorage.removeItem("af-pending-analysis");
      } catch {
        /* ignore */
      }
      router.push(`/report/${body.id}`);
    } catch {
      setError("The report request did not finish.");
    } finally {
      setPending(null);
    }
  }

  async function analyze(car: ListingCard) {
    if (!need) return;
    setError(null);
    const handoff = resolveSelectedListingHandoff(
      {
        ...car,
        analysisContextToken: car.analysisContextToken,
      },
      need,
      "find_card_full_analysis",
    );
    if (!handoff.ok) {
      setError(handoff.message);
      return;
    }
    await submitAnalysis(handoff.payload);
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
    if (checkKind === "vin" && !isValidVin(lookup.trim())) {
      setError("Enter a valid 17-character VIN.");
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
    const price = checkKind === "vin" ? parseUsdInput(vinPrice) : null;
    const miles = checkKind === "vin" ? parseCountInput(vinMiles) : null;
    if (checkKind === "vin" && (price === null || miles === null || !vinZip.trim())) {
      setError(price === null ? "Enter the asking price, like $18,773." : miles === null ? "Enter the mileage, like 109,333." : "Enter a ZIP.");
      return;
    }
    const handoff = resolveManualCheckHandoff({
      mode,
      kind: checkKind,
      lookup,
      askingPriceUsd: price,
      miles,
      zip: vinZip.trim() || null,
    });
    if (!handoff.ok) {
      setError(handoff.message);
      return;
    }
    setPending("report");
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(handoff.payload),
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
      try {
        sessionStorage.removeItem("af-check");
      } catch {
        /* ignore */
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
          {/* Geo connects here in-process (not on the homepage) before inventory. Nationwide only when chosen. */}
          <ZipRadiusFields
            idPrefix="find-budget"
            zip={zipDraft}
            distanceMiles={distanceDraft}
            onZipChange={(next) => {
              setZipDraft(next);
              // Clearing ZIP clears radius (Nationwide). Adding ZIP must not invent a radius.
              if (!next.trim()) setDistanceDraft(null);
            }}
            onDistanceChange={setDistanceDraft}
          />
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
          <p className="hint">{need?.mode === "flip" ? "These answers change the reconditioning assumption and the profit target. They are not a quote." : "A few clarifications for facts Find can act on — not a condition score or invented TCO."}</p>
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
              {question.id === "age" ? (
                <select id={question.id} value={answers.age ?? ""} onChange={(event) => setAnswers({ ...answers, age: event.target.value })}>
                  <option value="">Choose</option>
                  <option value="2018">2018 or newer</option>
                  <option value="2015">2015 or newer</option>
                  <option value="2012">2012 or newer</option>
                  <option value="2010">2010 or newer</option>
                  <option value="any">No year floor — use budget band</option>
                </select>
              ) : null}
              {question.id === "miles" ? (
                <div className="pills">
                  {[
                    ["60000", "60,000 mi"],
                    ["80000", "80,000 mi"],
                    ["100000", "100,000 mi"],
                    ["any", "No cap"],
                  ].map(([value, label]) => (
                    <label className="pill" key={value}>
                      <input
                        type="radio"
                        name="miles"
                        checked={answers.miles === value}
                        onChange={() => setAnswers({ ...answers, miles: value })}
                      />{" "}
                      {label}
                    </label>
                  ))}
                </div>
              ) : null}
              {question.id === "condition" ? (
                <select
                  id={question.id}
                  value={answers.condition ?? ""}
                  onChange={(event) => setAnswers({ ...answers, condition: event.target.value })}
                >
                  <option value="">Choose</option>
                  <option value="inspection_first">Yes — prioritize inspection and a history report</option>
                  <option value="price_ok">Price can lead for now; I still know history is unchecked</option>
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
          <ZipRadiusFields
            idPrefix="find-confirm"
            zip={need.zip ?? ""}
            distanceMiles={need.distanceMiles}
            onZipChange={(nextZip) => {
              const trimmed = nextZip.trim() || null;
              setNeed({
                ...need,
                zip: trimmed,
                // Clearing ZIP clears radius. Adding ZIP keeps Nationwide (null) until the shopper picks miles.
                distanceMiles: trimmed ? need.distanceMiles : null,
              });
              setZipDraft(nextZip);
              setDistanceDraft(trimmed ? need.distanceMiles : null);
            }}
            onDistanceChange={(miles) => {
              setNeed({ ...need, distanceMiles: miles });
              setDistanceDraft(miles);
            }}
          />
          <p className="hint" aria-live="polite">
            Scope: {searchScopeLabel(need)}
          </p>
          <div className="field">
            <label htmlFor="miles-edit">Maximum mileage in miles (optional)</label>
            <input
              id="miles-edit"
              value={need.milesMax ?? ""}
              inputMode="numeric"
              placeholder="e.g. 80,000 miles"
              aria-describedby="miles-edit-hint"
              onChange={(event) => {
                const amount = Number(event.target.value.replace(/,/g, ""));
                setNeed({ ...need, milesMax: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null });
              }}
            />
            <p id="miles-edit-hint" className="hint">Units are miles (odometer), not kilometers.</p>
          </div>
          <div className="field">
            <label htmlFor="year-min-edit">Oldest model year (optional)</label>
            <input
              id="year-min-edit"
              value={need.yearMin ?? ""}
              inputMode="numeric"
              placeholder="e.g. 2015"
              onChange={(event) => {
                const year = Number(event.target.value);
                const next = Number.isFinite(year) && year >= 1980 ? Math.round(year) : null;
                setNeed({ ...need, yearMin: next });
                setYearMin(next ? String(next) : "");
              }}
            />
            <p className="hint">
              {need.yearMin != null
                ? `Search will use ${need.yearMin}${need.yearMax != null ? `–${need.yearMax}` : "+"} from your clarification or this field.`
                : "Leave blank to use the budget-based editorial year band only."}
            </p>
          </div>
          {need.conditionPriority === "inspection_first" ? (
            <p className="hint">
              You prioritized condition: Find still cannot score condition. Next steps favor full analysis and an NMVTIS-approved history report — not a fictitious cleanliness score.
            </p>
          ) : null}
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
          {softPrefGapsFromText(need.note).map((gap) => (
            <p className="hint" key={gap.id}>
              Noted preference: {gap.mentioned}. {gap.honesty}
            </p>
          ))}
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
          {need
            ? softPrefGapsFromText(need.note).map((gap) => (
                <p className="hint" key={`results-${gap.id}`}>
                  {gap.honesty}
                </p>
              ))
            : null}
          {need
            ? (() => {
                const allListings = groups.flatMap((g) => g.listings);
                const snaps = observedModelSnapshots(
                  allListings.map((car) => ({
                    make: car.make,
                    model: car.model,
                    year: car.year,
                    priceUsd: car.priceView?.usableForBudget ? car.priceUsd : null,
                    miles: car.miles,
                  })),
                );
                const empty =
                  groups.length === 0 || groups.every((group) => group.listings.length === 0);
                const checks = proposeFindNextChecks({
                  need,
                  softGaps: softPrefGapsFromText(need.note),
                  observedListingCount: allListings.length,
                  observedModelCount: snaps.length,
                  emptyInventory: empty,
                });
                const shortlist = buildGroundedShortlist(need, allListings.map((car) => ({
                  make: car.make,
                  model: car.model,
                  year: car.year,
                  priceUsd: car.priceView?.usableForBudget ? car.priceUsd : null,
                  miles: car.miles,
                })));
                if (checks.length === 0 && shortlist.length === 0) return null;
                return (
                  <div className="hint" role="note">
                    {checks.length > 0 ? (
                      <>
                        <p>
                          {servNextCheckEnabled
                            ? "When SERV is configured, next-check continues automatically after search as evidence updates (apply → rematch → replan) until grounded stop, clarification, failure, or unchanged-state. Manual retry:"
                            : "Suggested next checks (code allowlist). SERV is not configured — deterministic fallback only (not autonomous SERV). Manual apply:"}
                        </p>
                        <ul>
                          {checks.map((item) => (
                            <li key={item.id}>
                              <strong>{item.id}</strong>: {item.why}
                            </li>
                          ))}
                        </ul>
                        <p>
                          <button
                            type="button"
                            className="secondary"
                            disabled={pending !== null || !searchContextToken}
                            onClick={() => void applyLiveNextCheck()}
                          >
                            {pending === "next-check"
                              ? "Choosing next check…"
                              : servNextCheckEnabled
                                ? "Retry next check (SERV + rematch)"
                                : "Apply next check (deterministic)"}
                          </button>
                        </p>
                        {nextCheckNote ? <p className="hint">{nextCheckNote}</p> : null}
                      </>
                    ) : null}
                    {shortlist.length > 0 ? (
                      <>
                        <p>
                          Grounded shortlist from returned cards only (not a “best car” rank — condition unknown; fuel
                          unavailable without EPA match):
                        </p>
                        <ul>
                          {shortlist.map((row) => (
                            <li key={`${row.make}-${row.model}`}>
                              {row.make} {row.model}: {row.why}. Unknowns: {row.unknowns.join("; ")}.
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </div>
                );
              })()
            : null}
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
              {group.providerWarning &&
              !(matchMessage && matchMessage.toLowerCase().includes(group.providerWarning.toLowerCase())) ? (
                <p className="warn-box">{group.providerWarning}</p>
              ) : null}
              <p className="hint">
                {group.searchedModels?.length
                  ? `Live models checked: ${group.searchedModels.map((item) => `${item.make} ${item.model}`).join(", ")}.`
                  : "No live model search completed successfully for this group."}
                {group.failedModels?.length
                  ? ` Attempted but not checked: ${group.failedModels.map((item) => `${item.make} ${item.model}${item.outcome ? ` (${item.outcome})` : ""}`).join(", ")}.`
                  : ""}
                {group.skippedModels?.length
                  ? ` Skipped (provider budget): ${group.skippedModels.map((item) => `${item.make} ${item.model}`).join(", ")} — not checked.`
                  : ""}{" "}
                Years {group.direction.yearMin}–{group.direction.yearMax}. {group.direction.yearBecause}
              </p>
              {group.listings.length > 0
                ? (() => {
                    const rows = group.listings.map((car) => ({
                      make: car.make,
                      model: car.model,
                      year: car.year,
                      priceUsd: car.priceView?.usableForBudget ? car.priceUsd : null,
                      miles: car.miles,
                    }));
                    const compared = compareObservedModels(rows);
                    if (compared.length === 0) return null;
                    return (
                      <div className="hint" role="note">
                        <p>
                          Observed model comparison from these cards only (not a TCO, reliability, or “best car” rank —{" "}
                          {compared[0]!.honesty}):
                        </p>
                        <ul>
                          {compared.map((row) => (
                            <li key={`${row.make}-${row.model}`}>{formatModelCompareRow(row)}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()
                : null}
              <button className="quiet" type="button" onClick={() => void watch(group.direction)} disabled={pending === group.direction.id}>
                {pending === group.direction.id ? "Saving alert…" : need?.mode === "flip" ? "Get alerts for this budget" : "Get new-listing alerts"}
              </button>
              <p className="hint">The one-time search is free. Ongoing new-listing alerts require a separate monthly Radar plan.</p>
              {error && pending === null ? (
                <p className="warn" role="alert">
                  {error} {/plan|watch/i.test(error) ? <a href="/pricing">See radar plans</a> : null}
                </p>
              ) : null}
              {group.note &&
              !(
                (matchMessage && matchMessage.toLowerCase().includes(group.note.toLowerCase())) ||
                (group.providerWarning && group.note.toLowerCase().includes(group.providerWarning.toLowerCase()))
              ) ? (
                <p className="hint">{group.note}</p>
              ) : null}
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
                      {car.priceView?.displayPrimary ??
                        (car.priceUsd === null ? "Price not listed" : `$${car.priceUsd.toLocaleString("en-US")}`)}
                      {" · "}
                      {car.miles === null ? "Mileage not listed" : `${car.miles.toLocaleString("en-US")} mi`}
                      {car.city ? ` · ${car.city}${car.state ? `, ${car.state}` : ""}` : ""}
                    </p>
                    {car.priceView?.displayDetail ? <p className="hint">{car.priceView.displayDetail}</p> : null}
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
                        priceUsd: car.priceView?.usableForBudget ? car.priceUsd : null,
                        budgetUsd: need?.budgetUsd ?? null,
                        overBudget: car.overBudget,
                        bodyStyle: car.bodyStyle,
                        style: car.style,
                        // Listing make only — never join preferredMakes onto another make's card.
                        requestedMake: car.make,
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
                <label htmlFor="vin-miles">Mileage (miles)</label>
                <input id="vin-miles" value={vinMiles} onChange={(event) => setVinMiles(event.target.value)} inputMode="numeric" placeholder="e.g. 109,333 miles" />
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
            <button
              className="action"
              type="submit"
              disabled={
                pending === "preview" ||
                (checkKind === "vin" && Boolean(lookup.trim()) && !isValidVin(lookup.trim()))
              }
            >
              {pending === "preview" ? "Checking the price…" : "Check the price"}
            </button>
          </div>
          {checkKind === "vin" && lookup.trim() && !isValidVin(lookup.trim()) ? (
            <p className="warn" role="alert">
              Enter a valid 17-character VIN before checking the price.
            </p>
          ) : null}
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
