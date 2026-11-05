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

## Real-car shortlist

All six are filmed cars under the Mixkit Stock Video Free License (https://mixkit.co/license/modal/videoFree/): commercial use and modification are allowed, attribution is not required. Stills are `cand-1.jpg` through `cand-6.jpg`.

| Still | Clip | Why it was or was not used |
|---|---|---|
| cand-1 | [Red sports car side view](https://mixkit.co/free-stock-video/red-sports-car-side-view-50/) | Chosen. Dark garage, real paint, and the camera tracks along the body, so a scroll scrub moves. |
| cand-2 | [Closeup of red sports car](https://mixkit.co/free-stock-video/closeup-of-red-sports-car-49/) | Dark and glossy, but the frame is only the bumper and a headlight. |
| cand-3 | [Close up of red sports car](https://mixkit.co/free-stock-video/close-up-of-red-sports-car-63/) | Real paint, too tight (fuel door) to read as a whole car. |
| cand-4 | [Parked red sports car](https://mixkit.co/free-stock-video/parked-red-sports-car-66/) | Whole car in a dark bay, little camera move. |
| cand-5 | [BMW in a parking lot](https://mixkit.co/free-stock-video/bmw-in-a-parking-lot-3527/) | Real car, daylight, mostly a wheel. |
| cand-6 | [Red sports car on a curvy road at dawn](https://mixkit.co/free-stock-video/a-red-sports-car-traveling-along-a-curvy-asphalt-road-52427/) | Real car, but small in a bright landscape. |

A rear-view white muscle car on Mixkit looked computer-rendered, so it was dropped.

## Scroll film (this site)

The hero is a scroll-scrubbed frame sequence. The clip is an AI-generated night-city scene made for this project: a graphite coupe. The sequence uses its first 4.0 seconds and stops on a wide side view, before the frontal close-ups, interior shots, and departure. See `CREDITS.md`.

ffmpeg extracted 48 desktop WebP frames (1920px, 12 fps) and 32 phone frames (960px, 8 fps), plus a poster from the first frame. A canvas in a pinned hero draws the frame GSAP ScrollTrigger selects. Frames load as the scroll approaches them; the poster shows first. Phones use the lighter set and still scrub. Reduced motion holds the poster with the form visible. Choosing For me or For resale eases the frame a few percent sideways. The headline and search sit over the opening wide shot, then fade to leave the side view unobstructed. A caption on the hero reads “Not a car for sale.” Pinned scroll is 150vh on desktop and 142vh on a phone.
