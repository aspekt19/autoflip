import { notFound } from "next/navigation";

/**
 * Stale labeled sample report route removed (home no longer links here).
 * Kept as a 404-safe path so old bookmarks do not serve outdated content.
 */
export default function SampleReportRemovedPage() {
  notFound();
}
