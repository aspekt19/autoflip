import type { Metadata } from "next";
import { AgentKeys } from "@/components/AgentKeys";

export const metadata: Metadata = { title: "For agents" };

export default function DevelopersPage() {
  return (
    <div className="sub">
      <div className="sheet-page prose">
        <h1>For agents</h1>
        <p className="lead">
          An agent can run the same analysis a person buys with a credit. Create a key for this browser, then send it as <code>Authorization: Bearer</code>.
        </p>

        <section>
          <h2>What each tool costs</h2>
          <ul>
            <li>
              <code>deal_radar</code> is free. It scores listings already in one search. It does not spend a credit.
            </li>
            <li>
              <code>full_report</code> and <code>POST /api/v1/report</code> cost 1 credit on the account that owns the key. That is the same credit the site spends on a full analysis.
            </li>
          </ul>
          <p>A zero balance returns <code>insufficient_credits</code>, <code>buyCreditsUrl</code>, and does not run the analysis. Send the same JSON-RPC <code>id</code>, or the same <code>Idempotency-Key</code> on the HTTP call, to retry a paid call without a second charge.</p>
        </section>

        <AgentKeys />

        <section>
          <h2>Agent card</h2>
          <p>
            Machine-readable tool list: <a href="/.well-known/agent.json"><code>/.well-known/agent.json</code></a>.
          </p>
        </section>

        <section>
          <h2>MCP</h2>
          <p>
            <code>POST /api/mcp</code> speaks JSON-RPC: <code>initialize</code>, <code>tools/list</code>, <code>tools/call</code>, and <code>ping</code>. <code>GET /api/mcp</code> describes the server. There is no session.
          </p>
          <h3>List tools</h3>
          <pre className="doc">{`curl -s https://autoflip-umber.vercel.app/api/mcp \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}</pre>
          <h3>Free Deal Radar scan</h3>
          <pre className="doc">{`curl -s https://autoflip-umber.vercel.app/api/mcp \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"deal_radar","arguments":{"make":"Toyota","model":"Camry","mode":"personal","zip":"78701"}}}'`}</pre>
          <h3>Full report (1 credit)</h3>
          <pre className="doc">{`curl -s https://autoflip-umber.vercel.app/api/mcp \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"full_report","arguments":{"mode":"personal","vin":"VIN"}}}'`}</pre>
          <h3>Claude Desktop / Cursor</h3>
          <pre className="doc">{`{
  "mcpServers": {
    "lemonless": {
      "url": "https://autoflip-umber.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer af_YOUR_KEY" }
    }
  }
}`}</pre>
        </section>

        <section>
          <h2>HTTP report with an API key</h2>
          <pre className="doc">{`curl -s https://autoflip-umber.vercel.app/api/v1/report \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -H 'idempotency-key: demo-1' \\
  -d '{"mode":"personal","vin":"VIN","zip":"78701"}'`}</pre>
        </section>

        <section>
          <h2>Example response</h2>
          <p>This is the shape, not a live report. Numbers come from the analysis that actually ran. <code>proof</code> records which checks ran and which fields the code computed.</p>
          <pre className="doc">{`{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "structuredContent": {
      "verdict": "fair",
      "fairValueUsd": 0,
      "priceGap": 0,
      "sample": true,
      "proof": { "codeComputed": ["fairValueUsd", "priceGap", "score"] }
    }
  }
}`}</pre>
          <p>When the balance is zero the call returns HTTP 402:</p>
          <pre className="doc">{`{
  "error": "insufficient_credits",
  "message": "This account has no report credits left. The analysis was not run.",
  "buyCreditsUrl": "https://YOUR_HOST/credits",
  "balance": 0
}`}</pre>
        </section>

        <section>
          <h2>Saved searches and storage</h2>
          <p>
            <code>GET /api/serv/selftest</code> and <code>POST /api/radar/cron</code> use <code>Authorization: Bearer $RADAR_CRON_SECRET</code>. That secret is not an agent key. Persistent storage is Upstash Redis. Set <code>UPSTASH_REDIS_REST_URL</code> and <code>UPSTASH_REDIS_REST_TOKEN</code>. Locally, keys and credits fall back to <code>.data/kv.json</code>.
          </p>
        </section>
      </div>
    </div>
  );
}