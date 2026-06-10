#!/usr/bin/env node
// pact — form, resolve, and verify agent bonds from the shell. Thin wrapper over
// pact-sdk, using the sovereign local keystore (~/.pact, or $PACT_HOME). Key
// never leaves the machine; relays default to the protocol defaults (override
// with --relay, repeatable).

import { parseArgs } from 'node:util';

import { ensureIdentity, hasIdentity, loadIdentity } from 'pact-core';
import { Pact, type BondState, type BondView } from 'pact-sdk';

const HELP = `pact — agent relationship bonds from the shell

Usage:
  pact keygen [--force]              Create the local identity (~/.pact)
  pact whoami                        Show this node's identity
  pact bond form <counterparty> [bondId] [--state proposed] [--kind <k>] [--no-history] [--private]
                                     Propose a bond. Omit bondId to auto-generate urn:mate:<uuid>.
                                     --private: NIP-59 gift wrap — off the public graph, parties-only.
  pact bond accept <bondId> [--from <counterparty>] [--state active] [--private|--public]
                                     Accept a proposed bond (echoes its id; proposer auto-resolved;
                                     channel echoes the proposal unless --private/--public override).
  pact bond list [--author <id>] [--counterparty <id>] [--bond-id <id>] [--visibility all|public|private]
  pact bond verify <bondId>          (private sides this key can decrypt are included)

Identity (did:nostr / npub / hex) is resolved automatically.

Global options:
  --relay <wss://...>   Relay to use (repeatable; default: protocol relays)
  --json                Machine-readable JSON output
  -h, --help            Show this help
`;

function out(json: boolean, human: string, data: unknown): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(human);
}

function bondLine(b: BondView): string {
  const mark = b.signature_valid ? '✓' : '✗';
  const lock = b.visibility === 'private' ? '🔒' : '  ';
  return `  ${mark}${lock} ${(b.state ?? '?').padEnd(10)} ${b.bond ?? '(no id)'}  ${b.author.slice(0, 12)}…`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      relay: { type: 'string', multiple: true },
      state: { type: 'string' },
      kind: { type: 'string' },
      from: { type: 'string' },
      'no-history': { type: 'boolean' },
      author: { type: 'string' },
      counterparty: { type: 'string' },
      'bond-id': { type: 'string' },
      private: { type: 'boolean' },
      public: { type: 'boolean' },
      visibility: { type: 'string' },
    },
  });

  const json = Boolean(values.json);
  const relays = (values.relay as string[] | undefined) ?? undefined;
  const [command, sub, ...rest] = positionals;

  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'keygen': {
      const id = ensureIdentity(Boolean(values.force));
      out(json, `${id.created ? 'Created' : 'Existing'} identity:\n  ${id.did}\n  ${id.npub}`, id);
      return;
    }

    case 'whoami': {
      if (!hasIdentity()) {
        out(json, "No identity yet — run 'pact keygen'.", { identity: null });
        process.exitCode = 1;
        return;
      }
      const id = loadIdentity();
      out(json, `${id.did}\n${id.npub}\n${id.pubkeyHex}`, {
        did: id.did,
        npub: id.npub,
        pubkeyHex: id.pubkeyHex,
      });
      return;
    }

    case 'bond': {
      const pact = Pact.fromKeystore({ relays });

      if (sub === 'form') {
        const [counterparty, bondId] = rest;
        if (!counterparty) {
          console.error('usage: pact bond form <counterparty> [bondId] [--state] [--kind] [--no-history]');
          process.exitCode = 2;
          return;
        }
        const result = await pact.formBond({
          counterparty,
          bondId,
          state: (values.state as Parameters<typeof pact.formBond>[0]['state']) ?? 'proposed',
          kind: values.kind as string | undefined,
          history: !values['no-history'],
          visibility: values.private ? 'private' : undefined,
        });
        const reached = result.stateEvent.relays.filter((r) => r.accepted).length;
        out(
          json,
          result.visibility === 'private'
            ? `Private bond '${result.bondId}' wrapped as '${result.state}' (rumor ${result.stateEvent.id.slice(0, 12)}… → ${reached} relay(s); copy-to-self published).`
            : `Bond '${result.bondId}' published as '${result.state}' (state event ${result.stateEvent.id.slice(0, 12)}… → ${reached} relay(s)).`,
          result,
        );
        return;
      }

      if (sub === 'accept') {
        const [bondId] = rest;
        if (!bondId) {
          console.error('usage: pact bond accept <bondId> [--from <counterparty>] [--state active]');
          process.exitCode = 2;
          return;
        }
        const result = await pact.acceptBond(bondId, {
          counterparty: values.from as string | undefined,
          state: values.state as BondState | undefined,
          visibility: values.private ? 'private' : values.public ? 'public' : undefined,
        });
        const reached = result.stateEvent.relays.filter((r) => r.accepted).length;
        out(
          json,
          `Accepted bond '${result.bondId}' as '${result.state}'${result.visibility === 'private' ? ' (private)' : ''} (→ ${reached} relay(s)).`,
          result,
        );
        return;
      }

      if (sub === 'list') {
        const { relaysReached, bonds } = await pact.listBonds({
          author: values.author as string | undefined,
          counterparty: values.counterparty as string | undefined,
          bondId: values['bond-id'] as string | undefined,
          visibility: (values.visibility as 'all' | 'public' | 'private' | undefined) ?? 'all',
        });
        out(
          json,
          bonds.length
            ? `${bonds.length} bond(s) [${relaysReached.length} relay(s)]:\n${bonds.map(bondLine).join('\n')}`
            : 'No bonds found.',
          { relaysReached, bonds },
        );
        return;
      }

      if (sub === 'verify') {
        const [bondId] = rest;
        if (!bondId) {
          console.error('usage: pact bond verify <bondId>');
          process.exitCode = 2;
          return;
        }
        const result = await pact.verifyBond(bondId);
        out(
          json,
          `Bond '${bondId}': ${result.mutual ? 'MUTUAL ✓' : 'not mutual'} — ${result.count} signed state(s) across ${result.relaysReached.length} relay(s).\n${result.bonds.map(bondLine).join('\n')}`,
          result,
        );
        if (!result.mutual) process.exitCode = 1;
        return;
      }

      console.error("unknown 'bond' subcommand — try: form | accept | list | verify");
      process.exitCode = 2;
      return;
    }

    default:
      console.error(`unknown command '${command}'.\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
