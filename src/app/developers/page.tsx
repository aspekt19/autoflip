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
          An agent can run the same Check and Find a person uses on the site. Create a key for this browser, then send it as{" "}
          <code>Authorization: Bearer af_…</code>. Credits settle only after success. Site UI stays sign-in gated.
        </p>

        <section>
          <h2>What each tool costs</h2>
          <ul>
            <li>
              <code>check_car</code> / <code>POST /api/v1/check</code> — free monthly Check allotment when available, else 1 report credit after success. Scope: <code>check</code>.
            </li>
            <li>
              <code>find_cars</code> / <code>POST /api/v1/find</code> — async; 1 report credit after a successful search. Scope: <code>find</code>.
            </li>
            <li>
              <code>deal_radar</code> is a one-shot listing scan under scope <code>read</code> — it does not create a saved watch and does not unlock Deal Radar. Saved watches require a paid Radar ($100/mo) or Radar Pro ($250/mo) plan on the signed-in{" "}
              <a href="/radar">Deal Radar</a> page; full report still costs 1 credit. <code>full_report</code> costs 1 credit (scope <code>check</code>).
            </li>
          </ul>
          <p>
            Failures return <code>credit_spent: false</code>. Reuse the same <code>Idempotency-Key</code> (or JSON-RPC{" "}
            <code>id</code>) to retry without a second charge. Keys are rate-limited to 30 calls per minute.
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
          </ul>
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
          <h2>Example success (Check)</h2>
          <p className="hint" role="note">
            Illustrative schema example — not a real run. Field shapes match the live agent envelope; values are placeholders.
          </p>
          <pre className="doc">{`{
  "schema_version": "lemonless.agent_verdict.v1",
  "tool": "check_car",
  "verdict": "negotiate",
  "confidence": "medium",
  "serv": { "steps": [{ "decided": "…", "why": "…", "changed": null }], "second_pass": null, "checks_run": ["listing_extract"], "no_serv_step": true },
  "code_computed": { "fairValueUsd": 0, "compCount": 0 },
  "unknowns": ["Paid vehicle history was not run"],
  "credit_spent": false,
  "free_check_spent": true,
  "receipt_id": "…"
}`}</pre>
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
            ). Locally, keys and credits fall back to <code>.data/kv.json</code>. No on-chain payment is required for these
            agent tools.
          </p>
        </section>
      </div>
    </div>
  );
}
