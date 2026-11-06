# Lemonless — approved logo install pack

## ⚠️ CRITICAL — typography (read first)

**Keep the live website’s existing wordmark font, size, weight, letter-spacing, and all site text typography unchanged.**

The owner rejected exploration fonts (v2 F1–F5 Outfit/Montserrat/… and type-exploration T1–T6).  
What he likes is the **current production site logo type**.

This pack ships the **polished C2 magnifier mark + animation + color tokens**.  
The integration agent must:

1. Read the current site header/logo implementation.
2. Swap / upgrade **only the mark** (and favicon / apple / OG mark assets) to files in this pack.
3. **Retain** the existing LEMON / LESS wordmark font face, optical size, weight, tracking, and layout.
4. Apply the color tokens below to that existing wordmark / tagline (if not already exact).
5. Wire `mark-animated.svg` (or equivalent CSS) with `prefers-reduced-motion` → static `mark.svg` / `mark-notile.svg` / `mark-white.svg`.
6. **Do not** replace site-wide fonts. **Do not** commit Inter / Outfit / Fredoka lockups as the production wordmark.

Optional Inter composites from earlier `/logo/final/` work are **not** the live font and are **not** included here as install wordmarks.

---

## Approved mark

Polished v2 C2: lemon under magnifier (hand béziers, gradient, leaf, glass ring, red handle + ferrule).

| File | Use |
|------|-----|
| `mark.svg` | Dark UI with rounded tile |
| `mark-notile.svg` | Transparent; prefer for header on dark |
| `mark-white.svg` | Light UI — near-black ring, **no dark tile**, lemon stays `#FFD60A` |
| `mark-animated.svg` | CSS keyframes once; reduced-motion → static |
| `favicon.svg` / `favicon-16.png` / `favicon-32.png` | Favicon (simplified thicker ring) |
| `apple-touch-icon.png` | 180×180 |
| `icon-512.png` | PWA / maskable source (tiled) |
| `icon-512-notile.png` | 512 without tile if needed |
| `og-logo.png` | 1200×630 social (mark + color legend; wordmark left to site) |
| `animation-preview.gif` / `.mp4` | Review only — ship SVG animation in product |
| `preview.png` | Handoff overview |
| `qa-header-mark-*.png` | Visual QA of mark at header sizes (wordmark omitted on purpose) |

## Colors (apply to existing site wordmark / tagline)

| Token | Hex | Notes |
|-------|-----|--------|
| LEMON (word) | `#FFD60A` | Real yellow on dark **and** white — never mustard/amber `#C9A000` |
| LESS dark | `#ff3b3b` | Dark backgrounds |
| LESS light | `#db0404` | Light backgrounds |
| Tagline prefix `Buy smart. Stay ` | `#b7b7b7` dark / `#555555` light | Neutral |
| Tagline `lemon` | `#FFD60A` | |
| Tagline `less.` | `#ff3b3b` / `#db0404` | No artificial gap between lemon + less. |
| On white yellow | optional thin `#111` outline | Only if contrast fails; keep fill `#FFD60A` |

Exact tagline string: **Buy smart. Stay lemonless.**  
Split colors: neutral prefix → yellow `lemon` → red `less.` (no space inserted between lemon/less).

## Animation

`mark-animated.svg`: lens ring draws → lemon focuses → handle/leaf settle (~1.2s once).  
`@media (prefers-reduced-motion: reduce)` disables animation (static final state).  
If the live site already slides LESS in, keep that behavior composed with this mark — do not invent a new visual direction.

## Integration checklist

- [ ] Inspect current logo component / CSS for font-family, weight, size, tracking
- [ ] Replace mark SVG/PNG sources with this pack
- [ ] Update favicon / apple-touch / og image paths
- [ ] Confirm LEMON/LESS + tagline colors match tokens
- [ ] Confirm white UI: yellow stays `#FFD60A`, ring dark, no unnecessary dark tile behind mark
- [ ] Confirm header + mobile: full wordmark letters visible (no clip) at live sizes
- [ ] Animation + reduced-motion static
- [ ] No change to body/UI font stack

## Out of scope for this pack

- Repo edits / deploy (integration agent owns that)
- New typography direction
- Slash / ban marks
