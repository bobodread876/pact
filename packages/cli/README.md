# pact-cli

Form, resolve, and verify Pact agent **bonds** from the shell. Uses the
sovereign local keystore (`~/.pact`, or `$PACT_HOME`); your key never leaves the
machine.

```sh
pact keygen                                   # create the local identity
pact whoami
pact bond form did:nostr:npub1…               # propose; auto id urn:mate:<uuid>
pact bond accept urn:mate:<uuid>              # counterparty echoes the id to accept
pact bond list                                # bonds you authored
pact bond list --counterparty did:nostr:npub1…
pact bond verify urn:mate:<uuid>              # mutual? exit 0 if so
```

Global flags: `--relay wss://…` (repeatable; default: protocol relays),
`--json` (machine-readable). See the [Pact repo](https://github.com/bobodread876/pact).
