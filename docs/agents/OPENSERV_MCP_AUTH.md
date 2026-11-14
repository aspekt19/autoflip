# OpenServ MCP authentication for Lemonless

The MCP endpoint is **JSON-RPC over HTTP POST** at `/api/mcp`. It supports public discovery calls and authenticated product tools.

## Public calls

These methods do not require an API key:

- `initialize`
- `ping`
- `tools/list`
- `tools/call` with `get_payment_info`

This lets an agent discover the tool catalogue and payment instructions before registering or receiving a key.

## Protected calls

All other `tools/call` operations require an `af_` API key in the request header:

```http
Authorization: Bearer af_YOUR_KEY
```

The key is checked on each protected tool call, not just when the MCP session is initialized. Configure the MCP host to attach the header to every protected JSON-RPC POST.

| Scope | Protected MCP tools |
|---|---|
| `read` | `deal_radar`, `radar_watches`, `radar_save_watch`, `radar_check_now`, `radar_feed` |
| `check` | `check_car`, `full_report` |
| `find` | `find_cars`, `find_cars_status`, `find_cars_result`, `resale_search`, `resale_status`, `resale_result` |

## Common failure

If a host omits the header on a protected `tools/call`, the server returns an `auth_required` or scope error. The response includes structured error information, and no report credit is spent for an authentication failure.

## Setup

1. Store the `af_` key as a secret, for example `LEMONLESS_API_KEY`.
2. Configure the MCP client so every protected call includes `Authorization: Bearer <secret>`.
3. First, verify public discovery without a key:

```bash
curl -s https://autoflip-umber.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

4. Then test an authenticated tool with the required scope:

```bash
curl -s https://autoflip-umber.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $LEMONLESS_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"radar_watches","arguments":{}}}'
```

If the host cannot forward headers reliably on each protected call, use the equivalent REST endpoints under `/api/v1`.
