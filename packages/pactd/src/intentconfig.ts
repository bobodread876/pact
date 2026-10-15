// Discovery is opt-in. Nothing in pactd ever publishes a bond intent on its
// own: becoming findable reveals that an agent exists and what it seeks, and
// relays keep that history even after the intent is closed. What this module
// does instead is (a) tell callers, at the moments that matter, that the node
// is NOT yet discoverable and how to opt in, and (b) honor an operator's
// explicit install-time choice (PACT_INTENT_SEEKING) by publishing the intent
// they asked for once an identity exists.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { keypairFromSecret, myIntent, pactHome, publishIntent, type PublishIntentResult } from 'pact-core';

export const INTENT_SEEKING_ENV = 'PACT_INTENT_SEEKING';
export const INTENT_ABOUT_ENV = 'PACT_INTENT_ABOUT';

export interface ConfiguredIntent {
  seeking: string[];
  about?: string;
}

export interface DiscoveryStatus {
  /** True when this identity has an open intent on the configured relays. */
  discoverable: boolean;
  /** Present only when not discoverable: how to opt in. */
  hint?: string;
}

export const NOT_DISCOVERABLE_HINT =
  'Not discoverable yet: this identity is not on the open board. Publishing a bond intent is opt-in — ' +
  'it reveals that the agent exists and what it seeks (never who it bonds with), and relays keep that record. ' +
  'To opt in, POST /intent {"seeking":["collaboration"]} (pact-mcp: pact_publish_intent). ' +
  'Check with the operator before doing so.';

/** The operator's install-time intent, if they set one. Never defaults to anything. */
export function configuredIntent(env: NodeJS.ProcessEnv = process.env): ConfiguredIntent | null {
  const raw = env[INTENT_SEEKING_ENV];
  if (!raw) return null;
  const seeking = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
  if (seeking.length === 0) return null;
  const about = env[INTENT_ABOUT_ENV]?.trim().slice(0, 400);
  return { seeking, ...(about ? { about } : {}) };
}

/** Whether this identity currently has an open intent (plus the opt-in hint when it doesn't). */
export async function discoveryStatus(secret: Uint8Array, relays: string[]): Promise<DiscoveryStatus> {
  const intent = await myIntent(secret, relays);
  const open = !!intent && intent.status !== 'closed';
  return open ? { discoverable: true } : { discoverable: false, hint: NOT_DISCOVERABLE_HINT };
}

/** Whether a publish actually landed somewhere: at least one relay accepted it. */
export function publishedStatus(result: PublishIntentResult | null): DiscoveryStatus {
  if (result && result.status === 'open' && result.event.relays.some((r) => r.accepted)) return { discoverable: true };
  const relayNotes = result?.event.relays.map((r) => `${r.relay}: ${r.message || 'rejected'}`).join('; ');
  return {
    discoverable: false,
    hint: relayNotes ? `${NOT_DISCOVERABLE_HINT} Configured intent was not accepted by any relay (${relayNotes}).` : NOT_DISCOVERABLE_HINT,
  };
}

// --- the local unlist marker ---
// An unlist must not depend on which relays answer at boot: if no reachable
// relay holds the closed record (a relay was added later, the old one is down),
// myIntent returns null and the env would re-list the node without consent. So
// the operator's unlist is also recorded locally, keyed to the identity, and it
// wins whatever the relays say. Only an explicit open intent clears it.

function unlistedPath(): string {
  return join(pactHome(), 'intent-closed.json');
}

/** Record that the operator unlisted this identity. */
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

function sameIntent(a: ConfiguredIntent, b: { seeking?: string[]; about?: string; status?: string }): boolean {
  const bs = [...(b.seeking ?? [])].sort();
  const as = [...a.seeking].sort();
  return as.length === bs.length && as.every((k, i) => k === bs[i]) && (a.about ?? '') === (b.about ?? '');
}

/**
 * Publish the operator-configured intent if one is set and the relays don't
 * already carry it. Returns null when nothing is configured or nothing changed.
 * Idempotent: safe to call on every startup.
 *
 * A closed intent on the relays is an operator decision ("unlist"), and it
 * wins over the env: the node is never put back on the board on restart. To
 * re-list, the operator publishes an intent explicitly (POST /intent).
 * The unlist is also recorded locally (markUnlisted), so it holds even when no
 * reachable relay carries the closed record.
 */
export async function applyConfiguredIntent(
  secret: Uint8Array,
  relays: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublishIntentResult | null> {
  const wanted = configuredIntent(env);
  if (!wanted) return null;
  if (isUnlisted(secret)) return null;
  const current = await myIntent(secret, relays);
  if (current?.status === 'closed') return null;
  if (current && sameIntent(wanted, current)) return null;
  return publishIntent(secret, { seeking: wanted.seeking, about: wanted.about, relays });
}
