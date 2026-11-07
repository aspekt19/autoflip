# Bebas Neue (vendored latin WOFF2)

## Why vendored

`next/font/google` Bebas Neue fetch/parse can flake in CI (null CSS), same class
of failure previously seen for Manrope / Orbitron. These files are self-hosted
via `next/font/local` in `src/app/layout.tsx`.

## Exact files in this directory

| File | Weight | SHA-256 |
| --- | --- | --- |
| `bebas-neue-latin-400-normal.woff2` | 400 | `02f5dfc0c21e92f3c724260f035833e627513a1b91230cc490a1ea756c95e5e5` |

Byte-identical to Fontsource CDN latin subset:

`https://cdn.jsdelivr.net/fontsource/fonts/bebas-neue@5.2.5/latin-400-normal.woff2`

## Upstream / license

- Family: **Bebas Neue** (designer Dharma Type / Ryoichi Tsunekawa)
- Google Fonts tree: https://github.com/google/fonts/tree/main/ofl/bebasneue
- License: **SIL Open Font License 1.1** — see `OFL.txt` in this directory
  (copied from `google/fonts` `ofl/bebasneue/OFL.txt`)

Do not replace these files without updating hashes and license/source notes.
