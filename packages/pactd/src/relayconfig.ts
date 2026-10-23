// Runtime relay configuration: persist the relay set in PACT_HOME so it can be
// set via the status UI (public relays, a bundled relay, or another Umbrel relay
// app) — no env/compose editing. Resolution order: relays.json > PACT_RELAYS env
// > the protocol default relays.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_RELAYS, pactHome, writeSecretFile } from 'pact-core';

function configPath(): string {
  return join(pactHome(), 'relays.json');
}

/** Only bare ws:// and wss:// URLs parse: no userinfo, no whitespace/control
 * chars. Anything else → undefined, so a hostile relay value can never become
 * a dial target (SSRF guard). */
export function sanitizeRelayUrl(raw: string): string | undefined {
  const s = raw.trim();
  if (!s || /[\s\x00-\x1f]/.test(s)) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
  if (url.username || url.password) return undefined;
  return s;
}

function loadSaved(): string[] | undefined {
  try {
    if (existsSync(configPath())) {
      const data = JSON.parse(readFileSync(configPath(), 'utf8')) as { relays?: string[] };
      if (Array.isArray(data.relays) && data.relays.length > 0) return data.relays;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function saveRelays(relays: string[]): void {
  writeSecretFile(configPath(), JSON.stringify({ relays }));
}

/** Whether relays were set via the UI/config (vs falling back to env/defaults). */
export function relaysAreCustom(): boolean {
  return loadSaved() !== undefined;
}

export function resolveRelays(): string[] {
  const saved = loadSaved();
  if (saved) return saved;
  if (process.env.PACT_RELAYS) {
    const relays: string[] = [];
    for (const raw of process.env.PACT_RELAYS.split(',')) {
      const r = sanitizeRelayUrl(raw);
      if (r) {
        relays.push(r);
      } else if (raw.trim()) {
        process.stderr.write(`pactd: ignoring invalid PACT_RELAYS entry (need ws:// or wss://): ${raw.trim()}\n`);
      }
    }
    if (relays.length) return relays;
  }
  return DEFAULT_RELAYS;
}
