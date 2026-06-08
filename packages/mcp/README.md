# pact-mcp

An **MCP server** that gives any MCP-capable agent (Claude Code, etc.) the tools to form, manage, and verify **relationship bonds**.

It is a **thin adapter over a running [`pactd`](../pactd) daemon** — the daemon holds the agent's key, relay config, and Lightning wallet; this server just exposes the daemon's operations as MCP tools. So the agent acts as that one sovereign `pactd` identity (same key, relays, and wallet your `pact-stack` already runs).

## Prerequisite: a running `pactd`

```bash
# e.g. via pact-stack (docker compose) or directly:
node packages/pactd/dist/index.js        # listens on 127.0.0.1:8787
```

`pact-mcp` reaches it at `PACT_DAEMON_URL` (default `http://127.0.0.1:8787`). If the daemon uses `PACT_TOKEN`, set the same value for `pact-mcp`.

## Tools

| Tool | Daemon call |
|---|---|
| `pact_keygen` | `POST /identity` — create the agent's `did:nostr` identity |
| `pact_whoami` | `GET /identity` |
| `pact_form_bond` | `POST /bonds` — declare/update + publish a bond |
| `pact_list_bonds` | `GET /bonds` — resolve + verify (by bond / counterparty / author) |
| `pact_verify_bond` | `GET /bonds/verify` — verify + mutual check (handles the 402 paid-verify flow via `payment_hash`) |
| `pact_wallet` | `GET /wallet` — Lightning wallet status + balance |

## Install & register with Claude Code

Published on npm — no clone or build needed:

```bash
claude mcp add pact -- npx -y pact-mcp
# set env PACT_DAEMON_URL / PACT_TOKEN if the daemon isn't on the default localhost:8787
```

Now Claude Code can form/verify bonds — acting as the `pactd` node's identity, using its relays and wallet.

**If the MCP server shows "Connection closed" on first add:** that's usually the first-run `npx` download exceeding the MCP startup timeout. Either warm it once (`npx -y pact-mcp` in a terminal → wait for `pact-mcp: ready (stdio)` → Ctrl-C, then reconnect), or install globally for an instant spawn:

```bash
npm i -g pact-mcp
claude mcp add pact -- pact-mcp
```

Requires **Node ≥ 18**.

## Status

Published: [`pact-mcp`](https://www.npmjs.com/package/pact-mcp) on npm. Depends only on `@modelcontextprotocol/sdk` + `zod` (no crypto here — that's the daemon). Pairs with `pactd` ≥ 0.1.
