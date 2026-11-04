export default function DevelopersPage() {
  return (
    <div className="sub">
      <div className="sheet-page prose">
      <h1>Developer API</h1>
      <p className="lead">
        Other agents can buy the same verdict. The consumer site sells credits. This page is the only place that describes the agent payment rail.
      </p>

      <section>
        <h2>Deal Radar watches a saved search</h2>
        <p>
          <code>POST /api/radar</code> with <code>{`{ make, model, zip?, year?, mode? }`}</code>. No credit and no payment. The MCP tool is <code>deal_radar</code>.
        </p>
        <h2>Full report</h2>
        <p>
          People on the site spend 1 credit, bought in Stripe test mode. Agents pay per call over x402, under a Kite Passport session. The HTTP endpoint is <code>POST /api/v1/report</code>. The MCP tool is <code>full_report</code>.
        </p>
        <p>
          What you buy is AutoFlip’s verdict and the calculation. The response leaves out photos and third-party history-report links. Raw listing resale is not the product. The current data plan is an evaluation tier; get a written license before a public paid launch.
        </p>
      </section>

      <section>
        <h2>MCP</h2>
        <p>
          <code>POST /api/mcp</code> speaks JSON-RPC: <code>initialize</code>, <code>tools/list</code>, <code>tools/call</code>, <code>ping</code>. <code>GET /api/mcp</code> describes the server. There is no session. Send a new request each time.
        </p>
        <pre className="doc">{`curl -s $ORIGIN/api/mcp \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}</pre>
        <p>
          <code>full_report</code> without a payment returns <code>payment_required</code> and the x402 <code>accepts</code> object, or <code>payments_not_configured</code> when the payee is empty. AutoFlip never pretends a payment succeeded. Ask the human before a Kite session pays.
        </p>
      </section>

      <section>
        <h2>x402 and Kite</h2>
        <p>
          The seller advertises <code>X402_SCHEME</code> (default <code>gokite-aa</code>), <code>X402_NETWORK</code>, <code>X402_ASSET</code>, <code>X402_PRICE_ATOMIC</code>, and <code>X402_PAY_TO</code>. The buyer’s agent pays with a Kite Passport session. AutoFlip then asks <code>X402_FACILITATOR_URL</code> (default Pieverse) to <code>/verify</code> and <code>/settle</code>. Retry the call with the payment payload in <code>PAYMENT-SIGNATURE</code> or <code>X-PAYMENT</code>, or in the MCP argument <code>payment</code>.
        </p>
        <p>Leave <code>X402_PAY_TO</code> empty until you are ready. An empty payee returns 402 and does not call the facilitator.</p>
      </section>

      <section>
        <h2>Saved-search schedule</h2>
        <p>
          GitHub Actions calls <code>POST /api/radar/cron</code> every 3 hours with <code>Authorization: Bearer $RADAR_CRON_SECRET</code>. One unique search is one listings call. Identical criteria are shared. The watcher stops at 650 calls a month so reports keep the rest of the 900 cap. A Check now button is limited to once per 30 minutes for everyone.
        </p>
        <p>
          Persistent storage is Upstash Redis (free REST). Set <code>UPSTASH_REDIS_REST_URL</code> and <code>UPSTASH_REDIS_REST_TOKEN</code>. Without them on Vercel, saved searches are not kept. Locally they fall back to <code>.data/kv.json</code>.
        </p>
        <p>
          The shared preview is <code>/demo?key=$DEMO_ACCESS_KEY</code>. <code>DEMO_CREDITS</code> is the balance restored once a day. Telegram uses <code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_BOT_USERNAME</code>, and <code>TELEGRAM_WEBHOOK_SECRET</code> (header <code>X-Telegram-Bot-Api-Secret-Token</code>).
        </p>
        <p>
          Each run tries a Kite Passport testnet session payment to <code>POST /api/v1/radar-ticket</code>. Required together: <code>KITE_PASSPORT_BASE_URL</code>, <code>KITE_SESSION_ID</code>, <code>KITE_SESSION_TOKEN</code>, <code>X402_PAY_TO</code>, <code>X402_ASSET</code>, and <code>X402_NETWORK=kite-testnet</code>. Anything missing is logged as not configured. A transaction reference is recorded only when the execute response includes one.
        </p>
        <h2>SERV</h2>
        <p>
          User text goes through a local screen and, when <code>SERV_API_KEY</code> is set, through <code>serv_prompt_guard</code>. The explanation call also sends <code>serv_prompt_guard</code> and <code>serv_shadow_agent</code> (hint: every number must be in the computed facts, max 2 iterations). AutoFlip then re-checks dollars, percentages, mileages, and VINs. A mismatch, or a shadow outcome of exhausted or failed, is replaced by the deterministic template. The report’s Proof of AI block records the steps, the inputs hash, the tool outputs, and the model.
        </p>
      </section>
      </div>
    </div>
  );
}
