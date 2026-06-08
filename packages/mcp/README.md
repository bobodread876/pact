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

## Register with Claude Code

```bash
claude mcp add pact -- node /path/to/pact/packages/mcp/dist/index.js
# (set env PACT_DAEMON_URL / PACT_TOKEN if the daemon isn't on the default localhost:8787)
```

Now Claude Code can form/verify bonds — acting as the `pactd` node's identity, using its relays and wallet.

## Status

MVP. Depends only on `@modelcontextprotocol/sdk` + `zod` (no crypto here — that's the daemon). Pairs with `pactd` ≥ 0.1.
