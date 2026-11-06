Measured evaluation outputs live here after a real `npm run eval:serv` / `npm run eval:trace` run.

- `latest.json` / `latest.md` — baseline versus SERV comparison used by `/compare`.
- `serv-proof-trace.json` / `serv-proof-trace.md` — one redacted Proof of AI trace for the fixed `flip-clear` fixture.

Do not invent rows. Commit only files produced by a real SERV API run. The GitHub Actions workflows upload artifacts and refresh fixed `evidence/*-latest` branches for review before maintainers merge updated files into `main`.
