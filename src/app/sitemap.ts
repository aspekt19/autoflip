import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://autoflip-umber.vercel.app").replace(/\/$/, "");
  const paths = [
    "/",
    "/find",
    "/check",
    "/resale",
    "/reports",
    "/favorites",
    "/compare-cars",
    "/compare",
    "/pricing",
    "/credits",
    "/account",
    "/login",
    "/developers",
    "/where-serv-runs",
    "/proof",
    "/verify",
    "/report/sample",
    "/privacy",
    "/terms",
  ];
  const now = new Date();
  return paths.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.6,
  }));
}
