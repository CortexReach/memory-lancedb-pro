# memory.openvm067.space MCP Cutover Ops Note

Date: 2026-03-10

## Summary

`memory.openvm067.space` was cut over from the legacy Graphiti / search-fetch adapter path to the local `memory-lancedb-pro` HTTP MCP server, while preserving the existing OAuth-protected MCP entrypoint.

## Active Runtime Topology

- Public domain: `https://memory.openvm067.space`
- TLS / reverse proxy: nginx
- OAuth layer: `mcp-auth-proxy` on `127.0.0.1:18080`
- MCP backend: `memory-lancedb-pro` HTTP server on `127.0.0.1:3099`
- Legacy backend removed from serving path: `graphiti-search-fetch-adapter` on `127.0.0.1:19090`

## System Changes

### New user service

Created:

- `/home/austin/.config/systemd/user/memory-lancedb-pro-mcp.service`

This service starts:

- `/usr/bin/node /home/austin/Development/research/memory-lancedb-pro/src/mcp/server-http.mjs`

With:

- `MEMORY_LANCEDB_PRO_MCP_HOST=127.0.0.1`
- `MEMORY_LANCEDB_PRO_MCP_PORT=3099`
- `MEMORY_LANCEDB_PRO_MCP_OPENCLAW_CONFIG=/home/austin/.openclaw/openclaw.json`

### Auth proxy change

Modified:

- `/home/austin/Projects/mcp-auth-proxy/docker-compose.yml`

Changed upstream from:

- `http://127.0.0.1:19090`

To:

- `http://127.0.0.1:3099`

### Nginx change

Modified active vhost:

- `/etc/nginx/sites-enabled/code-server.conf`

For `server_name memory.openvm067.space`, these locations now proxy to `127.0.0.1:18080`:

- `/mcp`
- `/sse`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/.well-known/jwks.json`
- `/.idp/`
- `/.auth/`

The public auth challenge header was also updated to:

- `Bearer realm="Memory MCP"`

## Legacy Adapter Cleanup

Stopped:

- Docker container `graphiti-search-fetch-adapter`

Restart policy changed to:

- `no`

Result:

- `127.0.0.1:19090` no longer listens

## Verification Evidence

Verified after cutover:

- `systemctl --user status memory-lancedb-pro-mcp.service`
- `curl http://127.0.0.1:3099/health`
- `POST http://127.0.0.1:3099/mcp` initialize
- `curl http://127.0.0.1:18080/.well-known/oauth-protected-resource`
- `POST http://127.0.0.1:18080/mcp` returns `401 Unauthorized`
- `sudo nginx -t`
- `POST https://memory.openvm067.space/mcp` returns `401 Unauthorized`
- `WWW-Authenticate: Bearer realm="Memory MCP", resource_metadata="https://memory.openvm067.space/.well-known/oauth-protected-resource"`

## Rollback

If rollback is needed:

1. Repoint `/home/austin/Projects/mcp-auth-proxy/docker-compose.yml` back to `http://127.0.0.1:19090`
2. Recreate `mcp-auth-proxy`
3. Revert the `memory.openvm067.space` block in `/etc/nginx/sites-enabled/code-server.conf` from `127.0.0.1:18080` back to `127.0.0.1:8001`
4. Restart or re-enable the legacy `graphiti-search-fetch-adapter` container if required
