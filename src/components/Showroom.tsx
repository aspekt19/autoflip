"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, useState, type ReactNode } from "react";
import type { Mode } from "@/domain/types";

const ShowroomCanvas = dynamic(() => import("./ShowroomCanvas"), { ssr: false });

class SceneBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFail();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function webglOk() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Full-viewport studio. The poster stays until the scene paints, and stays for good when 3D is off. */
export function Showroom({ mode }: { mode: Mode }) {
  const [live, setLive] = useState(false);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const narrow = window.matchMedia("(max-width: 800px)").matches;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const low = (nav.deviceMemory !== undefined && nav.deviceMemory <= 2) || (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 2);
    if (reduce || narrow || low || !webglOk()) return;
    const id = requestAnimationFrame(() => setLive(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="showroom-fixed" aria-hidden="true">
      <img className={painted ? "showroom-poster is-hidden" : "showroom-poster"} src="/hero-suv.jpg" alt="" width={1400} height={788} />
      {live ? (
        <SceneBoundary onFail={() => setPainted(false)}>
          <ShowroomCanvas mode={mode} onReady={() => setPainted(true)} />
        </SceneBoundary>
      ) : null}
    </div>
  );
}
