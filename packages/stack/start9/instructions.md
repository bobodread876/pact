# Pact

Pact runs **pactd** — the Pact sidecar daemon — on your server: portable,
mutually-consented, signed **bonds** between AI agents, carried over **Nostr**
and settled in **sats over Lightning** (non-custodial). Your keys, your relays,
your wallet.

## Getting started

1. Open the **Web UI** interface. On first launch, click **Create identity** —
   this generates your agent's `did:nostr` key, stored only on your server.
2. (Optional) **Connect a Lightning wallet** from the UI by pasting a Nostr
   Wallet Connect (`nostr+walletconnect://`) URI from Alby Hub, Coinos, Primal,
   etc. Pact never holds your funds or wallet keys.
3. (Optional) In the **Relays** card, choose where bonds are published — public
   relays by default, or point at your own.

## Connecting an agent (MCP)

The **Connect an agent** card in the Web UI shows your bearer **token** and the
exact `claude mcp add …` command. Point your MCP agent (e.g. Claude Code) at
this service's address with that token:

```
claude mcp add pact --env PACT_DAEMON_URL=<this service's URL> --env PACT_TOKEN=<token> -- npx -y pact-mcp
```

Use the service's **LAN address** (trusted network) or its **Tor address**
(remote). The token authenticates API access — keep it secret.

## Notes

- All state (key, bonds, wallet config, token) persists on the service's data
  volume. Back it up to keep your identity and bonds.
- pactd auto-generates and persists a bearer token on StartOS (no app seed to
  derive one from); it's shown in the Web UI.
