# OpenServ Graph — hackathon ban (owner t257/t258)

**Status:** binding for contest / hackathon work.

## Rule

**OpenServ Graph is FORBIDDEN** for the hackathon:

- Do **not** use Graph directly or indirectly in contest code, architecture, demos, or claims.
- Graph may be considered only **after** the hackathon **and** a public release — not now.
- Do **not** confuse ordinary diagrams (e.g. mermaid `subgraph`), Next.js `openGraph` metadata, or the words “paragraph” / “photograph” with the banned **OpenServ Graph** product.

## Product purpose (reminder)

Lemonless is **autonomous used-car search and selection** for self-buy or resale — not a report generator or tech showroom. OpenServ/SERV chooses useful next actions, checks, and replans; TypeScript owns deterministic facts, math, and hard gates. At most **five** justified investigation candidates, or an honest abstain. Preserve approved branding.

## Audit (PR59 / scout branch, offline)

| Check | Result |
|-------|--------|
| `package.json` / lockfile Graph package | **None** |
| Scout domain/server/OpenServ adapter imports Graph API | **None** |
| `DOCUMENTED_FEATURES` includes `graph` | **No** |
| Existing SERV profile registry configures Graph | **No** (comment previously implied Graph under every call — corrected) |
| Kronos / Multipath suffixes | Present as SERV Reasoning model features; **not** Graph product |
| Mermaid `subgraph` in README | Ordinary diagram syntax — **allowed** |
| `openGraph` in `layout.tsx` | Next.js social meta — **allowed** |

Independent security review of PR59 is external; this file does **not** self-approve merge/deploy. No live spend / remote provisioning from this audit.
