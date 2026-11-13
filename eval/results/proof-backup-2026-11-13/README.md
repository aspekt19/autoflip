# Proof backup — 2026-11-13

This directory documents an immutable pre-Gemini snapshot of the complete AutoFlip repository.

- Backup branch: `backup/proof-pre-gemini-2026-11-13`
- Snapshot commit: `745763eab78a87b93d79e8caa246e6da2565e4b8`
- Source branch at capture: `cursor/snapshot-compare-1103`
- Purpose: preserve every Proof page, data file, supporting capture, and link target before replacing/cleaning the Proof presentation for the Find-vs-Gemini experiment.

## What is preserved

The backup branch points to the full repository state at the snapshot commit, not just selected JSON files. In particular, the original Proof implementation and data are preserved at their original paths:

- `src/app/proof/page.tsx`
- `src/app/proof/answer-text.tsx`
- `src/domain/proof-page-runs.ts`
- `eval/results/proof-serv-compare-2026-11-13.json`
- `eval/results/snapshot-serv-ab-2026-11-13.json`
- `eval/results/comparison-latest.json`
- `eval/results/serv-proof-trace.json` and `serv-proof-trace.md`
- `eval/results/serv-vs-baseline-latest.json`
- All files in `eval/results/compare-2026-11-13/`, including the original Perplexity capture, plain-LLM response, both Lemonless run records and reports, NHTSA/VIN decode data, and URL/source checks.

Other repository files and the full Git history up to the snapshot are preserved as well.

## Restore procedure

To restore the pre-Gemini Proof exactly, copy the files above from this backup branch back onto the working branch, or create a recovery branch from the snapshot commit. Do not restore the entire repository blindly if unrelated fixes made after the snapshot need to be retained; restore only the Proof paths that were changed.

This backup is intentionally kept separate from the working PR. New test data must not overwrite anything on this backup branch.
