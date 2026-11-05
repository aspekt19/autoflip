import type { Metadata } from "next";
import { HomeStage } from "@/components/HomeStage";

export const metadata: Metadata = { title: "A clear verdict on a used car" };

export default function HomePage() {
  return <HomeStage />;
}
