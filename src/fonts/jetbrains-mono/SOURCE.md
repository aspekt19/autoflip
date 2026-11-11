# JetBrains Mono (vendored latin WOFF2)

## Why vendored

`next/font/google` fetches flake in CI (null CSS parse), same as Manrope /
Orbitron / Bebas. These files are self-hosted via `next/font/local` in
`src/app/layout.tsx` as `--font-mono` for prices, mileage, VINs, scores, and ids.

## Exact files in this directory

| File | Weight | SHA-256 |
| --- | --- | --- |
| `jetbrains-mono-latin-400-normal.woff2` | 400 | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |
| `jetbrains-mono-latin-500-normal.woff2` | 500 | `cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a` |
| `jetbrains-mono-latin-600-normal.woff2` | 600 | `400c6bfda18d5d14acad1c15d6dcb9f8e13c015e7286317e0b9a482539bef147` |
| `jetbrains-mono-latin-700-normal.woff2` | 700 | `d0d4e818808f2a0ba39b2b09d1989366f63494e295f003c7ef436697378507e8` |

Byte-identical to Fontsource CDN latin subsets:

`https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@5.2.8/latin-{400,500,600,700}-normal.woff2`

## Upstream / license

- Family: **JetBrains Mono** (JetBrains)
- Project: https://github.com/JetBrains/JetBrainsMono
- Google Fonts tree: https://github.com/google/fonts/tree/main/ofl/jetbrainsmono
- License: **SIL Open Font License 1.1** — see `OFL.txt` in this directory
  (copied from `google/fonts` `ofl/jetbrainsmono/OFL.txt`)
- Copyright: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

Do not replace these files without updating hashes and license/source notes.
