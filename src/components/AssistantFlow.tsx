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
import { previewFindFromNote } from "@/domain/find-preview";
import { resolveLocationZip, zipFieldMark, type LocationZipResolution } from "@/domain/city-to-zip";
import { awdLimitFromText, intakeFromNote, isNearMePhrase, NOTE_DEFAULT_RADIUS_WHEN_ZIP } from "@/domain/note-intake";
import { yearSpanSentence } from "@/domain/year-span";
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
import type { SearchDirection } from "@/domain/directions";
import type { FindPlan } from "@/domain/find-plan";
import { CoverageLine } from "./CoverageNote";
import { RunMirror } from "./RunMirror";
import { DecisionNote } from "./DecisionNote";
import { decideAfFlowRestore, freshVisitRestorePolicy, resumeFindSearchFromFlow } from "@/domain/af-flow-session";
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
import { shouldAutoStartFindDecide } from "@/domain/find-decide-path";
import {
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
import {
  presentDecisionLogForBuyer,
  type DecisionCarLabel,
  type FindDecisionLogEntry,
} from "@/domain/find-decision-log";
import { ServDecisionJournal } from "@/components/ServDecisionJournal";
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
import { buyerTrim } from "@/domain/buyer-trim";
import { veryHighMileageLabel } from "@/domain/find-best-deal";
import { buyerDealerListingLink } from "@/domain/listing-vdp-verifiability";
import { mmyListingKey } from "@/domain/find-risk-evidence";
import {
  ageGapBuyerHonesty,
  applyFollowUp,
  explicitNeedFromText,
  followUps,
  needPrefersAwd,
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
  drivetrain?: string | null;
  drivetrainUnverified?: boolean;
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
  /** C1 find_plan from /api/need — summary + directions for Confirm / match. */
  const [findPlan, setFindPlan] = useState<FindPlan | null>(null);
  const [planDirections, setPlanDirections] = useState<SearchDirection[] | null>(null);
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
  const [checkKind, setCheckKind] = useState<"link" | "vin">("vin");
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
  /** Owner-bound search context from /api/match — required for next-check / decide. */
  const [searchContextToken, setSearchContextToken] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [resumeOffer, setResumeOffer] = useState<string | null>(null);
  const [servNextCheckEnabled, setServNextCheckEnabled] = useState(false);
  /** PR B: one-shot decide path instead of next-check loop. */
  const [decidePathEnabled, setDecidePathEnabled] = useState(false);
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
  const findIdemFingerprint = useRef<string | null>(null);
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
    if (!followUp && !opts?.freshNote && text.trim().length >= 8) {
      const preview = previewFindFromNote(text, mode);
      setNeed(preview.need);
      setFindPlan(preview.findPlan);
      setPlanDirections(preview.directions);
      setSource("form");
      setRadiusIsDefault(preview.radiusIsDefault);
      setZipDraft(preview.need.zip ?? "");
      setDistanceDraft(preview.need.distanceMiles);
      if (preview.need.budgetUsd != null) {
        setBudget(preview.need.budgetUsd.toLocaleString("en-US"));
        setBudgetKnown(preview.need.budgetKnown);
      }
      setStage(findStageAfterNote(preview.need));
    }
    setPending("need");
    const controller = new AbortController();
    // The confirm screen stays up. The plan itself waits out the route budget.
    const timer = window.setTimeout(() => controller.abort(), 290_000);
    try {
      const amount = parseUsdInput(budget) ?? Number.NaN;
      const response = await fetch("/api/need", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          mode,
          runId: opts?.freshNote ? null : runId,
          budgetUsd: opts?.freshNote || !budgetFormDirty ? null : budgetKnown && Number.isFinite(amount) ? amount : null,
          budgetKnown: opts?.freshNote || !budgetFormDirty ? false : budgetKnown,
          budgetDirty: opts?.freshNote ? false : budgetFormDirty,
          zip: zipForNeed,
          // A fresh note omits radius so a city in the note can set one. Nationwide is an explicit choice.
          ...(opts?.freshNote
            ? {}
            : {
                distanceMiles: distanceForNeed,
                radiusDirty: true,
              }),
          repairAbility: opts?.freshNote ? undefined : need?.repairAbility,
          useCase: opts?.freshNote ? undefined : need?.useCase,
          targetProfitUsd: opts?.freshNote ? undefined : need?.targetProfitUsd,
          followUp,
        }),
      });
      const body = (await response.json()) as {
        source?: "model" | "form";
        need?: StructuredNeed;
        findPlan?: FindPlan;
        directions?: SearchDirection[];
        followUps?: FollowUp[];
        checks?: DecisionProof[];
        message?: string;
        guard?: string;
        criteriaParse?: { source: "serv" | "code" | "form"; responseId: string | null; label: string };
        runId?: string | null;
      };
      if (!response.ok || !body.need) {
        setError(body.message || "That note could not be read.");
        return;
      }
      if (typeof body.runId === "string" && body.runId) setRunId(body.runId);
      const finalNeed = body.need;
      if (body.findPlan) setFindPlan(body.findPlan);
      if (Array.isArray(body.directions) && body.directions.length > 0) {
        setPlanDirections(body.directions);
      }
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
            ? { source: "code" as const, responseId: null, label: criteriaParseLabel({ source: "code", responseId: null }) }
            : { source: "form" as const, responseId: null, label: criteriaParseLabel({ source: "form", responseId: null }) });
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

  const resumePayload = useRef<string | null>(null);

  function resumeSavedFind() {
    const raw = resumePayload.current;
    if (!raw) return;
    try {
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
            void applyLiveFindDecide({ token, auto: true });
          });
        }
      }
    } catch {
      /* ignore a bad saved draft */
    }
    setResumeOffer(null);
  }

  useEffect(() => {
    if (variant !== "find" || initialNote?.trim()) return;
    try {
      const raw = sessionStorage.getItem("af-flow");
      if (!raw) return;
      const saved = JSON.parse(raw) as { need?: unknown; stage?: string };
      if (!saved.need || !saved.stage || saved.stage === "need") return;
      resumePayload.current = raw;
      setResumeOffer(freshVisitRestorePolicy().resumeLabel);
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
      if (saved.checkKind === "vin") setCheckKind("vin");
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
            : { source: "code", responseId: null, label: criteriaParseLabel({ source: "code", responseId: null }) },
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
   * PR B: one-shot decide via owner-bound searchContextToken.
   * Free-gov + triage + decide + challenge; never auto-continues.
   */
  async function applyLiveFindDecide(opts?: { token?: string; auto?: boolean; runId?: string | null }) {
    if (variant !== "find") return;
    const token = opts?.token ?? searchContextToken;
    if (!token) {
      if (!opts?.auto) setError("Search context missing — run Find again before decide.");
      return;
    }
    setError(null);
    setNextCheckNote(null);
    setPending("next-check");
    setPendingCheckLabel(
      findNextCheckPendingLabel({
        pending: true,
        auto: Boolean(opts?.auto),
        progressLine: "Reviewing public records and choosing the best match…",
      }),
    );
    setFindLoopOpen(true);
    const controller = new AbortController();
    // Match /api/find/decide maxDuration (300s) — free-gov + 3× ~90s SERV steps.
    const timer = window.setTimeout(() => controller.abort(), 290_000);
    try {
      const response = await fetch("/api/find/decide", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchContextToken: token, runId: opts?.runId ?? runId }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        message?: string;
        honesty?: string;
        searchContextToken?: string;
        bestDeal?: BestDealResult | null;
        pickAgentVerdict?: import("@/domain/agent-verdict-schema").AgentVerdict | null;
        pickSecondPass?: import("@/domain/agent-verdict-schema").AgentSecondPassResult | null;
        pickProofRecords?: DecisionProofRecord[];
        freeGovReceipts?: FreeGovReceiptUiRow[];
        freeGovCoverage?: {
          note?: string;
          anyUnchecked?: boolean;
          fuel?: { unchecked?: number };
        } | null;
        riskCoverage?: { note?: string } | null;
        freeEvidenceNote?: string;
        loop?: { continue?: boolean; reason?: string; detail?: string };
        needAfter?: StructuredNeed;
        runId?: string | null;
      };
      if (!response.ok || !body.ok) {
        setFindLoopOpen(false);
        const reason = body.message || body.honesty || "Decide could not finish.";
        setPendingCheckLabel(findNextCheckPendingLabel({ pending: false, terminalReason: reason }));
        setError(reason);
        setNextCheckNote(reason);
        return;
      }
      const pickProofs = Array.isArray(body.pickProofRecords) ? body.pickProofRecords : [];
      if (pickProofs.length > 0) {
        setProofRecords((prev) => [...prev, ...pickProofs]);
      }
      if (body.needAfter) setNeed(body.needAfter);
      if (typeof body.searchContextToken === "string") setSearchContextToken(body.searchContextToken);
      if (typeof body.runId === "string" && body.runId) setRunId(body.runId);
      if (body.bestDeal) setBestDeal(body.bestDeal);
      if (body.pickAgentVerdict) setPickAgentVerdict(body.pickAgentVerdict);
      if (body.pickSecondPass) setPickSecondPass(body.pickSecondPass);
      if (Array.isArray(body.freeGovReceipts)) {
        setFreeGovReceiptsForShortlist(body.freeGovReceipts);
        // Mirror next-check: drive fuel/recall checklist from decide freeGovReceipts.
        const fuelOutcome = summarizeFuelCheckOutcome(uiRowsToRiskReceipts(body.freeGovReceipts));
        if (fuelOutcome.attempted > 0) setFuelCheckOutcome(fuelOutcome);
        // recallOutcome is consumed by the checklist via freeGovReceiptsForShortlist.
        void summarizeRecallCheckOutcome(uiRowsToRiskReceipts(body.freeGovReceipts));
      }
      if (body.freeGovCoverage && typeof body.freeGovCoverage.anyUnchecked === "boolean") {
        setFreeGovAnyUnchecked(body.freeGovCoverage.anyUnchecked);
      }
      const toolNote =
        body.freeGovCoverage && typeof body.freeGovCoverage.note === "string"
          ? body.freeGovCoverage.note.trim()
          : body.freeEvidenceNote?.trim() || "";
      const riskNote =
        body.riskCoverage && typeof body.riskCoverage.note === "string"
          ? body.riskCoverage.note.trim()
          : "";
      if (toolNote || riskNote) {
        setRiskCoverageNote([toolNote, riskNote].filter(Boolean).join(" "));
      }
      const detail =
        body.loop?.detail ||
        body.honesty ||
        "Public checks and AI review finished.";
      setNextCheckNote(detail);
      setFindLoopOpen(false);
      setPendingCheckLabel(null);
      try {
        sessionStorage.setItem(
          "af-find-loop",
          JSON.stringify({
            token: typeof body.searchContextToken === "string" ? body.searchContextToken : token,
            settled: true,
          }),
        );
      } catch {
        /* ignore */
      }
    } catch (err) {
      setFindLoopOpen(false);
      const reason =
        err instanceof DOMException && err.name === "AbortError"
          ? "Decide timed out — try again."
          : "Decide could not finish.";
      setPendingCheckLabel(findNextCheckPendingLabel({ pending: false, terminalReason: reason }));
      setError(reason);
      setNextCheckNote(reason);
    } finally {
      window.clearTimeout(timer);
      setPending(null);
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
    // Match /api/match maxDuration (300s) — inventory waves must not abort early.
    const timer = window.setTimeout(() => controller.abort(), 290_000);
    /** Fired after finally so we do not clear next-check pending. */
    let autoNextToken: string | null = null;
    let autoDecidePath = false;
    let matchedRunId: string | null = null;
    try {
      const specFingerprint = JSON.stringify({
        text,
        budget: budgetFormDirty ? budget : null,
        yearMin,
        yearMax,
        milesMax: need?.milesMax ?? null,
        zip: zipDraft,
        distance: distanceDraft,
      });
      if (findIdemFingerprint.current !== specFingerprint) {
        findIdempotencyKey.current = null;
        findIdemFingerprint.current = specFingerprint;
        try {
          sessionStorage.removeItem("af-find-idem");
        } catch {
          /* ignore */
        }
      }
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
          runId,
          // C1 plan directions — skip proposeDirections collapse when present.
          ...(planDirections && planDirections.length > 0 ? { directions: planDirections } : {}),
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
        decidePathEnabled?: boolean;
        compsPool?: unknown;
        error?: string;
        runId?: string | null;
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
      if (typeof body.runId === "string" && body.runId) setRunId(body.runId);
      setServNextCheckEnabled(Boolean(body.servNextCheckEnabled && nextToken));
      setDecidePathEnabled(Boolean(body.decidePathEnabled && nextToken));
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
      // PR B: decide path takes one /api/find/decide call. Legacy: next-check loop.
      const hasCars = nextGroups.some((group) => group.listings.length > 0);
      matchedRunId = typeof body.runId === "string" ? body.runId : null;
      const autoDecide = hasCars
        ? shouldAutoStartFindDecide({
            decidePathEnabled: Boolean(body.decidePathEnabled),
            searchContextToken: nextToken,
            alreadyAutoStartedForToken: autoNextCheckTokenRef.current,
          })
        : null;
      if (autoDecide) {
        autoNextCheckTokenRef.current = autoDecide;
        autoNextToken = autoDecide;
        autoDecidePath = true;
      } else {
        const auto = shouldAutoStartFindNextCheck({
          servNextCheckEnabled: Boolean(body.servNextCheckEnabled),
          searchContextToken: nextToken,
          alreadyAutoStartedForToken: autoNextCheckTokenRef.current,
        });
        if (auto) {
          autoNextCheckTokenRef.current = auto;
          autoNextToken = auto;
        }
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
      if (autoDecidePath) {
        void applyLiveFindDecide({ token: autoNextToken, auto: true, runId: matchedRunId });
      } else {
        void applyLiveFindDecide({ token: autoNextToken, auto: true, runId: matchedRunId });
      }
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

      {path === "choose" && stage === "need" && resumeOffer ? (
        <p className="hint">
          <button
            className="quiet"
            type="button"
            onClick={() => {
              resumeSavedFind();
            }}
          >
            {resumeOffer}
          </button>
        </p>
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
            setRunId(null);
            setPickAgentVerdict(null);
            setPickSecondPass(null);
            setFindLoopOpen(false);
            setBudgetFormDirty(false);
            findIdempotencyKey.current = null;
            try {
              sessionStorage.removeItem("af-find-idem");
            } catch {
              /* ignore */
            }
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
              {pending === "need" ? "Working…" : "Continue"}
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
              {pending === "need" ? "Working…" : "Continue"}
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
              {pending === "need" ? "Working…" : "Continue"}
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
          {findPlan?.summary ? (
            <p className="onboarding-note" aria-label="Plan summary">
              {findPlan.summary}
            </p>
          ) : null}
          {pending === "need" ? <p className="hint">Planning the search. This can take a few minutes.</p> : null}
          {findPlan?.question?.id === "zip" && findPlan.question.text ? (
            <p className="hint" role="status">
              {findPlan.question.text}
            </p>
          ) : null}
          <div className="field">
            <label htmlFor="note">Your note</label>
            <textarea id="note" rows={3} value={need.note} onChange={(event) => setNeed({ ...need, note: event.target.value })} />
          </div>
          <NoteFactChips need={need} onChange={setNeed} />
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
          {awdLimitFromText(need.note) === "hard" ? (
            <p className="hint">
              All-wheel drive is required. Front-wheel drive is left out. If the listing does not say, we check the VIN and leave the car out when we still cannot tell.
            </p>
          ) : need.awdPreference ? (
            <p className="hint">
              All-wheel drive is a preference, so those cars rank higher. Front-wheel drive can still show up. A car with no drivetrain listed stays in the list and is marked unverified.
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
          <RunMirror runId={runId} />
          <h2 className="prose-title">Cars that fit</h2>
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
                      budgetUsd: need.budgetKnown ? need.budgetUsd : null,
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
                          {pickAgentVerdict?.verdict
                            ? topCarsHeading({
                                hasPick: Boolean(bestDeal.pick),
                                evidenceSettled: bestDeal.evidenceSettled,
                              })
                            : "These cars are not ranked yet"}
                        </p>
                        <ol className="top-picks">
                          {topRows.map((row) => {
                            const card = cardForRow(row);
                            const readiness = readinessByKey.get(row.key);
                            const findBits = [
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
                                {readiness && pickAgentVerdict?.verdict ? <PurchaseReadinessNote view={readiness} /> : null}
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
                        {pickAgentVerdict?.verdict && groups.some((group) => group.listings.length > 0) ? (
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
                          servEnabled: servNextCheckEnabled || decidePathEnabled,
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
                    {runId ? null : (
                    <ServDecisionJournal
                      proofRecords={proofRecords}
                      agentVerdict={buildFindAgentVerdict({
                        decisionLog: decisionView.entries,
                        labels: decisionLabels,
                        bestDeal,
                        baseline: bestDeal?.baseline ?? null,
                        secondPass: pickSecondPass,
                        settleVerdict: pickAgentVerdict,
                        confidenceLine: bestDeal?.choice?.confidenceLine ?? null,
                        servCalls: decisionView.entries.filter((entry) => entry.decidedBy === "SERV").length,
                      })}
                      defaultOpen
                    />
                    )}
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
                {yearSpanSentence(group.direction.yearMin, group.direction.yearMax)} {group.direction.yearBecause}
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
                      {car.year} {car.make} {car.model} {buyerTrim(car.trim)}
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
                    {!pickAgentVerdict?.verdict ? (
                      <p className="budget-flag">Not ranked yet. The verdict has not been decided.</p>
                    ) : null}
                    {veryHighMileageLabel(car.miles) ? <p className="budget-flag">Very high mileage</p> : null}
                    {car.drivetrain || (need && awdLimitFromText(need.note) === "hard") ? (
                      <p>Drivetrain: {car.drivetrain?.trim() || "not listed"}</p>
                    ) : null}
                    {car.overBudget ? <p className="budget-flag">Asking price is slightly over your limit</p> : null}
                    {car.drivetrainUnverified ? (
                      <p className="budget-flag">All-wheel drive was not verified for this car.</p>
                    ) : null}
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
                        <h4 className="hint">Asking price within your limit</h4>
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
