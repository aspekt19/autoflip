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
          <h2>MCP</h2>
          <p>
            <code>POST /api/mcp</code> speaks JSON-RPC: <code>initialize</code>, <code>tools/list</code>, <code>tools/call</code>, and <code>ping</code>. <code>GET /api/mcp</code> describes the server. There is no session.
          </p>
          <h3>Claude Desktop</h3>
          <pre className="doc">{`{
  "mcpServers": {
    "autoflip": {
      "url": "https://YOUR_HOST/api/mcp",
      "headers": { "Authorization": "Bearer af_YOUR_KEY" }
    }
  }
}`}</pre>
          <h3>Cursor</h3>
          <pre className="doc">{`{
  "mcpServers": {
    "autoflip": {
      "url": "https://YOUR_HOST/api/mcp",
      "headers": { "Authorization": "Bearer af_YOUR_KEY" }
    }
  }
}`}</pre>
          <h3>curl</h3>
          <pre className="doc">{`curl -s $ORIGIN/api/mcp \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer af_YOUR_KEY' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"full_report","arguments":{"mode":"personal","vin":"VIN"}}}'`}</pre>
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
          <h2>Optional payment header</h2>
          <p>
            If no API key is sent, and <code>X402_PAY_TO</code>, <code>X402_NETWORK</code>, and <code>X402_ASSET</code> are set, <code>full_report</code> still accepts a payment header. An empty payee does not pretend a payment worked. The credit on the API key is the path to use.
          </p>
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