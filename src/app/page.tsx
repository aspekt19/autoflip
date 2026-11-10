import type { Metadata } from "next";
import { HomeStage } from "@/components/HomeStage";

/** Absolute so the root template does not become "Lemonless · Lemonless". */
export const metadata: Metadata = {
  title: { absolute: "Lemonless" },
};

export default function HomePage() {
  return <HomeStage />;
}
