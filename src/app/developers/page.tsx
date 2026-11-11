import type { Metadata } from "next";
import { AgentKeys } from "@/components/AgentKeys";
import { resolveProductFlags } from "@/domain/product-flags";

export const metadata: Metadata = { title: "Agents" };

/** Scout link follows the runtime flag. Do not bake SCOUT_UI_ENABLED. */
export const dynamic = "force-dynamic";

export default function DevelopersPage() {
  const scout = resolveProductFlags().scout;
  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <h1>For agents</h1>
        <p className="lead">
          An agent can run the same Check, Find, Resale, and Deal Radar a person uses on the site — same SERV
          plan/decide/second-check path and the same report with decision journal. Create a key for this browser, then send
          it as <code>Authorization: Bearer af_…</code>. Credits settle only after success. Site UI stays sign-in gated.
        </p>

        <section>
          <h2>MCP / API tools</h2>
          <p>
            Public discovery: <a href="/llms.txt">/llms.txt</a>, <a href="/openapi.json">/openapi.json</a>,{" "}
            <a href="/.well-known/agent.json">/.well-known/agent.json</a>. Transparency:{" "}
            <a href="/where-serv-runs">/where-serv-runs</a>, <a href="/proof">/proof</a>,{" "}
            <a href="/verify">/verify</a>.
          </p>
          <ul>
            <li>
              <code>check_car</code> / <code>POST /api/v1/check</code> — free monthly Check allotment when available, else 1 report credit after success. Scope: <code>check</code>. Returns <code>proofRecords</code>.
            </li>
            <li>
              <code>find_cars</code> / <code>POST /api/v1/find</code> — async; 1 report credit after a successful search. Scope: <code>find</code>. Result includes <code>proofRecords</code>.
            </li>
            <li>
              <code>resale_search</code> / <code>POST /api/v1/resale</code> — async budget Resale; 1 report credit when the final verdict is delivered. Scope: <code>find</code>. Poll status/result for journal + <code>proofRecords</code>.
            </li>
            <li>
              <code>deal_radar</code> is a one-shot listing scan under scope <code>read</code>. Saved watches use{" "}
              <code>radar_watches</code> / <code>radar_save_watch</code> / <code>radar_check_now</code> / <code>radar_feed</code>{" "}
              (or <code>/api/v1/radar/*</code>) and require a paid Radar ($100/mo) or Radar Pro ($250/mo) plan — same gates as{" "}
              <a href="/radar">Deal Radar</a>. <code>full_report</code> costs 1 credit (scope <code>check</code>).
            </li>
            <li>
              Resale search is the site <a href="/resale">/resale</a> flow (1 credit) with the same decision-proof journal shape when SERV settle runs. Agent MCP exposure for resale follows the same <code>proofRecords</code> contract when enabled on the server.
            </li>
          </ul>
          <p>
            Failures return <code>credit_spent: false</code>. Reuse the same <code>Idempotency-Key</code> (or JSON-RPC{" "}
            <code>id</code>) to retry without a second charge. Keys are rate-limited to 30 calls per minute.
          </p>
          <p>
            Optional x402 v2 (USDC on Base) pay-per-check/find stays <strong>disabled by default</strong> behind{" "}
            <code>X402_AGENT_PAYMENTS_ENABLED</code>. When enabled, a missing payment with no credits returns HTTP 402 +{" "}
            <code>PAYMENT-REQUIRED</code>; settlement happens only after results are delivered.
          </p>
        </section>

        <AgentKeys scoutEnabled={scout} />

        <section>
          <h2>Discovery</h2>
          <ul>
            <li>
              <a href="/.well-known/agent.json">
                <code>/.well-known/agent.json</code>
              </a>
            </li>
            <li>
              <a href="/llms.txt">
                <code>/llms.txt</code>
              </a>{" "}
              ·{" "}
              <a href="/llms-full.txt">
                <code>/llms-full.txt</code>
              </a>
            </li>
            <li>
              <a href="/openapi.json">
                <code>/openapi.json</code>
              </a>
            </li>
            <li>
              Verdict schema: <code>lemonless.agent_verdict.v1</code> (
              <a href="https://github.com/aspekt19/autoflip/blob/main/docs/agent-verdict-schema.json">docs</a>)
            </li>
            <li>
              Decision proof: <code>lemonless.decision_proof.v1</code> on success field{" "}
              <code>proofRecords</code> (same object on site, MCP <code>tools/list</code> /{" "}
              <code>tools/call</code>, and <code>af_</code> REST).{" "}
              <code>servResponseId</code> only when <code>status</code> is <code>ok</code>.
            </li>
          </ul>
        </section>

        <section>
          <h2>Decision proof</h2>
          <p>
            Every successful Check / Find / Deal Radar agent response includes{" "}
            <code>proofRecords</code>: an array of <code>lemonless.decision_proof.v1</code> rows (
            purpose, rubricId, status, servResponseId, model, timestamp, inputsDigest, verdict,
            clampResult, reason, optional rawResponse). Docs here list field names only — no
            invented filled rows. A published JSON example must come from a real run (response id,
            model, timestamp, and raw response) or be omitted.
          </p>
          <ul>
            <li>
              <code>check_car</code> — decide/challenge rows when SERV ran; a{" "}
              <code>skipped</code> row with the withhold reason when <code>SERV_API_KEY</code> is set
              but gates withhold decide; <code>[]</code> only when <code>SERV_API_KEY</code> is not
              configured (never invents a response id).
            </li>
            <li>
              <code>find_cars_result</code> — need-parse and verdict rows from that Find run.
            </li>
            <li>
              <code>deal_radar</code> — Deal Radar make/model scan. Always exactly one <code>radar_guard</code> row (
              <code>ok</code>, <code>skipped</code> when the key is missing, or <code>failed</code>).
            </li>
            <li>
              <code>resale_result</code> / Radar <code>check_now</code> — Resale and saved-search decision journals
              plus <code>proofRecords</code> from the same SERV plan/decide path as the site.
            </li>
          </ul>
        </section>

        <section>
          <h2>Resale (budget)</h2>
          <pre className="doc">{`# 1) create
curl -s -X POST https://autoflip-umber.vercel.app/api/v1/resale \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -H 'idempotency-key: resale-demo-1' \\
  -d '{"budgetUsd":12000,"zip":"78701"}'
# → { "job_id":"…", "status":"running", … }

# 2) status / result
curl -s https://autoflip-umber.vercel.app/api/v1/resale/JOB_ID/status \\
  -H 'authorization: Bearer af_YOUR_KEY'
curl -s https://autoflip-umber.vercel.app/api/v1/resale/JOB_ID \\
  -H 'authorization: Bearer af_YOUR_KEY'`}</pre>
        </section>

        <section>
          <h2>Deal Radar watches</h2>
          <pre className="doc">{`curl -s https://autoflip-umber.vercel.app/api/v1/radar/watches \\
  -H 'authorization: Bearer af_YOUR_KEY'

curl -s -X POST https://autoflip-umber.vercel.app/api/v1/radar/watches \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -d '{"name":"Flip under 12k","mode":"flip","criteria":{"priceMax":12000,"zip":"78701","radiusMiles":100}}'

curl -s -X POST https://autoflip-umber.vercel.app/api/v1/radar/check \\
  -H 'authorization: Bearer af_YOUR_KEY'`}</pre>
        </section>

        <section>
          <h2>Check a car (curl)</h2>
          <pre className="doc">{`curl -s https://autoflip-umber.vercel.app/api/v1/check \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -H 'idempotency-key: check-demo-1' \\
  -d '{"vin":"4T1BF1FK0EU848445"}'`}</pre>
        </section>

        <section>
          <h2>Find cars (async)</h2>
          <pre className="doc">{`# 1) create
curl -s -X POST https://autoflip-umber.vercel.app/api/v1/find \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -H 'idempotency-key: find-demo-1' \\
  -d '{"text":"Reliable SUV under $18k near 78701"}'
# → { "run_id":"…", "status":"queued", "current_step":"queued", … }

# 2) status
curl -s https://autoflip-umber.vercel.app/api/v1/find/RUN_ID/status \\
  -H 'authorization: Bearer af_YOUR_KEY'

# 3) result
curl -s https://autoflip-umber.vercel.app/api/v1/find/RUN_ID \\
  -H 'authorization: Bearer af_YOUR_KEY'`}</pre>
        </section>

        <section>
          <h2>MCP</h2>
          <p>
            <code>POST /api/mcp</code> speaks JSON-RPC: <code>initialize</code>, <code>tools/list</code>,{" "}
            <code>tools/call</code>, and <code>ping</code>. <code>GET /api/mcp</code> describes the server.
          </p>
          <h3>Cursor / Claude Desktop</h3>
          <pre className="doc">{`{
  "mcpServers": {
    "lemonless": {
      "url": "https://autoflip-umber.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer af_YOUR_KEY" }
    }
  }
}`}</pre>
          <h3>OpenServ auth note</h3>
          <p>
            OpenServ (and similar hosts) must forward <code>Authorization: Bearer af_…</code> on{" "}
            <strong>every</strong> JSON-RPC POST, including each <code>tools/call</code>. If the header is only sent on{" "}
            <code>initialize</code>, later calls return <code>auth_required</code> with <code>credit_spent: false</code>.
            Store the key as a platform secret and smoke-test with <code>tools/list</code> before a paid tool.
          </p>
        </section>

        <section>
          <h2>Success fields (Check)</h2>
          <p>
            Successful <code>check_car</code> / <code>POST /api/v1/check</code> returns the fixed
            agent envelope: <code>schema_version</code>, <code>tool</code>, <code>verdict</code>,{" "}
            <code>confidence</code>, <code>summary</code>, <code>reasons</code>, <code>risks</code>,{" "}
            <code>unknowns</code>, <code>subject</code>, <code>comparables_summary</code>,{" "}
            <code>serv</code>, <code>proofRecords</code>, <code>code_computed</code>,{" "}
            <code>credit_spent</code>, <code>credits</code>, <code>free_check_spent</code>,{" "}
            <code>receipt_id</code>, <code>result</code>. Call the live API for a real payload —
            this page does not invent sample values.
          </p>
          <p>Errors always include <code>error_code</code>, <code>credit_spent</code>, <code>retry_safe</code>, and a concrete <code>next_steps.request</code>.</p>
        </section>

        <section>
          <h2>Receipts</h2>
          <pre className="doc">{`curl -s https://autoflip-umber.vercel.app/api/v1/receipts \\
  -H 'authorization: Bearer af_YOUR_KEY'`}</pre>
        </section>

        <section>
          <h2>Scout grants (owner → operator)</h2>
          <p>
            Live Scout spend is not created by minting a key. After you create a key above, copy the binding card (
            <code>ownerUserId</code> + <code>apiKeyHash</code>) and send it to your operator through a channel they trust.
            Never paste the <code>af_</code> token into chat.
            {scout ? (
              <>
                {" "}
                Then open a signed session on <a href="/scout">/scout</a> with the key that stays in this browser.
              </>
            ) : (
              <> Scout is not available in this preview, so this page does not link to it.</>
            )}
          </p>
        </section>

        <section>
          <h2>Saved searches and storage</h2>
          <p>
            Persistent storage is Upstash Redis (<code>UPSTASH_REDIS_REST_URL</code> / <code>UPSTASH_REDIS_REST_TOKEN</code>
            ). Locally, keys and credits fall back to <code>.data/kv.json</code>. Site report credits are the default.
            Optional x402 agent payments stay off until <code>X402_AGENT_PAYMENTS_ENABLED</code> is explicitly set.
          </p>
        </section>
      </div>
    </div>
  );
}
