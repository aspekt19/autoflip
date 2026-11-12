/**
 * Pull report fields from agent journals (Find or Resale).
 */
import { formatFeatureRejectionFlags } from "@/server/serv/agent-serv-features";

type JournalServLike = {
  kind: "serv";
  responseId?: string | null;
  features?: string[];
  featureFlags?: string[];
  featureRejections?: Array<{
    feature: string;
    status: number;
    error: string;
    endpoint: "responses" | "chat";
    keptRequesting: true;
  }>;
};

export function liveEvalJournalMeta(journal: ReadonlyArray<{ kind: string }>): {
  featuresActive: string[];
  featureRejections: string[];
  servResponseIds: string[];
} {
  const features = new Set<string>();
  const rejectionFlags = new Set<string>();
  const responseIds: string[] = [];

  for (const entry of journal) {
    if (entry.kind !== "serv") continue;
    const serv = entry as JournalServLike;
    if (typeof serv.responseId === "string" && serv.responseId.trim()) {
      responseIds.push(serv.responseId.trim());
    }
    for (const f of serv.features ?? []) {
      if (typeof f === "string" && f.trim()) features.add(f.trim());
    }
    for (const flag of serv.featureFlags ?? []) {
      if (typeof flag === "string" && flag.includes("FEATURE_REJECTION")) {
        rejectionFlags.add(flag);
      }
    }
    if (serv.featureRejections?.length) {
      for (const flag of formatFeatureRejectionFlags(serv.featureRejections)) {
        rejectionFlags.add(flag);
      }
    }
  }

  return {
    featuresActive: [...features],
    featureRejections: [...rejectionFlags],
    servResponseIds: responseIds,
  };
}
