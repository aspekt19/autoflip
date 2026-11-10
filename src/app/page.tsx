import type { Metadata } from "next";
import { HomeStage } from "@/components/HomeStage";

/** Absolute so the root template does not append "· Lemonless" after the brand-first home title. */
export const metadata: Metadata = {
  title: { absolute: "Lemonless — A clear verdict on a used car" },
};

export default function HomePage() {
  return <HomeStage />;
}
