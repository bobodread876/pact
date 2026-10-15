// The local unlist marker, shared by every surface that uses the keystore
// (pactd, the SDK's Pact.fromKeystore, and therefore the CLI).
//
// An unlist must not depend on which relays answer later: if no reachable
// relay holds the closed record (a relay was added after the unlist, the old
// one is down), `myIntent` returns null and an install-time intent
// (PACT_INTENT_SEEKING) would re-list the node without consent. So the
// operator's unlist is also recorded next to the key, keyed to the identity,
// and it wins whatever the relays say. Only an explicit open intent clears it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { keypairFromSecret } from '@mate-protocol/core';

import { pactHome } from './keystore.js';

function unlistedPath(): string {
  return join(pactHome(), 'intent-closed.json');
}

/** Record that the operator unlisted this identity on this node. */
export function markUnlisted(secret: Uint8Array): void {
  mkdirSync(pactHome(), { recursive: true });
  const pubkeyHex = keypairFromSecret(secret).pubkeyHex;
  writeFileSync(unlistedPath(), JSON.stringify({ pubkeyHex, closedAt: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
}

/** Clear the unlist marker (the operator explicitly published an open intent). */
export function clearUnlisted(): void {
  rmSync(unlistedPath(), { force: true });
}

/** Whether the operator unlisted this identity on this node. */
export function isUnlisted(secret: Uint8Array): boolean {
  try {
    if (!existsSync(unlistedPath())) return false;
    const data = JSON.parse(readFileSync(unlistedPath(), 'utf8')) as { pubkeyHex?: string };
    return data.pubkeyHex === keypairFromSecret(secret).pubkeyHex;
  } catch {
    // An unreadable marker is still an unlist: fail closed, never re-list.
    return true;
  }
}
