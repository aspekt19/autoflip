# SERV fixtures — honesty rules

**Never invent SERV responses for the site, jury docs, or screenshots.**

| Path | Allowed? |
|------|----------|
| `recordings/verdict-revision.latest.json` | **Only** after a live capture via `npm run eval:record-serv-revision` (raw request/response, model, timestamp, OpenServ ids). |
| `*.test.ts` inline mocks | OK for unit tests. Must never be imported by `/report/sample` or quoted in docs as a real run. |
| Agent-written “buy → negotiate” examples | **Forbidden** on the product surface. |

If no recording exists, `/report/sample` shows **Example not yet recorded**.
