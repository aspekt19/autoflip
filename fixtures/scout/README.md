# Scout fixtures

- **Real-source replay (only one in-repo):** `fixtures/autodev-camry.json` at repo root (Auto.dev listings payload; offline proof). Cited as `REPLAY_CAMRY_PROVENANCE`. No other real-source snapshots exist — do not invent provenance.
- **`adversarial-contradiction.json`:** **NOT live evidence** — synthetic adversarial rows for reject/replace / insufficient-evidence tests.
- Production API must label replay with `isFixture: true` / `presentation.kind = fixture_replay` and must never present these as live Auto.dev pulls.
