# Showroom style notes

Observed in the browser. Nothing from those sites was copied: no code, CSS bundles, images, video, logos, or sentences. The motion and the palette below were rebuilt in this repo.

## LEVRIX (`https://levrix.framer.website/`)

- Black page (`rgb(0, 0, 0)`), white headlines, body copy about `rgb(217, 217, 217)`.
- Display face: Orbitron 600/700, headlines about 44–48px with slight tracking. Body: Manrope 400/600. Fragment Mono and Inter were also loaded; the visible type is Orbitron and Manrope. All three of those families are on Google Fonts under the SIL Open Font License, so Orbitron and Manrope are loaded with `next/font`.
- Primary button fill `rgb(219, 4, 4)`, white label, square corners. A second control is an outline.
- Hero is a full-viewport car film. A huge metallic wordmark sits across the car. The headline sits low on the left. A short paragraph and the red button sit low on the right.
- Next band is a centered statement, then three large figures with a red suffix and thin dividers.
- A split follows: large type and an outline button on the left, a rounded car photograph on the right, then three dark cards with a small red mark.
- Inventory is a tall stack of large rounded photographs with the name and a spec line laid on the image.
- Later bands (why, offers, a full-viewport video, gallery) keep the same black field and the same type scale.

Rebuilt here: the black field, the red action color, Orbitron for the wordmark and small labels, Manrope for body copy, the full-viewport hero with the wordmark over the car, glass cards, and the low-left form.

## Detailing studio (`https://detailingcarstudio.framer.website/`)

- Display face: Big Shoulders 700/800, very large (72px and 120px) and tight. Body and nav: Geist. Big Shoulders is on Google Fonts (OFL). This Next.js version exposes it as `Big_Shoulders` (the current Google family name). Geist is also OFL, but Manrope already covers the body, so Geist is not loaded.
- Accent `rgb(232, 98, 44)` on a pill button. Nav is a floating dark capsule.
- The wash sequence is one sticky viewport, about 3600px of scroll, stepping a car through four states while a line of type and a `01`–`04` rail change. A horizontal ticker sits under that.
- A two-line manifesto uses black type and then the accent color at the same size.

Rebuilt here: Big Shoulders for headlines, the floating capsule nav, the marquee, and scroll that moves one car through several home sections instead of swapping photographs. The accent on actions stays the LEVRIX red so the site has one action color.

## Scroll choreography (this site)

The car and camera are driven with GSAP ScrollTrigger across `.home-story`. Progress turns the model and pulls the camera from a front three-quarter view toward a higher, tighter view. Choosing For me or For resale eases the camera sideways. Lenis smooths the wheel. Each route fades in. Reveals use a scroll-driven CSS timeline where the browser supports it.

The 3D scene is lazy, after first paint. The chat form is in the first HTML. A static Pexels photo covers the hero until the scene paints, and it stays on a phone, a low-power device, reduced motion, or when WebGL is missing.

## Model and light

- Car: Kenney Car Kit `suv-luxury`, CC0, confirmed on https://kenney.nl/assets/car-kit (“Creative Commons CC0”). File `public/models/showroom-suv.glb`, meshopt, under 5 MB. Not a car for sale.
- Light: Poly Haven `studio_small_03` 1k HDR, CC0, https://polyhaven.com/a/studio_small_03. File `public/hdri/studio.hdr`.
