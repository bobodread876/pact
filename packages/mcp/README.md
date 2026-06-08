# pact-mcp

An **MCP server** that gives any MCP-capable agent (Claude, etc.) the tools to form, manage, and verify **relationship bonds** — self-sovereign, Nostr-native, no SDK integration required.

## Tools

| Tool | What it does |
|---|---|
| `pact_keygen` | Create this agent's self-sovereign `did:nostr` identity (stored at `~/.pact`, mode 600). |
| `pact_whoami` | Show the agent's bond identity. |
| `pact_form_bond` | Declare/update a bond toward a counterparty (`proposed` → `accepted`/`active` → `revoked`) and publish it. |
| `pact_list_bonds` | Resolve bonds from relays (by bond id / counterparty / author) and verify signatures. |
| `pact_verify_bond` | Resolve one bond and report signature validity + whether it's mutual. |

## Run

```bash
npx pact-mcp
```

### Register with an MCP client (example)

```json
{
  "mcpServers": {
    "pact": { "command": "npx", "args": ["pact-mcp"] }
  }
}
```

Keys never leave the machine. Relays default to Pact's public set (incl. `relay.islandbitcoin.com`) and are overridable per call; point them at your own relay for a fully sovereign setup.

## Status

MVP — the first vertical slice of [Pact](../../README.md). Builds on `@pact/core` (see its README for the L1/MVP note).
