import { profile, PROFILES, type ProfileId } from "./profiles";

/** One profile per distinct request shape: endpoint, suffix, tools, schema, stream, effort, tool, shadow cap. */
export function distinctSelftestProfiles(): ProfileId[] {
  const seen = new Set<string>();
  const ids: ProfileId[] = [];
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const entry = profile(id);
    const key = [
      entry.endpoint,
      entry.feature,
      [...entry.tools].sort().join("+"),
      entry.jsonSchema?.name ?? "",
      entry.stream ? "stream" : "batch",
      entry.reasoningEffort,
      entry.applicationTool ?? "",
      entry.shadowMaxIterations ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}
