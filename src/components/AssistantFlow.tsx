"use client";

import { parseCountInput, parseUsdInput } from "@/domain/budget";
import type { PriceBadge } from "@/domain/price-badge";
import { whyThisCar } from "@/domain/why-car";
import { PriceBadgeView, PriceRatingHow } from "./PriceBadge";
import { budgetFromText, budgetWorkingCopy } from "@/domain/need";
import {
  findStageAfterNote,
  needFromFindEntry,
  noteMarksFrom,
  type NoteMarks,
} from "@/domain/find-intake-stage";
import { resolveLocationZip, zipFieldMark, type LocationZipResolution } from "@/domain/city-to-zip";
import { intakeFromNote, isNearMePhrase, NOTE_DEFAULT_RADIUS_WHEN_ZIP } from "@/domain/note-intake";
import { criteriaParseLabel } from "@/domain/radar-criteria-provenance";
import { FOLLOW_HINT } from "@/domain/intake-copy";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  FREE_VEHICLE_CHECKS_PER_MONTH,
  formatFreeChecksSignInPrompt,
  freeChecksRemainingFromAccount,
} from "@/domain/free-check-quota";
import type { DecisionProof } from "@/domain/decision-note";
import type { DecisionProofRecord } from "@/domain/decision-proof-view";
import { intentSummaryFromNeed, type SearchDirection } from "@/domain/directions";
import { CoverageLine } from "./CoverageNote";
import { DecisionNote } from "./DecisionNote";
import { ConsumerDecisionProof } from "./ConsumerDecisionProof";
import { decideAfFlowRestore, resumeFindSearchFromFlow } from "@/domain/af-flow-session";
import {
  resolveManualCheckHandoff,
  resolveSelectedListingHandoff,
  type FindAnalysisPayload,
} from "@/domain/find-analysis-handoff";
import { buyerFacingFailure } from "@/domain/buyer-facing-error";
import { publishCreditBalance, refreshPublishedCreditBalance } from "@/domain/credit-balance-event";
import { isReportHardRefusal, reportRefusalUserMessage } from "@/domain/report-refusal-ui";
import { findEmptyCopy, type FindEmptyReason } from "@/domain/find-empty";
import type { FindListingPriceView } from "@/domain/find-listing-price";
import {
  compareObservedModels,
  formatModelCompareRow,
  observedModelSnapshots,
} from "@/domain/find-model-observe";
import { proposeFindNextChecks } from "@/domain/find-next-checks";
import { findNextCheckPendingLabel } from "@/domain/find-next-check-pending";
import {
  FIND_NEXT_CHECK_AUTO_CONTINUE_MAX,
  rematchRefineFromReplan,
  shouldAutoContinueFindNextCheck,
  shouldAutoStartFindNextCheck,
  shouldResumeFindLoop,
} from "@/domain/find-next-check-ui";
import {
  FIND_RESULTS_BILLING_HINT,
  buyerCheckActivityLine,
  publicCheckStatusLine,
  formatGroundedShortlistLine,
  findSettledStatusLine,
  formatBuyerBestDeal,
  formatBuyerLoopStatus,
  formatBuyerLoopStep,
  formatBuyerNextCheckWhy,
  formatOfficialRecallNumber,
  formatRecallCheckSummary,
  formatTopPickLine,
  sellerQuestionsForBuyer,
  topCarsHeading,
  topPicksInRankOrder,
  summarizeFuelCheckOutcome,
  summarizeRecallCheckOutcome,
} from "@/domain/find-buyer-copy";
import type { BestDealResult } from "@/domain/find-best-deal";
import { buyerCarLabels } from "@/domain/find-car-label";
import { formatBaselineForBuyer, type FindBaselineDelta } from "@/domain/find-baseline";
import { buildFindAgentVerdict } from "@/domain/build-find-agent-verdict";
import { findVerdictLineage } from "@/domain/find-verdict-lineage";
import {
  presentDecisionLogForBuyer,
  type DecisionCarLabel,
  type FindDecisionLogEntry,
} from "@/domain/find-decision-log";
import { formatFindFuelEvidenceShort, fuelFactFromFindEvidence } from "@/domain/find-fuel-match";
import { buildGroundedShortlist } from "@/domain/find-path";
import {
  buyerSourceLinesForUi,
  formatFreeGovReceiptsForAgents,
  formatFreeGovReceiptsForUi,
  uiRowsToRiskReceipts,
  type FreeGovReceiptUiRow,
} from "@/domain/find-free-gov-format";
import { trimSourceDisagreement } from "@/domain/find-car-consistency";
import {
  buildPurchaseReadiness,
  omitQuestionsCoveredByTalkingPoints,
  readinessCarsFromUnknown,
  recallCampaignCountForCar,
  zipChoice,
  type ReadinessCar,
} from "@/domain/purchase-readiness";
import { PurchaseReadinessNote } from "./PurchaseReadinessNote";
import { matchBuyerListing } from "@/domain/find-listing-link";
import { buyerDealerListingLink } from "@/domain/listing-vdp-verifiability";
import { mmyListingKey } from "@/domain/find-risk-evidence";
import {
  ageGapBuyerHonesty,
  applyFollowUp,
  explicitNeedFromText,
  followUps,
  USE_CASES,
  searchScopeLabel,
  softPrefGapsFromText,
  type FollowUp,
  type StructuredNeed,
} from "@/domain/need";
import type { Mode } from "@/domain/types";
import { isValidVin } from "@/domain/vin";
import { MakeModelFields } from "./MakeModelFields";
import { ZipRadiusFields } from "./ZipRadiusFields";
import {
  CONDITION_HINT,
  MilesDraftField,
  NoteFactChips,
  PriceDraftField,
  YearFloorField,
  FromNote,
} from "./FindIntakeFields";

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
  dealer?: string | null;
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
  zip?: string | null;
  createdAt?: string | null;
  accidentCount?: number | null;
  usageType?: string | null;
  cpo?: boolean | null;
  oneOwner?: boolean | null;
  ownerCount?: number | null;
  askingPriceKind?: "purchase_ask" | "dealer_fee" | "unknown" | null;
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

/** @deprecated Import from `@/components/CheckFlow` — kept for any residual imports. */
export { CheckFlow } from "@/components/CheckFlow";

