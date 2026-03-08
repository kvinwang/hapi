# 413 Request Entity Too Large

File upload via MCP tool fails with `Request Entity Too Large`.

## Symptom

```
Failed to upload file: Request Entity Too Large
```

## Root Cause

The Hub uses `Bun.serve()` with a `maxRequestBodySize` option. This was set to `socketHandler.maxRequestBodySize`, which comes from `@socket.io/bun-engine`'s `maxHttpBufferSize` — defaulting to **~1MB**.

This is a **Bun-level** limit enforced by the native HTTP server. It rejects oversized requests before any Hono middleware (including `bodyLimit`) gets a chance to run.

## Why Hono `bodyLimit` Alone Doesn't Fix It

```
Request arrives
  → Bun.serve() checks maxRequestBodySize (~1MB) ← REJECTED HERE
  → Hono bodyLimit middleware (50MB)              ← Never reached
  → Route handler
```

Hono's `bodyLimit` middleware checks the `Content-Length` header inside the Hono request pipeline. But Bun rejects the body at a lower level, so the request never reaches Hono.

## Fix

In `hub/src/web/server.ts`, the `Bun.serve()` config must use a large enough limit:

```ts
// Before — limited by Socket.IO's ~1MB default:
maxRequestBodySize: socketHandler.maxRequestBodySize,

// After — at least 50MB for file uploads:
maxRequestBodySize: Math.max(50 * 1024 * 1024, socketHandler.maxRequestBodySize),
```

## Full Upload Size Limit Chain

When debugging upload size issues, check all layers in order:

| Layer | Where | Default | Config |
|-------|-------|---------|--------|
| MCP client | `cli/src/claude/utils/startHappyServer.ts` | 35MB raw | `MAX_FILE_BYTES` |
| Reverse proxy | nginx / caddy | varies | `client_max_body_size` |
| Bun HTTP server | `hub/src/web/server.ts` → `Bun.serve()` | ~1MB (from Socket.IO) | `maxRequestBodySize` |
| Hono middleware | `hub/src/web/server.ts` → `bodyLimit()` | 50MB | `maxSize` |
| Route handler | `hub/src/web/routes/cli.ts` | N/A | — |

Note: MCP uploads are base64-encoded, so 35MB raw → ~47MB over the wire. All downstream limits must accommodate the encoded size.

## Reverse Proxy Configuration

If the Hub is behind a reverse proxy, the proxy itself may reject large requests before they reach Bun. Check the relevant config:

### Nginx

```nginx
# In server or location block
client_max_body_size 50m;
```

Default is `1m`. A `413` from nginx will have an nginx error page, not a JSON response.

### Caddy

```caddyfile
example.com {
    request_body {
        max_size 50MB
    }
    reverse_proxy localhost:3000
}
```

Default is no limit in Caddy 2.

### Cloudflare

- Free plan: 100MB max upload size (not configurable)
- Pro/Business/Enterprise: up to 500MB (configurable via dashboard)

Cloudflare's 413 returns its own error page. If you see an HTML error instead of JSON, it's likely the proxy layer.

### How to Tell Which Layer Is Rejecting

| Clue | Likely source |
|------|---------------|
| HTML error page with nginx branding | nginx `client_max_body_size` |
| HTML error page with Cloudflare branding | Cloudflare upload limit |
| Plain `Request Entity Too Large` text | Bun `maxRequestBodySize` |
| JSON `{ "error": "..." }` | Hono `bodyLimit` middleware |
