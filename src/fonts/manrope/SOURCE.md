# Manrope (vendored latin WOFF2)

## Why vendored

`next/font/google` Manrope fetch/parse fails in CI (null CSS). These files are
self-hosted via `next/font/local` in `src/app/layout.tsx`. Orbitron and
Bebas Neue remain Google-fetched.

## Exact files in this directory

| File | Weight | SHA-256 |
| --- | --- | --- |
| `manrope-latin-400-normal.woff2` | 400 | `849290ef12a2eeb9af5c11924120d11aa4ae8b435ed3347d7fc8bc240c293ca3` |
| `manrope-latin-500-normal.woff2` | 500 | `19874318747181a650eda439c37955220b849d9c4797c9e0718ee67d4bf929bc` |
| `manrope-latin-600-normal.woff2` | 600 | `f7ac6258da20ab7541939b59851155753d1d24f1b30cbcb949077a3faa3d1593` |
| `manrope-latin-700-normal.woff2` | 700 | `d2a12c85a831e4b5db341767d0347fa3d1361d22a1fcb3e361a16b6c90080f71` |

Byte-identical to Fontsource CDN latin subsets:

`https://cdn.jsdelivr.net/fontsource/fonts/manrope@5.2.8/latin-{400,500,600,700}-normal.woff2`

(Verified against `@5.2.6` / `@5.2.7` / `@5.2.8` / `@5.3.0` / `@latest` at packaging time.)

## Upstream / license

- Family: **Manrope** (designer Mikhail Sharanda)
- Project: https://github.com/googlefonts/manrope
- Google Fonts tree: https://github.com/google/fonts/tree/main/ofl/manrope
- License: **SIL Open Font License 1.1** — see `OFL.txt` in this directory
  (copied from `google/fonts` `ofl/manrope/OFL.txt`)
- Copyright: Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope)

Do not replace these files without updating hashes and license/source notes.
