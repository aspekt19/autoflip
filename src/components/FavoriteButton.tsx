"use client";

import { useEffect, useState } from "react";

export function FavoriteButton({ reportId }: { reportId: string }) {
  const [favorite, setFavorite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/favorites", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { favoriteIds?: string[] };
        if (active && response.ok) setFavorite((body.favoriteIds ?? []).includes(reportId));
      })
      .catch(() => {
        if (active) setError("Saved cars are unavailable right now.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reportId]);

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/favorites", {
        method: favorite ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId }),
      });
      const body = (await response.json()) as { favoriteIds?: string[]; message?: string };
      if (!response.ok) {
        setError(body.message || "Could not update saved cars.");
        return;
      }
      setFavorite((body.favoriteIds ?? []).includes(reportId));
    } catch {
      setError("Could not update saved cars.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="favorite-control">
      <button className="quiet" type="button" aria-pressed={favorite} onClick={() => void toggle()} disabled={loading || pending}>
        {loading ? "Checking saved cars…" : pending ? "Saving…" : favorite ? "♥ Saved car" : "♡ Save car"}
      </button>
      {error ? <p className="hint" role="alert">{error}</p> : null}
    </div>
  );
}
