import Link from "next/link";

type BrandLockupProps = {
  href?: string;
  size?: number;
  animated?: boolean;
  /** Dark UI uses notile mark; light UI uses white-surface mark with true yellow lemon. */
  surface?: "dark" | "light";
  className?: string;
  showWordmark?: boolean;
};

/** Live site wordmark stays Orbitron via `.brand-name`. Pack supplies mark only. */
export function BrandLockup({
  href = "/",
  size = 40,
  animated = true,
  surface = "dark",
  className = "brand",
  showWordmark = true,
}: BrandLockupProps) {
  const staticSrc = surface === "light" ? "/brand/mark-white.svg" : "/brand/mark-notile.svg";
  const animatedSrc = surface === "light" ? "/brand/mark-white.svg" : "/brand/mark-animated-notile.svg";
  const markSrc = animated && surface === "dark" ? animatedSrc : staticSrc;
  const classes = [className, surface === "light" ? "surface-light" : "surface-dark"].filter(Boolean).join(" ");

  const inner = (
    <>
      <img className="brand-mark" src={markSrc} alt="" width={size} height={size} />
      {showWordmark ? (
        <span className="brand-name" aria-label="Lemonless">
          <span className="brand-lemon">Lemon</span>
          <span className="brand-less">less</span>
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link className={classes} href={href}>
        {inner}
      </Link>
    );
  }
  return <span className={classes}>{inner}</span>;
}

/** Exact string: Buy smart. Stay lemonless. — neutral / lemon yellow / less. red, no gap. */
export function BrandTagline({ className = "foot-tagline" }: { className?: string }) {
  return (
    <p className={className}>
      <span className="tagline-prefix">Buy smart. Stay </span>
      <span className="tagline-lemon">lemon</span>
      <span className="tagline-less">less.</span>
    </p>
  );
}

export function BrandHeroTitle() {
  return (
    <h1 className="brand-hero-title">
      <span className="tagline-prefix">Buy smart. Stay </span>
      <span className="tagline-lemon">lemon</span>
      <span className="tagline-less">less.</span>
    </h1>
  );
}
