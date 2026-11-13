/**
 * Shared per-source attempt checklist used by Find, Resale, Check, and /run.
 * Code records attempts only — statuses are never a content judgment.
 */
export type SourcesCheckedItem = {
  label?: string | null;
  source?: string | null;
  status?: string | null;
};

export function formatSourcesCheckedItems(items: readonly SourcesCheckedItem[]): string {
  return items
    .map((s) => {
      const label = (s.label ?? s.source ?? "Source").toString();
      const status = (s.status ?? "not_attempted").toString().replace(/_/g, " ");
      return `${label} (${status})`;
    })
    .join(" · ");
}

export function SourcesCheckedLine({
  items,
  className = "hint",
}: {
  items: readonly SourcesCheckedItem[] | null | undefined;
  className?: string;
}) {
  if (!items || items.length === 0) return null;
  return <p className={className}>Sources: {formatSourcesCheckedItems(items)}</p>;
}
