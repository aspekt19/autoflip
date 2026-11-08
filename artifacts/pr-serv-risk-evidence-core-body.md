## Summary

OWNER 334 CORE gap: free-gov packets were collapsing to summary/note strings, so grounded shortlist stayed static `unknown` and could not drive conditional risk decisions. This PR keeps **structured risk evidence** (scope, source URL, listing MMY mapping, separate NHTSA flags, campaign refs) on server receipts and feeds them into shortlist / SERV planner facts.

**Separate PR from auth/billing** (`bc-c3e53cc6-9717-5074-8336-f45cd989b148` / t334 quota). Do not merge auth into this PR.

### Mechanism (general — no hardcoded models)

1. **Scout free-gov** separates `parkIt` vs `parkOutside` (no OR into one do-not-drive flag); emits `nhtsa_park_it` and/or `nhtsa_park_outside`.
2. **Find receipts** retain `riskFacts` + `sourceUrl` (not summary-only).
3. **MMY-keyed shortlist** (`find-risk-evidence.ts`) maps receipts → model rows: investigate / parkOutside flag / complaints-only / unchecked / empty — never auto-buy; parkOutside alone ≠ do-not-drive; complaints ≠ reject.
4. **Coverage honesty** for sample size vs full listing MMY inventory.
5. **Receipt merge + structured fingerprint** so cached duplicates cannot fake evidence-changed loops.
6. **SERV find_next_check** profile prefers useful next action when `riskFacts.parkIt=true` (vPIC / history / widen) over median settle.

### Pins

| Pin | Value |
| --- | --- |
| Branch | `cursor/serv-risk-evidence-core-b667` |
| Base | `origin/main` @ `17bc81839595c627de7ffead5c1ac5b28176d7af` |
| Tip | `b91b19527f6887c05ff686c263503f5d3202e265` |
| Tree | `1332a95d12828f372ae7c20b7508bd66d513c76a` |
| Implement | `4353efae20219acaa1f93c02a0d4e9fbf000de56` |
| CI | no Actions run until PR opened (compare URL below) |

### Tests

- Negative parkOutside-only → `mmy_park_outside_flag`, not `mmy_park_it_investigate`
- Unchecked MMY / no VIN → unknown, not cleared
- Complaints-only → stays on shortlist, not reject
- parkIt → conditional investigate + outstanding checks + campaign refs
- Duplicate cached merge → stable fingerprint
- 3 MMY sample vs 24 cards → coverage honesty
- Route: receipts expose `riskFacts`/`sourceUrl` + `riskCoverage`

### Remaining gaps

- Full-report `openParkIt` still ORs parkIt\|\|parkOutside in `report.ts` / assemble (Find path fixed; report path residual).
- UI still client-mirrors receipts for shortlist; server shortlist is authoritative on next-check response.
- Paid history still user-action — no autocharge (intentional).
- Live Scenario2 re-eval after merge/publication (parent).

### Open PR

https://github.com/aspekt19/autoflip/compare/main...cursor/serv-risk-evidence-core-b667?expand=1

### Coord

- Auth/billing agent on separate branch — freeze/do not merge into this PR.
- No SERV call cap / Graph / Fable / env / model / deploy changes.
