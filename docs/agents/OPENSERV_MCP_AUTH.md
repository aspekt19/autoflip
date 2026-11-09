# OpenServ MCP auth for Lemonless

Lemonless MCP expects `Authorization: Bearer af_…` on **every** JSON-RPC POST (`initialize`, `tools/list`, `tools/call`, `ping`).

## Common failure

If OpenServ (or another host) attaches the header only on session start, later `tools/call` requests arrive without auth and return:

```json
{
  "error_code": "auth_required",
  "credit_spent": false,
  "retry_safe": false
}
```

No credit is spent.

## Fix

1. Store `af_…` as a secret named e.g. `LEMONLESS_API_KEY`.
2. Configure the MCP client headers so **each** POST includes `Authorization: Bearer <secret>`.
3. Smoke test before paid tools:

```bash
curl -s https://autoflip-umber.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $LEMONLESS_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

4. Prefer REST `/api/v1/check` and `/api/v1/find` if the host cannot forward MCP headers reliably.
