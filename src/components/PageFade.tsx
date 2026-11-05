"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/** A short entrance on each route. The pages themselves stay server-rendered. */
export function PageFade({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div key={path} className="page-in">
      {children}
    </div>
  );
}