/** One automatic resume per token per page load — a refresh must not stack paid checks. */
const resumedFindTokens = new Set<string>();

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
  const entryNeed =
    variant === "find" && initialNote?.trim()
      ? needFromFindEntry({
          note: initialNote,
          mode: initialMode,
          zip: initialZip,
          distanceMiles: initialDistanceMiles,
        })
      : null;
  const entryStage = entryNeed ? findStageAfterNote(entryNeed) : "need";
  const [mode, setMode] = useState<Mode>(entryNeed?.mode ?? (initialMode === "flip" ? "flip" : "personal"));
  const [text, setText] = useState(initialNote?.trim() ?? "");
  const [budget, setBudget] = useState(entryNeed?.budgetUsd != null ? entryNeed.budgetUsd.toLocaleString("en-US") : "");
  const [budgetKnown, setBudgetKnown] = useState(true);
  /** True once the shopper types Max price on the budget step — never stamp FROM YOUR NOTE. */
  const [budgetFormDirty, setBudgetFormDirty] = useState(false);
  const [need, setNeed] = useState<StructuredNeed | null>(entryNeed);
  const [noteMarks, setNoteMarks] = useState<NoteMarks | null>(entryNeed ? noteMarksFrom(entryNeed) : null);
  const [locationResolution, setLocationResolution] = useState<LocationZipResolution | null>(null);
  const [radiusIsDefault, setRadiusIsDefault] = useState(false);
  const [watchGeoDraft, setWatchGeoDraft] = useState<{
    direction: SearchDirection;
    zip: string;
    distanceMiles: number | null;
  } | null>(null);
  const [source, setSource] = useState<"model" | "form" | null>(entryNeed ? "form" : null);
  const [criteriaParse, setCriteriaParse] = useState<{
    source: "serv" | "code" | "form";
    responseId: string | null;
    label: string;
  } | null>(
    // Local entry parse is code, not form — SERV response id arrives after /api/need.
    entryNeed
      ? { source: "code", responseId: null, label: criteriaParseLabel({ source: "code", responseId: null }) }
      : null,
  );
  const [checks, setChecks] = useState<DecisionProof[]>([]);
  const [proofRecords, setProofRecords] = useState<DecisionProofRecord[]>([]);
  /** Buyer-facing line while a next-check hop is in flight (never a stale spinner sentence). */
  const [pendingCheckLabel, setPendingCheckLabel] = useState<string | null>(null);
  /** Home/deep-link free text used to skip /api/need; fire SERV parse once on entry. */
  const entryServParseRef = useRef(false);
  const [questions, setQuestions] = useState<FollowUp[]>(entryNeed && entryStage === "follow" ? followUps(entryNeed) : []);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<"need" | "budget" | "follow" | "confirm" | "results">(entryStage);
  const [zipDraft, setZipDraft] = useState(entryNeed?.zip ?? initialZip ?? "");
  const [distanceDraft, setDistanceDraft] = useState<number | null>(
    entryNeed ? entryNeed.distanceMiles : initialDistanceMiles === undefined ? null : initialDistanceMiles,
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
  const [yearMin, setYearMin] = useState(entryNeed?.yearMin != null ? String(entryNeed.yearMin) : "");
  const [yearMax, setYearMax] = useState(entryNeed?.yearMax != null ? String(entryNeed.yearMax) : "");
  const [dealRadarUi, setDealRadarUi] = useState(false);
  const [checkKind, setCheckKind] = useState<"link" | "vin">("link");
  const [lookup, setLookup] = useState("");
  const [vinPrice, setVinPrice] = useState("");
  const [vinMiles, setVinMiles] = useState("");
  const [vinZip, setVinZip] = useState("");
  const [checkAllowance, setCheckAllowance] = useState<"loading" | "signed-out" | "missing" | string>(
    "loading",
  );
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
  /** Per-card free public check lines (buyer-visible plain language). */
  const [freeGovEvidenceLines, setFreeGovEvidenceLines] = useState<string[]>([]);
  /** Machine/agent channel only — raw receipts JSON, not shown as page copy. */
  const [freeGovAgentPayload, setFreeGovAgentPayload] = useState<string | null>(null);
  const [bestDeal, setBestDeal] = useState<BestDealResult | null>(null);
  /** True while the server says another automatic check will run. */
  const [findLoopOpen, setFindLoopOpen] = useState(false);
  /** Full search pool for offer ranges. Shown cards are the fallback. */
  const [marketPool, setMarketPool] = useState<ReadinessCar[]>([]);
  const [decisionView, setDecisionView] = useState<{
    entries: FindDecisionLogEntry[];
    labels: DecisionCarLabel[];
  }>({ entries: [], labels: [] });
  const [pickSecondPass, setPickSecondPass] = useState<
    import("@/domain/agent-verdict-schema").AgentSecondPassResult | null
  >(null);
  const [pickAgentVerdict, setPickAgentVerdict] = useState<
    import("@/domain/agent-verdict-schema").AgentVerdict | null
  >(null);
  const [baselineView, setBaselineView] = useState<ReturnType<typeof formatBaselineForBuyer> | null>(null);
  /** Structured free-gov receipts for risk-aware grounded shortlist (client mirror of server). */
  const [freeGovReceiptsForShortlist, setFreeGovReceiptsForShortlist] = useState<
    FreeGovReceiptUiRow[]
  >([]);
  const [riskCoverageNote, setRiskCoverageNote] = useState<string | null>(null);
  const [freeGovAnyUnchecked, setFreeGovAnyUnchecked] = useState(false);
  /** Fuel-specific pending — not the same as anyUnchecked (recalls/safety/vpic may still run). */
  const [fuelCheckPending, setFuelCheckPending] = useState(false);
  const [fuelCheckOutcome, setFuelCheckOutcome] = useState<ReturnType<
    typeof summarizeFuelCheckOutcome
  > | null>(null);
  /** Auto-start next-check once per searchContextToken when SERV keyed. */
  const autoNextCheckTokenRef = useRef<string | null>(null);
  /** Blocks a second Show-cars click before React disables the button. */
  const findSubmitLock = useRef(false);
  /** Reused until a Find response is received, so a lost response is not a second purchase. */
  const findIdempotencyKey = useRef<string | null>(null);
  /** Auto-continues fired for the current search token — hard-bounded in shouldAutoContinue. */
  const autoContinueCountRef = useRef(0);

  useEffect(() => {
    if (variant !== "find") return;
    let cancelled = false;
    fetch("/api/product-flags")
      .then((response) => response.json())
      .then((body: { flags?: { dealRadar?: boolean } }) => {
        if (!cancelled) setDealRadarUi(body.flags?.dealRadar === true);
      })
      .catch(() => {
        if (!cancelled) setDealRadarUi(false);
      });
    return () => {
      cancelled = true;
    };
  }, [variant]);

  // Root cause (a): home/deep-link notes that already clear budget/follow-ups jumped
  // straight to confirm with empty checks and no SERV response id ("prompt guard …
  // not recorded"). Budget/follow entry still hits /api/need on Continue.
  useEffect(() => {
    if (variant !== "find" || !initialNote?.trim()) return;
    if (entryStage !== "confirm") return;
    if (entryServParseRef.current) return;
    entryServParseRef.current = true;
    void understand(undefined, { freshNote: true });
    // understand closes over latest drafts; run once per confirm-entry note only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, initialNote, entryStage]);

  useEffect(() => {
    if (variant !== "check") return;
    let cancelled = false;
    fetch("/api/account")
      .then((response) => response.json())
      .then((body: { authenticated?: boolean; freeChecks?: { remaining?: number; limit?: number; resetsLabel?: string } | null }) => {
        if (!cancelled) setCheckAllowance(freeChecksRemainingFromAccount(body));
      })
      .catch(() => {
        if (!cancelled) setCheckAllowance("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [variant]);

  async function understand(
    followUp?: { id: FollowUp["id"]; value: string },
    opts?: { freshNote?: boolean },
  ) {
    setError(null);
    // Fresh free text: never send stale wizard ZIP/radius — server resolves from the note.
    const zipForNeed = opts?.freshNote ? null : zipDraft.trim() || need?.zip || null;
    const distanceForNeed = opts?.freshNote ? null : distanceDraft;
    if (distanceForNeed != null && !zipForNeed) {
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
          distanceMiles: distanceForNeed,
          repairAbility: opts?.freshNote ? undefined : need?.repairAbility,
          useCase: opts?.freshNote ? undefined : need?.useCase,
          targetProfitUsd: opts?.freshNote ? undefined : need?.targetProfitUsd,
          followUp,
        }),
      });
      const body = (await response.json()) as {
        source?: "model" | "form";
        need?: StructuredNeed;
        followUps?: FollowUp[];
        checks?: DecisionProof[];
        message?: string;
        guard?: string;
        criteriaParse?: { source: "serv" | "code" | "form"; responseId: string | null; label: string };
      };
      if (!response.ok || !body.need) {
        setError(body.message || "That note could not be read.");
        return;
      }
      const finalNeed = body.need;
      // Provenance from the note text only — never treat a city-resolved ZIP as “from your note”.
      const intake = intakeFromNote(text);
      const loc = resolveLocationZip({
        zip: intake.zip,
        locationPhrase: finalNeed.locationPhrase ?? intake.locationPhrase,
      });
      const resolutionForField =
        loc.from === "inferred_from_city" && finalNeed.zip
          ? { ...loc, zip: finalNeed.zip }
          : loc.needed && !finalNeed.zip
            ? loc
            : intake.zip && finalNeed.zip === intake.zip
              ? loc
              : finalNeed.zip
                ? ({
                    zip: finalNeed.zip,
                    from: null,
                    needed: false,
                    cityLabel: finalNeed.locationPhrase ?? null,
                  } satisfies LocationZipResolution)
                : finalNeed.locationPhrase
                  ? ({
                      zip: null,
                      from: null,
                      needed: true,
                      cityLabel: finalNeed.locationPhrase,
                    } satisfies LocationZipResolution)
                  : null;
      setNeed(finalNeed);
      {
        const marks = noteMarksFrom(finalNeed, text);
        // Typed Max price on the budget form wins over note extraction.
        if (budgetFormDirty) marks.budget = false;
        setNoteMarks(marks);
      }
      setLocationResolution(resolutionForField);
      // Labelled default when server set 100 mi from a city/ZIP with no explicit “within N miles”.
      setRadiusIsDefault(
        Boolean(
          finalNeed.zip &&
            finalNeed.distanceMiles === NOTE_DEFAULT_RADIUS_WHEN_ZIP &&
            (finalNeed.locationPhrase || loc.from === "inferred_from_city") &&
            !/\bwithin\s+\d+/i.test(text),
        ),
      );
      setZipDraft(finalNeed.zip ?? "");
      setDistanceDraft(finalNeed.distanceMiles);
      if (finalNeed.yearMin != null) setYearMin(String(finalNeed.yearMin));
      if (finalNeed.yearMax != null) setYearMax(String(finalNeed.yearMax));
      if (finalNeed.budgetUsd != null) setBudget(finalNeed.budgetUsd.toLocaleString("en-US"));
      setBudgetKnown(finalNeed.budgetKnown);
      setSource(body.source ?? "form");
      const parse =
        body.criteriaParse ??
        (body.source === "model"
          ? { source: "serv" as const, responseId: null, label: criteriaParseLabel({ source: "serv", responseId: null }) }
          : text.trim()
            ? { source: "code" as const, responseId: null, label: "Parsed by code" }
            : { source: "form" as const, responseId: null, label: "Entered on the form" });
      setCriteriaParse(parse);
      setChecks(body.checks ?? []);
      if (Array.isArray((body as { proofRecords?: DecisionProofRecord[] }).proofRecords)) {
        setProofRecords((body as { proofRecords: DecisionProofRecord[] }).proofRecords);
      }
      if ((body.checks ?? []).length === 0 && body.guard === "unavailable") {
        setError("The safety check on your note did not finish. You can continue with the calculated reading.");
      }
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
        criteriaParse?: { source: "serv" | "code" | "form"; responseId: string | null; label: string };
        affordability?: boolean;
        sample?: boolean;
        matchMessage?: string | null;
        matchScope?: string | null;
        emptyReason?: FindEmptyReason | null;
        matchHeadline?: string | null;
        matchNextStep?: string | null;
        partialFailure?: boolean;
        searchContextToken?: string | null;
        servNextCheckEnabled?: boolean;
        marketPool?: unknown;
      };
      if (!saved.need || !saved.stage || saved.stage === "need") return;

      const decision = decideAfFlowRestore(saved);
      const groups = saved.groups ?? [];
      if (decision.action === "drop_results") {
        sessionStorage.removeItem("af-flow");
        setNeed(saved.need);
        setStage("confirm");
        setGroups([]);
        setMarketPool([]);
        setSample(false);
        setMatchMessage(decision.reason);
        if (saved.need.budgetUsd) setBudget(String(saved.need.budgetUsd));
        if (saved.need.zip) setZipDraft(saved.need.zip);
        if (saved.criteriaParse) setCriteriaParse(saved.criteriaParse);
        if (saved.checks) setChecks(saved.checks);
        return;
      }

      setNeed(saved.need);
      setStage(saved.stage);
      setGroups(groups);
      setMarketPool(readinessCarsFromUnknown(saved.marketPool));
      setSource(saved.source ?? "form");
      setChecks(saved.checks ?? []);
      if (saved.criteriaParse) setCriteriaParse(saved.criteriaParse);
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
      const resume = resumeFindSearchFromFlow(saved);
      if (resume.searchContextToken) {
        setSearchContextToken(resume.searchContextToken);
        setServNextCheckEnabled(resume.servNextCheckEnabled);
        let loopSettled = false;
        try {
          const rawLoop = sessionStorage.getItem("af-find-loop");
          if (rawLoop) {
            const parsed = JSON.parse(rawLoop) as { token?: string; settled?: boolean };
            loopSettled = parsed.token === resume.searchContextToken && parsed.settled === true;
          }
        } catch {
          loopSettled = false;
        }
        if (
          shouldResumeFindLoop({
            stage: saved.stage ?? "",
            servEnabled: resume.servNextCheckEnabled,
            token: resume.searchContextToken,
            alreadyResumed: resumedFindTokens.has(resume.searchContextToken),
            loopSettled,
          })
        ) {
          const token = resume.searchContextToken;
          resumedFindTokens.add(token);
          autoNextCheckTokenRef.current = token;
          queueMicrotask(() => {
            void applyLiveNextCheck({ token, auto: true });
          });
        }
      }
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
          criteriaParse,
          affordability,
          sample,
          matchMessage,
          matchScope,
          emptyReason,
          searchContextToken,
          servNextCheckEnabled,
          marketPool,
        }),
      );
    } catch {
      /* the browser may block storage */
    }
  }

  async function answerFollowUps() {
    if (!need) return;
    setError(null);
    // Apply every answer locally first so null/no-floor ("any") resolves before any network hop.
    let current = need;
    for (const question of questions) {
      const value = answers[question.id]?.trim();
      if (!value) {
        setError("Answer the question, or go back and add it to your note.");
        return;
      }
      current = applyFollowUp(current, question.id, value);
    }
    // Unanswered soft prompts must not deadlock Continue; explicit no-floor must clear age.
    const stillOpen = followUps(current);
    if (stillOpen.length > 0) {
      setError("Answer every clarification, or go back and add it to your note.");
      setQuestions(stillOpen);
      return;
    }
    setPending("need");
    try {
      // One sync round-trip carrying prior resolutions (yearBandResolved / condition / miles).
      const response = await fetch("/api/need", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          mode: current.mode,
          budgetUsd: current.budgetUsd,
          budgetKnown: current.budgetKnown,
          budgetScope: current.budgetScope,
          zip: current.zip,
          distanceMiles: current.distanceMiles,
          repairAbility: current.repairAbility,
          useCase: current.useCase,
          targetProfitUsd: current.targetProfitUsd,
          yearMin: current.yearMin,
          yearMax: current.yearMax,
          yearBandResolved: current.yearBandResolved,
          milesMax: current.milesMax,
          milesCapResolved: current.milesCapResolved,
          conditionPriority: current.conditionPriority,
        }),
      });
      const body = (await response.json()) as {
        need?: StructuredNeed;
        followUps?: FollowUp[];
        message?: string;
        checks?: DecisionProof[];
        criteriaParse?: { source: "serv" | "code" | "form"; responseId: string | null; label: string };
        source?: "model" | "form";
      };
      if (!response.ok || !body.need) {
        setError(body.message || "That answer could not be saved.");
        return;
      }
      // Re-apply local resolutions in case extract/overlay dropped null floors.
      current = {
        ...body.need,
        yearMin: current.yearMin,
        yearMax: current.yearMax,
        yearBandResolved: current.yearBandResolved || body.need.yearBandResolved,
        milesMax: current.milesMax,
        milesCapResolved: current.milesCapResolved || body.need.milesCapResolved,
        conditionPriority:
          current.conditionPriority !== "unspecified"
            ? current.conditionPriority
            : body.need.conditionPriority,
      };
      if (Array.isArray(body.checks)) setChecks(body.checks);
      if (Array.isArray((body as { proofRecords?: DecisionProofRecord[] }).proofRecords)) {
        setProofRecords((body as { proofRecords: DecisionProofRecord[] }).proofRecords);
      }
      if (body.criteriaParse) setCriteriaParse(body.criteriaParse);
      else if (body.source) {
        setCriteriaParse(
          body.source === "model"
            ? { source: "serv", responseId: null, label: criteriaParseLabel({ source: "serv", responseId: null }) }
            : { source: "code", responseId: null, label: "Parsed by code" },
        );
      }
      if (body.source) setSource(body.source);
      if (followUps(current).length > 0) {
        setNeed(current);
        setQuestions(followUps(current));
        setError("Answer every clarification, or go back and add it to your note.");
        return;
      }
      setNeed(current);
      setNoteMarks(noteMarksFrom(current, text));
      if (current.yearMin != null) setYearMin(String(current.yearMin));
      if (current.yearMax != null) setYearMax(String(current.yearMax));
      setQuestions([]);
      setStage("confirm");
    } catch {
      setError("The request did not finish.");
    } finally {
      setPending(null);
    }
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
    setPendingCheckLabel(findNextCheckPendingLabel({ pending: true, auto: Boolean(opts?.auto) }));
    let continueToken: string | null = null;
    // Count this hop when it was triggered by auto-continue/auto-start chain.
    if (opts?.auto) autoContinueCountRef.current += 1;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 70_000);
    try {
      const response = await fetch("/api/find/next-check", {
        method: "POST",
        signal: controller.signal,
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
        setFindLoopOpen(false);
        const reason =
          body.message ||
          body.loop?.detail ||
          body.honesty ||
          "Next check could not be applied.";
        setPendingCheckLabel(findNextCheckPendingLabel({ pending: false, terminalReason: reason }));
        setError(reason);
        setNextCheckNote(reason);
        return;
      }
      const pickProofs = Array.isArray(
        (body as { pickProofRecords?: DecisionProofRecord[] }).pickProofRecords,
      )
        ? ((body as { pickProofRecords?: DecisionProofRecord[] }).pickProofRecords as DecisionProofRecord[])
        : [];
      const nextCheckProofs = Array.isArray(
        (body as { nextCheckProofRecords?: DecisionProofRecord[] }).nextCheckProofRecords,
      )
        ? ((body as { nextCheckProofRecords?: DecisionProofRecord[] }).nextCheckProofRecords as DecisionProofRecord[])
        : [];
      if (pickProofs.length > 0 || nextCheckProofs.length > 0) {
        setProofRecords((prev) => [...prev, ...nextCheckProofs, ...pickProofs]);
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
      const freeNote =
        typeof (body as { freeEvidenceNote?: string | null }).freeEvidenceNote === "string"
          ? (body as { freeEvidenceNote?: string }).freeEvidenceNote
          : null;
      const clamp = (body as {
        clampDiag?: {
          deniedCheckId?: string | null;
          allowlistIds?: string[];
          aliasApplied?: string | null;
        } | null;
      }).clampDiag;
      const receipts = Array.isArray((body as { freeGovReceipts?: FreeGovReceiptUiRow[] }).freeGovReceipts)
        ? ((body as { freeGovReceipts?: FreeGovReceiptUiRow[] }).freeGovReceipts as FreeGovReceiptUiRow[])
        : [];
      const serverBestDeal = (body as { bestDeal?: BestDealResult | null }).bestDeal;
      const serverBaseline = (body as { baseline?: FindBaselineDelta | null }).baseline ?? serverBestDeal?.baseline ?? null;
      if (serverBestDeal && typeof serverBestDeal === "object") {
        setBestDeal(serverBestDeal);
      }
      if (serverBaseline && typeof serverBaseline === "object") {
        setBaselineView(formatBaselineForBuyer(serverBaseline));
      }
      const serverLog = (body as { decisionLog?: FindDecisionLogEntry[] }).decisionLog;
      if (Array.isArray(serverLog)) {
        const labels = [
          ...(serverBestDeal?.allRanked ?? serverBestDeal?.ranked ?? []).map((car) => ({
            key: car.key,
            year: car.year,
            make: car.make,
            model: car.model,
            trim: car.trim ?? null,
            priceUsd: car.priceUsd,
            miles: car.miles,
            city: car.city ?? null,
            state: car.state ?? null,
            dealer: car.dealer ?? null,
          })),
        ];
        setDecisionView({ entries: serverLog, labels });
      }
      const settlePass = (body as { pickSecondPass?: import("@/domain/agent-verdict-schema").AgentSecondPassResult | null })
        .pickSecondPass;
      if (settlePass && typeof settlePass === "object") setPickSecondPass(settlePass);
      const settleVerdict = (body as { pickAgentVerdict?: import("@/domain/agent-verdict-schema").AgentVerdict | null })
        .pickAgentVerdict;
      if (settleVerdict && typeof settleVerdict === "object") setPickAgentVerdict(settleVerdict);
      if (receipts.length > 0) {
        setFreeGovReceiptsForShortlist(receipts);
        // Buyer-visible plain lines; raw receipts only in machine/agent channel.
        setFreeGovEvidenceLines(formatFreeGovReceiptsForUi(receipts));
        setFreeGovAgentPayload(formatFreeGovReceiptsForAgents(receipts, serverBaseline));
      }
      const coverage = (body as { riskCoverage?: { note?: string } | null }).riskCoverage;
      const toolCov = (
        body as {
          freeGovCoverage?: {
            note?: string;
            anyUnchecked?: boolean;
            fuel?: { unchecked?: number; checked?: number; eligible?: number };
          } | null;
        }
      ).freeGovCoverage;
      if (toolCov && typeof toolCov.anyUnchecked === "boolean") {
        setFreeGovAnyUnchecked(toolCov.anyUnchecked);
      }
      if (toolCov?.fuel && typeof toolCov.fuel.unchecked === "number") {
        setFuelCheckPending(toolCov.fuel.unchecked > 0);
      } else if (toolCov && toolCov.anyUnchecked === false) {
        setFuelCheckPending(false);
      }
      // Soft-scrub technical coverage notes for buyers (never garble NMVTIS-approved).
      const scrubCoverage = (note: string) =>
        note
          .replace(/\bMMY\b/g, "year/make/model")
          .replace(/\bvPIC\b/g, "VIN decode")
          .replace(
            /\bNMVTIS-approved history\s*\+\s*inspection before purchase\b/gi,
            "an NMVTIS-approved vehicle history report and a pre-purchase inspection before you buy",
          )
          .replace(/\bNMVTIS\b/g, "NMVTIS (official title history)")
          .trim();
      // Prefer one plain coverage sentence — avoid duplicating year/make/model jargon.
      const toolNote =
        toolCov && typeof toolCov.note === "string" && toolCov.note.trim()
          ? scrubCoverage(toolCov.note)
          : "";
      const riskNote =
        coverage && typeof coverage.note === "string" && coverage.note.trim()
          ? scrubCoverage(coverage.note)
          : "";
      const coverageBits = toolNote
        ? riskNote && !toolNote.includes(riskNote.slice(0, 40)) && riskNote.length > 0
          ? [toolNote, riskNote]
          : [toolNote]
        : riskNote
          ? [riskNote]
          : [];
      if (coverageBits.length > 0) {
        setRiskCoverageNote(coverageBits.join(" "));
      }
      void freeNote;
      void failCat;
      void failCode;
      void clamp;
      void keyedDiag;
      const listingCount = groups.reduce((n, g) => n + g.listings.length, 0);
      const mergedReceiptsForFuel =
        receipts.length > 0 ? receipts : freeGovReceiptsForShortlist;
      // Always summarize cumulative fuel receipts so the checklist reflects final outcomes
      // even when the latest step was recalls/safety (not free_gov_fuel).
      const fuelOutcome = summarizeFuelCheckOutcome(uiRowsToRiskReceipts(mergedReceiptsForFuel));
      const nextFuelOutcome = fuelOutcome.attempted > 0 ? fuelOutcome : null;
      if (nextFuelOutcome) setFuelCheckOutcome(nextFuelOutcome);
      const recallOutcome = summarizeRecallCheckOutcome(uiRowsToRiskReceipts(mergedReceiptsForFuel));
      const fuelPending =
        toolCov?.fuel && typeof toolCov.fuel.unchecked === "number"
          ? toolCov.fuel.unchecked > 0
          : false;
      const step = formatBuyerLoopStep({
        chosenId: body.chosenId ?? "",
        listingCount: listingCount || undefined,
        fuelOutcome: nextFuelOutcome ?? undefined,
        fuelPending: body.chosenId === "free_gov_fuel" ? fuelPending : undefined,
        recallOutcome: body.chosenId === "free_gov_recalls" ? recallOutcome : undefined,
      });
      const status = formatBuyerLoopStatus(body.loop?.reason ?? null);
      const willContinue = shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: servNextCheckEnabled || Boolean(opts?.auto),
        autonomousServ: Boolean(body.autonomousServ),
        searchContextToken: nextTok,
        autoContinueCount: autoContinueCountRef.current,
        loop: body.loop
          ? { continue: Boolean(body.loop.continue), reason: body.loop.reason ?? "" }
          : null,
      });
      const shortlistEmpty = !(serverBestDeal?.ranked?.length);
      const settleBit = toolCov
        ? buyerCheckActivityLine({
            anyUnchecked: Boolean(toolCov.anyUnchecked),
            continuing: willContinue,
            shortlistEmpty,
          })
        : null;
      // Drop contradictory “not running” + “caught up/stopped” pairs when unchecked remain.
      const progressParts = [step, status, settleBit].filter(Boolean) as string[];
      const progressLine =
        toolCov?.anyUnchecked && status && /stopped on the current evidence|caught up/i.test(status)
          ? progressParts.filter((part) => part !== status).join(" ")
          : progressParts.join(" ");
      setNextCheckNote(progressLine);
      setPendingCheckLabel(
        findNextCheckPendingLabel({ pending: true, auto: Boolean(opts?.auto), progressLine }),
      );
      setFindLoopOpen(Boolean(body.loop?.continue));
      const checksSettled = body.loop?.continue === false && toolCov?.anyUnchecked !== true;
      try {
        sessionStorage.setItem(
          "af-find-loop",
          JSON.stringify({ token: nextTok, settled: checksSettled }),
        );
      } catch {
        /* ignore */
      }
      if (willContinue) {
        continueToken = nextTok;
      } else {
        // No further auto hops — clear the “still checking” spinner state.
        setFindLoopOpen(false);
        setPendingCheckLabel(null);
        if (
          body.loop?.continue &&
          autoContinueCountRef.current >= FIND_NEXT_CHECK_AUTO_CONTINUE_MAX &&
          toolCov?.anyUnchecked
        ) {
          // Bound hit — settle the spinner honestly rather than looping forever.
          const pauseReason =
            "Automatic public checks paused after many steps. Some models may still be unchecked. Nothing else is running.";
          setNextCheckNote((prev) => [prev, pauseReason].filter(Boolean).join(" "));
        } else if (body.loop?.continue === false && body.loop?.detail) {
          setNextCheckNote((prev) => [prev, body.loop?.detail].filter(Boolean).join(" "));
        }
      }

      // Prefer server rematch (NEW need). Fallback client rematch uses replan only — never yearMin UI state.
      if (body.research && body.rematch?.body) {
        const matchBody = body.rematch.body;
        if (!body.rematch.ok) {
          const reason = matchBody.emptyReason ?? "provider_failure";
          const copy = findEmptyCopy(reason, nextNeed, matchBody.message);
          setFindLoopOpen(false);
          setPendingCheckLabel(null);
          setError(copy.detail);
          setNextCheckNote(copy.detail);
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
        const rematchPool = readinessCarsFromUnknown((matchBody as { compsPool?: unknown }).compsPool);
        setMarketPool(
          rematchPool.length > 0
            ? rematchPool
            : readinessCarsFromUnknown(nextGroups.flatMap((group) => group.listings)),
        );
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
              // Owned continuation — next-check rematch is not a second Find purchase.
              searchContextToken: nextTok,
              refine: rematchRefineFromReplan({
                replanRefine: body.replan.refine,
                needAfter: nextNeed,
                uiYearMin: yearMin,
                uiYearMax: yearMax,
              }),
            }),
          });
          const matchBody = (await matchResponse.json()) as {
            balance?: number;
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
            error?: string;
          };
          if (typeof matchBody.balance === "number") publishCreditBalance(matchBody.balance);
          else void refreshPublishedCreditBalance();
          if (
            matchResponse.status === 401 ||
            (matchResponse.status === 403 &&
              (matchBody.error === "auth_required" ||
                matchBody.error === "auth_unconfigured" ||
                matchBody.error === "email_unverified" ||
                matchBody.error === "email_required"))
          ) {
            rememberFlow();
            router.push(`/login?callbackUrl=${encodeURIComponent("/find")}`);
            return;
          }
          if (matchResponse.status === 403 && matchBody.error === "credits_required") {
            rememberFlow();
            router.push("/credits?need=1&return=%2Ffind");
            return;
          }
          if (matchBody.error === "auth_unconfigured" || matchBody.error === "money_store_unconfigured") {
            const plain = buyerFacingFailure(matchBody.error, null, "Sign-in is not available yet.");
            setError(plain);
            setMatchMessage(plain);
            setGroups([]);
            return;
          }
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
    } catch (err) {
      setFindLoopOpen(false);
      setPendingCheckLabel(null);
      const timedOut = err instanceof DOMException && err.name === "AbortError";
      const reason = timedOut
        ? "That check took too long, so it stopped. Nothing is running now. You can try again."
        : "Next check failed — try again.";
      setError(reason);
      setNextCheckNote(reason);
    } finally {
      window.clearTimeout(timer);
      setPending(null);
      if (!continueToken) setPendingCheckLabel(null);
    }
    // Continue loop after pending clears — evidence→replan until server stop reason.
    if (continueToken) {
      void applyLiveNextCheck({ token: continueToken, auto: true });
    }
  }

  async function findCars() {
    if (!need) return;
    // Geography: a radius still needs a ZIP. ZIP with no radius is allowed — Nationwide
    // (results can still sort by distance when ZIP is present). Never dead-end on Confirm.
    if (need.distanceMiles != null && !need.zip) {
      setError("Add a ZIP for a seller-distance radius, or choose Nationwide.");
      return;
    }
    // "near me" without a city/ZIP: ZIP is optional — blank continues nationwide.
    if (
      need.distanceMiles == null &&
      !need.zip &&
      (need.locationPhrase || noteMarks?.location) &&
      !isNearMePhrase(need.locationPhrase)
    ) {
      setError(
        `Your note mentioned ${need.locationPhrase ?? "a place"}. Add a U.S. ZIP to search nearby, or leave ZIP blank for Nationwide.`,
      );
      return;
    }
    if (findSubmitLock.current) return;
    findSubmitLock.current = true;
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
      let searchIdempotencyKey = findIdempotencyKey.current;
      if (!searchIdempotencyKey) {
        try {
          const stored = sessionStorage.getItem("af-find-idem");
          if (stored && /^[a-zA-Z0-9_-]{8,80}$/.test(stored)) searchIdempotencyKey = stored;
        } catch {
          /* ignore */
        }
      }
      if (!searchIdempotencyKey) {
        searchIdempotencyKey = `find-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      }
      findIdempotencyKey.current = searchIdempotencyKey;
      try {
        sessionStorage.setItem("af-find-idem", searchIdempotencyKey);
      } catch {
        /* ignore */
      }
      const response = await fetch("/api/match", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          need,
          searchIdempotencyKey,
          refine: {
            make: make.trim() || undefined,
            model: model.trim() || undefined,
            yearMin: yearMin ? Number(yearMin) : need.yearMin ?? undefined,
            yearMax: yearMax ? Number(yearMax) : need.yearMax ?? undefined,
          },
        }),
      });
      const body = (await response.json()) as {
        balance?: number;
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
        compsPool?: unknown;
        error?: string;
      };
      if (typeof body.balance === "number") publishCreditBalance(body.balance);
      else void refreshPublishedCreditBalance();
      if (
        response.status === 401 ||
        (response.status === 403 &&
          (body.error === "auth_required" ||
            body.error === "auth_unconfigured" ||
            body.error === "email_unverified" ||
            body.error === "email_required"))
      ) {
        rememberFlow();
        router.push(`/login?callbackUrl=${encodeURIComponent("/find")}`);
        return;
      }
      if (response.status === 403 && body.error === "credits_required") {
        rememberFlow();
        router.push("/credits?need=1&return=%2Ffind");
        return;
      }
      if (body.error === "auth_unconfigured" || body.error === "money_store_unconfigured") {
        const plain = buyerFacingFailure(body.error, null, "Sign-in is not available yet.");
        setError(plain);
        setMatchMessage(plain);
        setStage("results");
        setGroups([]);
        setSample(false);
        return;
      }
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
      findIdempotencyKey.current = null;
      try {
        sessionStorage.removeItem("af-find-idem");
      } catch {
        /* ignore */
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
      const matchedPool = readinessCarsFromUnknown(body.compsPool);
      setMarketPool(
        matchedPool.length > 0
          ? matchedPool
          : readinessCarsFromUnknown(nextGroups.flatMap((group) => group.listings)),
      );
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
      // Clear prior search's free-gov / best-deal state so a new Find cannot inherit
      // a stuck "still checking" banner or stale provisional pick.
      setBestDeal(null);
      setFindLoopOpen(false);
      setDecisionView({ entries: [], labels: [] });
      setPickSecondPass(null);
      setPickAgentVerdict(null);
      setBaselineView(null);
      setFreeGovReceiptsForShortlist([]);
      setFreeGovEvidenceLines([]);
      setFreeGovAgentPayload(null);
      setRiskCoverageNote(null);
      setFreeGovAnyUnchecked(false);
      setFuelCheckPending(false);
      setFuelCheckOutcome(null);
      setNextCheckNote(null);
      autoContinueCountRef.current = 0;
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
            marketPool: matchedPool.length > 0 ? matchedPool : readinessCarsFromUnknown(nextGroups.flatMap((group) => group.listings)),
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
      findSubmitLock.current = false;
      window.clearTimeout(timer);
      setPending(null);
    }
    if (autoNextToken) {
      void applyLiveNextCheck({ token: autoNextToken, auto: true });
    }
  }

  async function watch(
    direction: SearchDirection,
    geoOverride?: { zip: string; distanceMiles: number | null },
  ) {
    if (!dealRadarUi || !need) return;
    const zip = (geoOverride?.zip ?? need.zip ?? "").trim();
    const distanceMiles =
      geoOverride?.distanceMiles !== undefined ? geoOverride.distanceMiles : need.distanceMiles;
    // Drive-it watches need ZIP + radius. Open an inline picker instead of a dead-end error.
    if (need.mode !== "flip" && (!zip || distanceMiles == null)) {
      setError(null);
      setWatchGeoDraft({
        direction,
        zip: zip || zipDraft || "",
        distanceMiles: distanceMiles ?? NOTE_DEFAULT_RADIUS_WHEN_ZIP,
      });
      return;
    }
    if (need.mode === "flip" && distanceMiles != null && !zip) {
      setError("A Flip watch with a radius needs a ZIP, or leave radius empty for nationwide.");
      return;
    }
    setPending(direction.id);
    setWatchGeoDraft(null);
    try {
      const priceMax = need.budgetKnown && need.budgetUsd ? need.budgetUsd : 40_000;
      const freeText = (need.note?.trim() || text.trim() || "").slice(0, 500) || undefined;
      const parse = criteriaParse ?? { source: "form" as const, responseId: null };
      const originSearchId = searchContextToken?.slice(0, 80) || null;
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
                  zip: zip || "",
                  radiusMiles: distanceMiles,
                  nationwide: distanceMiles == null || undefined,
                  repairAbility: need.repairAbility,
                  minProfitUsd: need.targetProfitUsd ?? undefined,
                  bodyStyle: need.bodyStyle ?? undefined,
                  make: need.preferredMakes[0] ?? need.make ?? undefined,
                  preferredMakes: need.preferredMakes,
                  models: direction.models.slice(0, 6),
                  yearMin: direction.yearMin ?? need.yearMin ?? undefined,
                  yearMax: direction.yearMax ?? need.yearMax ?? undefined,
                  milesMax: need.milesMax ?? undefined,
                  freeText,
                  notes: freeText,
                  criteriaParseSource: parse.source,
                  criteriaResponseId: parse.responseId,
                  criteriaOrigin: "find",
                  originSearchId,
                }
              : {
                  models: direction.models.slice(0, 6),
                  yearMin: direction.yearMin,
                  yearMax: direction.yearMax,
                  priceMax,
                  zip,
                  radiusMiles: distanceMiles,
                  milesMax: need.milesMax ?? undefined,
                  bodyStyle: need.bodyStyle ?? undefined,
                  priorities: need.priorities?.length ? need.priorities : undefined,
                  freeText,
                  notes: freeText,
                  criteriaParseSource: parse.source,
                  criteriaResponseId: parse.responseId,
                  criteriaOrigin: "find",
                  originSearchId,
                },
        }),
      });
      const body = (await response.json()) as { message?: string; error?: string; redirect?: string };
      if (!response.ok) {
        if (body.error === "plan_required" || response.status === 402) {
          router.push(body.redirect || "/pricing?from=watch");
          return;
        }
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
        setError(buyerFacingFailure(body.error, body.message, "The report could not be built."));
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
      const body = (await response.json()) as {
        title?: string;
        badge?: PriceBadge;
        reasons?: string[];
        coverage?: string;
        coverageLevel?: "low" | "medium" | "high";
        sample?: boolean;
        message?: string;
        error?: string;
      };
      if (response.status === 401 || response.status === 403) {
        if (body.error === "auth_required" || body.error === "auth_unconfigured" || body.error === "email_unverified") {
          sessionStorage.setItem("af-check", JSON.stringify({ mode, checkKind, lookup, vinPrice, vinMiles, vinZip }));
          router.push(`/login?callbackUrl=${encodeURIComponent("/check")}`);
          return;
        }
      }
      if (!response.ok || !body.badge || !body.title) {
        setError(buyerFacingFailure(body.error, body.message, "The price check did not finish."));
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
      const freeChecks = (body as { freeChecks?: { remaining?: number; limit?: number; resetsLabel?: string } | null })
        .freeChecks;
      if (
        freeChecks &&
        typeof freeChecks.remaining === "number" &&
        typeof freeChecks.limit === "number" &&
        typeof freeChecks.resetsLabel === "string"
      ) {
        setCheckAllowance(
          freeChecksRemainingFromAccount({
            authenticated: true,
            freeChecks: {
              remaining: freeChecks.remaining,
              limit: freeChecks.limit,
              resetsLabel: freeChecks.resetsLabel,
            },
          }),
        );
      } else {
        try {
          const account = (await fetch("/api/account", { cache: "no-store" }).then((r) => r.json())) as {
            authenticated?: boolean;
            freeChecks?: { remaining?: number; limit?: number; resetsLabel?: string } | null;
          };
          setCheckAllowance(freeChecksRemainingFromAccount(account));
        } catch {
          /* keep prior counter */
        }
      }
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
      if (response.status === 401 || (response.status === 403 && (body.error === "auth_required" || body.error === "auth_unconfigured" || body.error === "email_unverified" || body.error === "email_required"))) {
        sessionStorage.setItem("af-check", JSON.stringify({ mode, checkKind, lookup, vinPrice, vinMiles, vinZip }));
        router.push(`/login?callbackUrl=${encodeURIComponent("/check")}`);
        return;
      }
      if (response.status === 403 && body.error === "credits_required") {
        sessionStorage.setItem("af-check", JSON.stringify({ mode, checkKind, lookup, vinPrice, vinMiles, vinZip }));
        router.push("/credits?need=1&return=%2Fcheck");
        return;
      }
      if (!response.ok || !body.id) {
        setError(buyerFacingFailure(body.error, body.message, "The report could not be built."));
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
            // New free text resets stale wizard geo / session — SERV parse runs next.
            try {
              sessionStorage.removeItem("af-flow");
            } catch {
              /* ignore */
            }
            setNeed(null);
            setNoteMarks(null);
            setLocationResolution(null);
            setRadiusIsDefault(false);
            setZipDraft("");
            setDistanceDraft(null);
            setChecks([]);
            setProofRecords([]);
            setPendingCheckLabel(null);
            setCriteriaParse(null);
            setSource(null);
            setGroups([]);
            setBestDeal(null);
            setPickAgentVerdict(null);
            setPickSecondPass(null);
            setFindLoopOpen(false);
            const parsed = explicitNeedFromText(text, mode);
            if (parsed.budgetUsd != null) {
              setBudget(parsed.budgetUsd.toLocaleString("en-US"));
              setBudgetKnown(true);
            }
            void understand(undefined, { freshNote: true });
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
            <button className="action" type="submit" disabled={text.trim().length < 8 || pending === "need"}>
              {pending === "need" ? "Reading…" : "Continue"}
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
            <input
              id="budget"
              value={budget}
              onChange={(event) => {
                setBudgetFormDirty(true);
                setBudget(event.target.value);
              }}
              inputMode="decimal"
              disabled={!budgetKnown}
              placeholder="e.g. 18000"
            />
            <label className="check-line" htmlFor="budget-unknown">
              <input
                id="budget-unknown"
                type="checkbox"
                checked={!budgetKnown}
                onChange={(event) => setBudgetKnown(!event.target.checked)}
              />
              Not sure yet
            </label>
          </div>
          {!budgetKnown && budgetFromText(text) != null ? (
            <p className="hint">
              {budgetWorkingCopy({
                budgetKnown: true,
                budgetUsd: budgetFromText(text),
                note: text,
              })}
            </p>
          ) : null}
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
          <p className="hint">{need?.mode === "flip" ? "These answers change the reconditioning assumption and the profit target. They are not a quote." : FOLLOW_HINT}</p>
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
          {error ? (
            <p className="warn" role="alert">
              {error}
            </p>
          ) : null}
          <div className="btn-row">
            <button className="ghost" type="button" onClick={goBack}>
              Back
            </button>
            <button className="action" type="submit" disabled={pending === "need"}>
              {pending === "need" ? "Saving…" : "Continue"}
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
              : need.zip && need.distanceMiles == null
                ? "This is only what you typed and the words we could match. Your ZIP has no radius — search runs Nationwide (sorted by distance to that ZIP when the feed provides it). Pick miles below to narrow, or leave Nationwide. We did not invent a default radius."
                : "This is only what you typed and the words we could match. Nothing was invented."}
          </p>
          <div className="field">
            <label htmlFor="note">Your note</label>
            <textarea id="note" rows={3} value={need.note} onChange={(event) => setNeed({ ...need, note: event.target.value })} />
          </div>
          <NoteFactChips need={need} onChange={setNeed} />
          {intentSummaryFromNeed(need).length > 0 ? (
            <div className="onboarding-note" aria-label="What we will search">
              <p className="kicker">What we will search</p>
              <ul className="refuse">
                {intentSummaryFromNeed(need).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {need.mode === "flip" ? (
            <p className="hint">
              Profit target {need.targetProfitUsd === null ? "not set" : `$${need.targetProfitUsd.toLocaleString("en-US")}`}. Repair skill{" "}
              {need.repairAbility === "none" ? "none" : need.repairAbility === "minor" ? "basic" : need.repairAbility === "major" ? "mechanical work" : "not set"}.
            </p>
          ) : (
          <div className="field">
            <label htmlFor="use-edit">
              Use <FromNote show={Boolean(noteMarks?.use)} />
            </label>
            <select
              id="use-edit"
              value={need.useCase}
              onChange={(event) => {
                setNeed({ ...need, useCase: event.target.value as StructuredNeed["useCase"] });
                // Typed/selected on the confirm form — never keep FROM YOUR NOTE.
                if (noteMarks) setNoteMarks({ ...noteMarks, use: false });
              }}
            >
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
            zipMark={
              zipFieldMark(locationResolution) ??
              (noteMarks?.zip
                ? "from your note"
                : isNearMePhrase(need.locationPhrase) && !need.zip
                  ? "optional — near me"
                  : locationResolution?.needed || (need.locationPhrase && !need.zip)
                    ? "needed"
                    : null)
            }
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
              setLocationResolution(
                trimmed
                  ? { zip: trimmed, from: "note_zip", needed: false, cityLabel: null }
                  : need.locationPhrase
                    ? {
                        zip: null,
                        from: null,
                        needed: !isNearMePhrase(need.locationPhrase),
                        cityLabel: need.locationPhrase,
                      }
                    : null,
              );
              setRadiusIsDefault(false);
              if (noteMarks) setNoteMarks({ ...noteMarks, zip: false });
            }}
            onDistanceChange={(miles) => {
              setNeed({ ...need, distanceMiles: miles });
              setDistanceDraft(miles);
              setRadiusIsDefault(false);
            }}
          />
          {radiusIsDefault && need.distanceMiles != null ? (
            <p className="hint" role="note">
              Seller distance {need.distanceMiles} mi is the default for {need.locationPhrase ?? "your city"} — change it if you want a different radius.
            </p>
          ) : isNearMePhrase(need.locationPhrase) && !need.zip ? (
            <p className="hint" role="note">
              Your note said near me. Add a U.S. ZIP to search nearby, or leave ZIP blank to search nationwide.
            </p>
          ) : need.locationPhrase && !need.zip ? (
            <p className="hint" role="note">
              Your note mentioned {need.locationPhrase}. Add a U.S. ZIP (needed) to search nearby, or choose Nationwide.
            </p>
          ) : null}
          {criteriaParse ? <p className="hint">{criteriaParse.label}</p> : null}
          <p className="hint" aria-live="polite">
            Scope: {searchScopeLabel(need)}
          </p>
          <MilesDraftField
            milesMax={need.milesMax}
            marked={Boolean(noteMarks?.miles)}
            onCommit={(next) => {
              setNeed({ ...need, milesMax: next.milesMax, milesCapResolved: next.milesCapResolved });
              if (noteMarks?.miles) {
                setNoteMarks({ ...noteMarks, miles: false });
              }
            }}
          />
          <YearFloorField
            yearMin={need.yearMin}
            yearBandResolved={need.yearBandResolved}
            marked={Boolean(noteMarks?.year)}
            onCommit={(next) => {
              setNeed({ ...need, yearMin: next.yearMin, yearBandResolved: next.yearBandResolved });
              setYearMin(next.yearMin != null ? String(next.yearMin) : "");
              if (noteMarks?.year && next.yearMin !== need.yearMin) {
                setNoteMarks({ ...noteMarks, year: false });
              }
            }}
          />
          {need.conditionPriority === "inspection_first" ? <p className="hint">{CONDITION_HINT}</p> : null}
          {need.awdPreference ? (
            <p className="hint">
              Preferably AWD is a soft preference — AWD/4WD ranks higher when known; FWD and unknown drivetrain stay in the mix.
            </p>
          ) : null}
          {need.reliabilityPriority || need.priorities?.some((p) => /reliab/i.test(p)) ? (
            <p className="hint">Priority: reliability.</p>
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
          <PriceDraftField
            id="budget-edit"
            label={need.mode === "flip" ? "Cash available for the purchase and repairs" : "Maximum vehicle price (before taxes and fees)"}
            budgetUsd={need.budgetUsd}
            marked={Boolean(noteMarks?.budget)}
            onCommit={(next) => {
              setNeed({ ...need, budgetUsd: next.budgetUsd, budgetKnown: next.budgetKnown });
              setBudget(next.budgetUsd != null ? next.budgetUsd.toLocaleString("en-US") : "");
              setBudgetKnown(next.budgetKnown);
              // Any edit on the confirm Max price field clears FROM YOUR NOTE.
              if (noteMarks?.budget) {
                setNoteMarks({ ...noteMarks, budget: false });
              }
              setBudgetFormDirty(true);
            }}
          />
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
        <div id="find-results" className="find-results">
          <h2>Cars that fit</h2>
          <PriceRatingHow />
          <DecisionNote scene="find" proofs={checks} />
          {need ? <p className="hint">Scope: {matchScope ?? searchScopeLabel(need)}</p> : null}
          {need
            ? softPrefGapsFromText(need.note).map((gap) => (
                <p className="hint" key={`results-${gap.id}`}>
                  {gap.id === "age" ? ageGapBuyerHonesty(need) : gap.honesty}
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
                const listingRows = allListings.map((car) => ({
                  make: car.make,
                  model: car.model,
                  year: car.year,
                  priceUsd: car.priceView?.usableForBudget ? car.priceUsd : null,
                  miles: car.miles,
                }));
                const fuelsByModel: Record<string, ReturnType<typeof fuelFactFromFindEvidence>> = {};
                for (const r of freeGovReceiptsForShortlist) {
                  if (r.checkId !== "free_gov_fuel" || !r.fuelEvidence) continue;
                  fuelsByModel[`${r.make}\0${r.model}`.toLowerCase()] = fuelFactFromFindEvidence(
                    r.fuelEvidence,
                  );
                }
                const shortlist = buildGroundedShortlist(
                  need,
                  listingRows,
                  fuelsByModel,
                  uiRowsToRiskReceipts(freeGovReceiptsForShortlist),
                );
                const dealCopy = bestDeal ? formatBuyerBestDeal(bestDeal) : null;
                const decisionLabels = decisionView.labels.map((label) => {
                  const card = allListings.find(
                    (item) => item.vin && label.key && item.vin.toUpperCase() === label.key.toUpperCase(),
                  );
                  return {
                    ...label,
                    trim: label.trim ?? card?.trim ?? null,
                    city: label.city ?? card?.city ?? null,
                    state: label.state ?? card?.state ?? null,
                    dealer: label.dealer ?? card?.dealer ?? null,
                  };
                });
                const decisionPresented = presentDecisionLogForBuyer(decisionView.entries, decisionLabels);
                const recallSummary = summarizeRecallCheckOutcome(
                  uiRowsToRiskReceipts(freeGovReceiptsForShortlist),
                );
                const recallSummaryLine =
                  recallSummary.attempted > 0 ? formatRecallCheckSummary(recallSummary) : null;
                const decodedTrimByVin = new Map<string, string>();
                for (const row of freeGovReceiptsForShortlist) {
                  const specsTrim = row.vpicSpecs?.trim;
                  if (
                    (row.checkId === "free_gov_vpic" || row.toolId === "evidence.gov_vpic") &&
                    row.vin &&
                    specsTrim
                  ) {
                    decodedTrimByVin.set(row.vin.toUpperCase(), specsTrim);
                  }
                }
                const listingHints = allListings.map((car) => ({
                  vin: car.vin,
                  year: car.year,
                  make: car.make,
                  model: car.model,
                  trim: car.trim,
                  vdp: car.vdp,
                  decodedTrim: decodedTrimByVin.get(car.vin.toUpperCase()) ?? null,
                }));
                const recallReceipts = uiRowsToRiskReceipts(freeGovReceiptsForShortlist);
                const offerPool = (marketPool.length > 0 ? marketPool : readinessCarsFromUnknown(allListings)).map(
                  (item) => ({
                    ...item,
                    decodedTrim:
                      item.decodedTrim ??
                      (item.vin ? decodedTrimByVin.get(item.vin.toUpperCase()) ?? null : null),
                  }),
                );
                const readinessNow = new Date();
                const topRows = bestDeal
                  ? topPicksInRankOrder(bestDeal.ranked, bestDeal.pick?.key ?? null).rows
                  : [];
                const cardForRow = (row: (typeof topRows)[number]) => matchBuyerListing(row, allListings);
                const poolForRow = (row: (typeof topRows)[number]) => matchBuyerListing(row, offerPool);
                const readinessByKey = new Map<string, ReturnType<typeof buildPurchaseReadiness>>();
                for (const row of topRows) {
                  const card = cardForRow(row);
                  const pooled = poolForRow(row);
                  const hint = (() => {
                    const vin = (row.vin ?? "").trim().toUpperCase();
                    if (vin) {
                      const byVin = listingHints.find((item) => (item.vin ?? "").trim().toUpperCase() === vin);
                      if (byVin) return byVin;
                    }
                    const rowTrim = (row.trim ?? "").trim().toLowerCase();
                    const loose = listingHints.filter((item) => {
                      if (item.year !== row.year) return false;
                      if (item.make?.toLowerCase() !== row.make.toLowerCase()) return false;
                      if (item.model?.toLowerCase() !== row.model.toLowerCase()) return false;
                      const itemTrim = (item.trim ?? "").trim().toLowerCase();
                      if (rowTrim && itemTrim && rowTrim !== itemTrim) return false;
                      return true;
                    });
                    return loose.length === 1 ? loose[0] : null;
                  })();
                  const trimGap = trimSourceDisagreement({
                    year: row.year,
                    make: row.make,
                    model: row.model,
                    displayedTrim: card?.trim ?? hint?.trim,
                    listingUrl: card?.vdp ?? hint?.vdp,
                    decodedTrim: hint?.decodedTrim,
                  });
                  const priceBlocked = card?.priceView?.usableForBudget === false;
                  const chosen = zipChoice(need.zip, card?.zip ?? pooled?.zip ?? null);
                  readinessByKey.set(
                    row.key,
                    buildPurchaseReadiness({
                      car: {
                        vin: row.vin,
                        year: row.year,
                        make: row.make,
                        model: row.model,
                        trim: card?.trim ?? hint?.trim ?? null,
                        decodedTrim: hint?.decodedTrim ?? pooled?.decodedTrim ?? null,
                        priceUsd: priceBlocked ? null : (row.priceUsd ?? pooled?.priceUsd ?? null),
                        miles: row.miles ?? pooled?.miles ?? null,
                        createdAt: card?.createdAt ?? pooled?.createdAt ?? null,
                        accidentCount: card?.accidentCount ?? pooled?.accidentCount ?? null,
                        usageType: card?.usageType ?? pooled?.usageType ?? null,
                        cpo: card?.cpo ?? pooled?.cpo ?? null,
                        oneOwner: card?.oneOwner ?? pooled?.oneOwner ?? null,
                        ownerCount: card?.ownerCount ?? pooled?.ownerCount ?? null,
                        askingPriceKind: card?.askingPriceKind ?? pooled?.askingPriceKind ?? null,
                        zip: card?.zip ?? pooled?.zip ?? null,
                      },
                      pool: offerPool,
                      zip: chosen.zip,
                      zipUsedFor: chosen.zipUsedFor,
                      now: readinessNow,
                      trimMismatchNote: trimGap ? `${trimGap.note} ${trimGap.sellerQuestion}` : null,
                      identityMismatchNote:
                        row.excludedFromPick && row.excludedReason ? row.excludedReason : null,
                      recallCampaignCount: recallCampaignCountForCar(row, recallReceipts),
                    }),
                  );
                }
                const sellerLines = bestDeal
                  ? omitQuestionsCoveredByTalkingPoints(
                      sellerQuestionsForBuyer(
                        {
                          ...bestDeal,
                          shownKeys: topRows.map((row) => row.key),
                        },
                        listingHints,
                      ),
                      [...readinessByKey.values()].flatMap((view) => view.talkingPoints),
                    )
                  : [];
                const confirmLines = [
                  ...sellerLines,
                  ...(dealCopy?.choice?.confirmBeforeBuying ?? []).filter(
                    (line) => !sellerLines.some((existing) => existing.toLowerCase().includes(line.slice(0, 24).toLowerCase())),
                  ),
                ].slice(0, 8);
                if (checks.length === 0 && shortlist.length === 0 && !dealCopy && decisionPresented.lines.length === 0)
                  return null;
                const rankedForLabels = bestDeal?.allRanked?.length ? bestDeal.allRanked : bestDeal?.ranked ?? [];
                const topNames = buyerCarLabels(
                  rankedForLabels.map((car) => {
                    const card = matchBuyerListing(car, allListings);
                    return {
                      key: car.key,
                      year: car.year,
                      make: car.make,
                      model: car.model,
                      trim: car.trim ?? card?.trim ?? null,
                      priceUsd: car.priceUsd,
                      miles: car.miles,
                      city: car.city ?? card?.city ?? null,
                      state: car.state ?? card?.state ?? null,
                      dealer: car.dealer ?? card?.dealer ?? null,
                    };
                  }),
                );
                const settledLine = findSettledStatusLine({
                  pending: pending === "next-check",
                  anyUnchecked: freeGovAnyUnchecked,
                  evidenceSettled: Boolean(bestDeal?.evidenceSettled),
                  loopOpen: findLoopOpen,
                  hasPick: Boolean(bestDeal?.pick),
                  confidence: bestDeal?.confidence ?? null,
                });
                return (
                  <div className="find-results-grid">
                    <div className="find-col-main">
                    {bestDeal && bestDeal.ranked.length > 0 ? (
                      <div>
                        <p>
                          {topCarsHeading({
                            hasPick: Boolean(bestDeal.pick),
                            evidenceSettled: bestDeal.evidenceSettled,
                          })}
                        </p>
                        <ol className="top-picks">
                          {topRows.map((row) => {
                            const card = cardForRow(row);
                            const readiness = readinessByKey.get(row.key);
                            const findBits = [
                              row.miles != null ? `${row.miles.toLocaleString("en-US")} mi` : null,
                              card?.dealer || row.dealer || null,
                              [card?.city || row.city, card?.state || row.state].filter(Boolean).join(", ") || null,
                              row.vin ? `VIN ${row.vin}` : null,
                            ].filter((bit): bit is string => Boolean(bit));
                            const dealerLink = buyerDealerListingLink({
                              vdp: row.vdp ?? card?.vdp,
                              dealer: card?.dealer || row.dealer,
                              vin: row.vin,
                              year: row.year,
                              trim: row.trim,
                              findBits,
                            });
                            return (
                              <li key={row.key}>
                                {formatTopPickLine({ ...row, name: topNames.get(row.key) })}
                                {" · "}
                                {dealerLink.isDealerListing && dealerLink.href ? (
                                  <a href={dealerLink.href}>Dealer listing</a>
                                ) : (
                                  <span>{dealerLink.unavailableNote}</span>
                                )}
                                {readiness ? <PurchaseReadinessNote view={readiness} /> : null}
                              </li>
                            );
                          })}
                        </ol>
                      </div>
                    ) : null}
                    {baselineView ? (
                      <div className="hint" role="note">
                        <p>{baselineView.title}</p>
                        <ul>
                          {baselineView.lines.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                        <p>{baselineView.whyNotCheapest}</p>
                      </div>
                    ) : null}
                    {dealCopy ? (
                      <div className="hint" role="note">
                        <p>
                          <strong>{dealCopy.headline}</strong>
                        </p>
                        {dealCopy.choice?.confidenceLine ? (
                          <p>
                            <strong>Confidence:</strong> {dealCopy.choice.confidenceLine}
                          </p>
                        ) : null}
                        {pickAgentVerdict?.verdict ? (
                          <p>
                            Verdict:{" "}
                            <strong>
                              {pickAgentVerdict.verdict === "buy"
                                ? "Buy"
                                : pickAgentVerdict.verdict === "negotiate"
                                  ? "Negotiate"
                                  : pickAgentVerdict.verdict === "pass"
                                    ? "Pass"
                                    : pickAgentVerdict.verdict === "needs_inspection"
                                      ? "Needs inspection"
                                      : pickAgentVerdict.verdict}
                            </strong>
                          </p>
                        ) : pending === "next-check" || findLoopOpen ? (
                          <p className="hint">Shopper verdict (Buy / Negotiate / Pass) runs after public checks settle.</p>
                        ) : null}
                        {dealCopy.settlementNote ? <p className="hint">{dealCopy.settlementNote}</p> : null}
                        {dealCopy.choice ? (
                          <>
                            {!pickAgentVerdict?.verdict ? <p>{dealCopy.choice.confidenceLine}</p> : null}
                            <ul>
                              {dealCopy.choice.reasons.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                          </>
                        ) : (
                          <p>{dealCopy.why}</p>
                        )}
                        {dealCopy.rankedLines.length > 0 ? (
                          <>
                            <p>Ranked on current evidence:</p>
                            <ul>
                              {dealCopy.rankedLines.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        {dealCopy.factorLines.length > 0 ? (
                          <>
                            <p>What the checks say about each ranked car:</p>
                            <ul>
                              {dealCopy.factorLines.map((line, idx) => (
                                <li key={`factor-${bestDeal?.evidenceSettled ? "settled" : "prov"}-${idx}`}>
                                  {line}
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        <p>Still unknown:</p>
                        <ul>
                          {dealCopy.stillUnknown.map((u) => (
                            <li key={u.slice(0, 80)}>{u}</li>
                          ))}
                        </ul>
                        {dealCopy.sensitivityLines.length > 0 ? (
                          <>
                            <p>If assumptions change:</p>
                            <ul>
                              {dealCopy.sensitivityLines.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        <p className="hint">{dealCopy.honesty}</p>
                      </div>
                    ) : null}
                    {shortlist.length > 0 ? (
                      <>
                        <p>
                          Models that still fit your stated limits (from these cards only — not an auto-buy
                          recommendation):
                        </p>
                        <ul>
                          {shortlist.map((row) => (
                            <li key={`${row.make}-${row.model}`}>
                              {formatGroundedShortlistLine({
                                make: row.make,
                                model: row.model,
                                why: row.why,
                                unknowns: row.unknowns,
                                campaignRefs: row.campaignRefs.map((id) => formatOfficialRecallNumber(id)),
                              })}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    </div>
                    <div className="find-col-side">
                    {servNextCheckEnabled && freeGovAnyUnchecked && error && pending !== "next-check" ? (
                      <p>
                        Public checks stopped. Some models are still unchecked. You can retry after fixing the
                        error. The best choice may change once checks finish.
                      </p>
                    ) : (
                      <p>
                        {publicCheckStatusLine({
                          servEnabled: servNextCheckEnabled,
                          anyUnchecked: freeGovAnyUnchecked,
                          checksHaveRun:
                            freeGovReceiptsForShortlist.length > 0 || Boolean(bestDeal),
                          running: pending === "next-check",
                          loopOpen: findLoopOpen,
                          shortlistEmpty: !(bestDeal?.ranked?.length),
                          modelCount: new Set(
                            allListings.map((car) => `${car.make}|${car.model}|${car.year}`),
                          ).size,
                        })}
                      </p>
                    )}
                    {checks.length > 0 ? (
                      <ul>
                        {checks.map((item) => (
                          <li key={item.id}>
                            {formatBuyerNextCheckWhy(item.id, item.why, {
                              fuelOutcome: fuelCheckOutcome,
                              fuelPending: fuelCheckPending,
                              recallOutcome: recallSummary.attempted > 0 ? recallSummary : undefined,
                            })}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {decisionPresented.lines.length > 0 ? (
                      <div className="hint" role="note">
                        <p>Check checklist (detail)</p>
                        <ul>
                          {decisionPresented.lines.map((line, index) => (
                            <li key={`decision-${index}`}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {confirmLines.length > 0 ? (
                      <div className="hint" role="note">
                        <p>What to confirm before buying</p>
                        <ul>
                          {confirmLines.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {nextCheckNote ? <p className="hint">{nextCheckNote}</p> : null}
                    {pending === "next-check" && pendingCheckLabel ? (
                      <p className="hint">{pendingCheckLabel}</p>
                    ) : null}
                    <ConsumerDecisionProof
                      records={proofRecords.filter(
                        (row) =>
                          row.purpose === "find_pick" ||
                          row.purpose === "verdict_decide" ||
                          row.purpose === "verdict_challenge" ||
                          row.purpose === "need_extract" ||
                          row.purpose === "need_guard" ||
                          row.purpose === "find_next_check",
                      )}
                      verdict={buildFindAgentVerdict({
                        decisionLog: decisionView.entries,
                        labels: decisionLabels,
                        bestDeal,
                        baseline: bestDeal?.baseline ?? null,
                        secondPass: pickSecondPass,
                        settleVerdict: pickAgentVerdict,
                        confidenceLine: bestDeal?.choice?.confidenceLine ?? null,
                        servCalls: decisionView.entries.filter((entry) => entry.decidedBy === "SERV").length,
                      })}
                      plainLines={[
                        (() => {
                          const lineage = findVerdictLineage(proofRecords, pickAgentVerdict?.verdict ?? null);
                          if (!lineage?.finalVerdict && !lineage?.servPick) return null;
                          if (lineage.guardrail && lineage.servPick) {
                            return `Our AI first leaned ${lineage.servPick}; safety rules settled on ${lineage.finalVerdict ?? lineage.guardrail}.`;
                          }
                          if (lineage.servPick && lineage.finalVerdict && lineage.servPick !== lineage.finalVerdict) {
                            return `Our AI first leaned ${lineage.servPick}; the final call is ${lineage.finalVerdict}.`;
                          }
                          return lineage.finalVerdict ? `Final call: ${lineage.finalVerdict}.` : null;
                        })(),
                        ...(decisionPresented.hiddenSteps ?? []),
                      ].filter((line): line is string => Boolean(line))}
                      confidenceWhy={bestDeal?.choice?.confidenceLine ?? null}
                      emptyHint="No decision records for this Find run yet."
                    />
                    {settledLine ? <p className="hint">{settledLine}</p> : null}
                    {freeGovEvidenceLines.length > 0 ? (
                      <div className="hint" role="note">
                        <p>
                          What we checked from free U.S. government sources (year/make/model scope — not the same as
                          a VIN history or title report):
                        </p>
                        {recallSummaryLine ? <p>{recallSummaryLine}</p> : null}
                        <ul>
                          {freeGovEvidenceLines.map((line) => (
                            <li key={line.slice(0, 100)}>{line}</li>
                          ))}
                        </ul>
                        {(() => {
                          const sources = buyerSourceLinesForUi(freeGovReceiptsForShortlist).filter(
                            (s) => s.href,
                          );
                          if (sources.length === 0) return null;
                          return (
                            <p className="hint">
                              Public pages:{" "}
                              {sources.map((s, i) => (
                                <span key={`${s.label}-${s.href}`}>
                                  {i > 0 ? " · " : null}
                                  <a href={s.href!} target="_blank" rel="noreferrer">
                                    {s.label}
                                  </a>
                                </span>
                              ))}
                            </p>
                          );
                        })()}
                        {riskCoverageNote ? <p className="hint">{riskCoverageNote}</p> : null}
                      </div>
                    ) : null}
                    </div>
                    {freeGovAgentPayload ? (
                      <script
                        type="application/json"
                        id="find-agent-receipts"
                        data-channel="for-agents"
                        dangerouslySetInnerHTML={{ __html: freeGovAgentPayload }}
                      />
                    ) : null}
                  </div>
                );
              })()
            : null}
          {need && need.budgetKnown && need.budgetUsd != null ? (
            <p className="hint">{budgetWorkingCopy(need)}</p>
          ) : !affordability ? (
            <p className="hint">Budget was not set, so affordability was not assessed.</p>
          ) : null}
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
          {error && pending === null && groups.some((group) => group.listings.length > 0) ? (
            <p className="warn" role="alert">
              {error} {dealRadarUi && /plan|watch/i.test(error) ? <a href="/pricing">See radar plans</a> : null}
            </p>
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
                    const fuelsByModel: Record<string, ReturnType<typeof fuelFactFromFindEvidence>> = {};
                    for (const r of freeGovReceiptsForShortlist) {
                      if (r.checkId !== "free_gov_fuel" || !r.fuelEvidence) continue;
                      fuelsByModel[`${r.make}\0${r.model}`.toLowerCase()] = fuelFactFromFindEvidence(
                        r.fuelEvidence,
                      );
                    }
                    const compared = compareObservedModels(rows, fuelsByModel);
                    if (compared.length === 0) return null;
                    return (
                      <div className="hint" role="note">
                        <p>{compared[0]!.honesty}</p>
                        <ul>
                          {compared.map((row) => (
                            <li key={`${row.make}-${row.model}`}>{formatModelCompareRow(row)}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()
                : null}
              {dealRadarUi ? (
                <button className="quiet" type="button" onClick={() => void watch(group.direction)} disabled={pending === group.direction.id}>
                  {pending === group.direction.id ? "Saving watch…" : "Watch with Deal Radar"}
                </button>
              ) : null}
              {watchGeoDraft && watchGeoDraft.direction.id === group.direction.id ? (
                <div className="warn-box" role="region" aria-label="Deal Radar location">
                  <p>
                    This Find search was nationwide (or missing a radius). Add a ZIP and seller-distance radius to
                    create the watch — prefilled from your search when available.
                  </p>
                  <ZipRadiusFields
                    idPrefix={`watch-${group.direction.id}`}
                    zip={watchGeoDraft.zip}
                    distanceMiles={watchGeoDraft.distanceMiles}
                    allowNationwide={false}
                    onZipChange={(next) => setWatchGeoDraft({ ...watchGeoDraft, zip: next })}
                    onDistanceChange={(miles) => setWatchGeoDraft({ ...watchGeoDraft, distanceMiles: miles })}
                  />
                  <div className="btn-row">
                    <button className="ghost" type="button" onClick={() => setWatchGeoDraft(null)}>
                      Cancel
                    </button>
                    <button
                      className="action"
                      type="button"
                      disabled={
                        pending === group.direction.id ||
                        !watchGeoDraft.zip.trim() ||
                        watchGeoDraft.distanceMiles == null
                      }
                      onClick={() =>
                        void watch(watchGeoDraft.direction, {
                          zip: watchGeoDraft.zip,
                          distanceMiles: watchGeoDraft.distanceMiles,
                        })
                      }
                    >
                      {pending === group.direction.id ? "Saving watch…" : "Save watch"}
                    </button>
                  </div>
                </div>
              ) : null}
              <p className="hint">{FIND_RESULTS_BILLING_HINT}</p>
              {group.note &&
              !(
                (matchMessage && matchMessage.toLowerCase().includes(group.note.toLowerCase())) ||
                (group.providerWarning && group.note.toLowerCase().includes(group.providerWarning.toLowerCase()))
              ) ? (
                <p className="hint">{group.note}</p>
              ) : null}
              {(() => {
                const inBudget = group.listings.filter((car) => !car.overBudget);
                const slightOver = group.listings.filter((car) => car.overBudget);
                const renderCard = (car: (typeof group.listings)[number]) => (
                  <article className="listing-card" key={car.vin}>
                    {car.primaryImage ? (
                      <img src={car.primaryImage} alt="" width={640} height={400} />
                    ) : (
                      <div className="photo-fallback" role="img" aria-label="No photo from the listing" />
                    )}
                    <div className="listing-body">
                    <h3 className="car-title">
                      {car.year} {car.make} {car.model} {car.trim ?? ""}
                      {car.miles != null ? ` · ${car.miles.toLocaleString("en-US")} mi` : ""}
                      {car.dealer ? ` · ${car.dealer}` : ""}
                      {car.city ? ` · ${car.city}${car.state ? `, ${car.state}` : ""}` : ""}
                    </h3>
                    <p className="listing-meta">
                      {car.priceView?.displayPrimary ??
                        (car.priceUsd === null ? "Price not listed" : `$${car.priceUsd.toLocaleString("en-US")}`)}
                      {" · "}
                      {car.miles === null ? "Mileage not listed" : `${car.miles.toLocaleString("en-US")} mi`}
                      {car.city ? ` · ${car.city}${car.state ? `, ${car.state}` : ""}` : ""}
                      {car.dealer ? ` · ${car.dealer}` : ""}
                    </p>
                    {car.priceView?.displayDetail ? <p className="hint">{car.priceView.displayDetail}</p> : null}
                    {(() => {
                      const fuelRow = freeGovReceiptsForShortlist.find(
                        (r) =>
                          r.checkId === "free_gov_fuel" &&
                          r.fuelEvidence &&
                          mmyListingKey(r.make, r.model, r.year) ===
                            mmyListingKey(car.make, car.model, car.year),
                      );
                      if (!fuelRow?.fuelEvidence) return null;
                      return (
                        <p className="hint">{formatFindFuelEvidenceShort(fuelRow.fuelEvidence)}</p>
                      );
                    })()}
                    {car.overBudget ? <p className="budget-flag">Slightly over budget</p> : null}
                    {car.source !== "autodev" ? <p className="hint">Source {car.source}: not treated as verified live inventory.</p> : null}
                    {car.badge ? <PriceBadgeView badge={car.badge} /> : null}
                    {car.flipNote ? <p className="hint">{car.flipNote}</p> : null}
                    {car.clearsTarget === false ? <p className="hint">Under the profit target, so it ranks lower.</p> : null}
                    {car.clearsTarget === true ? <p className="hint">Clears the profit target. That target is an assumption, not a promised sale.</p> : null}
                    {(() => {
                      const dealerLink = buyerDealerListingLink({
                        vdp: car.vdp,
                        dealer: car.dealer,
                        vin: car.vin,
                        year: car.year,
                        trim: car.trim,
                        findBits: [
                          car.dealer,
                          car.vin ? `VIN ${car.vin}` : null,
                          car.city,
                        ].filter((bit): bit is string => Boolean(bit)),
                      });
                      const trimNote = trimSourceDisagreement({
                        year: car.year,
                        make: car.make,
                        model: car.model,
                        displayedTrim: car.trim,
                        listingUrl: dealerLink.href ?? car.vdp,
                        decodedTrim: freeGovReceiptsForShortlist.find(
                          (row) =>
                            (row.checkId === "free_gov_vpic" || row.toolId === "evidence.gov_vpic") &&
                            row.vin?.toUpperCase() === car.vin.toUpperCase(),
                        )?.vpicSpecs?.trim,
                      });
                      return (
                        <>
                          {trimNote ? <p className="hint">{trimNote.note}</p> : null}
                          <p className="hint">
                            {dealerLink.isDealerListing && dealerLink.href ? (
                              <a href={dealerLink.href}>Dealer listing</a>
                            ) : (
                              dealerLink.unavailableNote
                            )}
                          </p>
                        </>
                      );
                    })()}
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
                );
                return (
                  <>
                    {inBudget.length > 0 ? (
                      <>
                        <h4 className="hint">Within budget</h4>
                        <div className="listing-grid">{inBudget.map(renderCard)}</div>
                      </>
                    ) : null}
                    {slightOver.length > 0 ? (
                      <>
                        <h4 className="hint">Slightly over budget (up to 5% above your max)</h4>
                        <div className="listing-grid">{slightOver.map(renderCard)}</div>
                      </>
                    ) : null}
                    {inBudget.length === 0 && slightOver.length === 0 ? (
                      <div className="listing-grid">{group.listings.map(renderCard)}</div>
                    ) : null}
                  </>
                );
              })()}
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
          {checkAllowance === "loading" ? null : checkAllowance === "signed-out" ? (
            <p className="hint">
              <Link href="/login?callbackUrl=/check">Sign in</Link>
              {formatFreeChecksSignInPrompt().slice("Sign in".length)}
            </p>
          ) : checkAllowance === "missing" ? (
            <p className="hint">Free checks could not be loaded.</p>
          ) : (
            <p className="hint">{checkAllowance}</p>
          )}
          <p className="hint">The price check does not use a free check. A full report does, then 1 report credit after this month’s free checks are used.</p>
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
              <p className="hint">
                This quick result rates the asking price only. The full report adds broader safety and vehicle context. It
                uses one of this month’s {FREE_VEHICLE_CHECKS_PER_MONTH} free checks, or 1 report credit after those are
                used.
              </p>
              <button className="action" type="button" onClick={() => void checkListing()} disabled={pending === "report"}>
                {pending === "report" ? "Building report…" : "Full analysis"}
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

      {error &&
      !(
        stage === "results" &&
        ((groups.some((group) => group.listings.length > 0) && pending === null) ||
          ((groups.length === 0 || groups.every((group) => group.listings.length === 0)) && !matchMessage))
      ) ? (
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
