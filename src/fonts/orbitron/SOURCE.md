# Orbitron (vendored latin WOFF2)

## Why vendored

`next/font/google` Orbitron fetch/parse flakes in CI (null CSS), same class of
failure previously seen for Manrope. These files are self-hosted via
`next/font/local` in `src/app/layout.tsx`.

## Exact files in this directory

| File | Weight | SHA-256 |
| --- | --- | --- |
| `orbitron-latin-500-normal.woff2` | 500 | `c13360768270c65d6c97701b100a88993885671dfdfd2a400aa58ea0195381ea` |
| `orbitron-latin-600-normal.woff2` | 600 | `585062e775d70397653192777533f65f3afb707320fcc2a4bc510470e03762e6` |
| `orbitron-latin-700-normal.woff2` | 700 | `ee6acc5ad5349018f9ca71fab8118144160e110838931874150a1ac3f97db38d` |

Byte-identical to Fontsource CDN latin subsets:

`https://cdn.jsdelivr.net/fontsource/fonts/orbitron@5.2.8/latin-{500,600,700}-normal.woff2`

## Upstream / license

- Family: **Orbitron** (designer Matt McInerney)
- Project: https://github.com/theleagueof/orbitron
- Google Fonts tree: https://github.com/google/fonts/tree/main/ofl/orbitron
- License: **SIL Open Font License 1.1** — see `OFL.txt` in this directory
  (copied from `google/fonts` `ofl/orbitron/OFL.txt`)

Do not replace these files without updating hashes and license/source notes.
