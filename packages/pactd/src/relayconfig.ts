// Runtime relay configuration: persist the relay set in PACT_HOME so it can be
// set via the status UI (public relays, a bundled relay, or another Umbrel relay
// app) — no env/compose editing. Resolution order: relays.json > PACT_RELAYS env
// > the protocol default relays.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_RELAYS, pactHome } from 'pact-core';

function configPath(): string {
  return join(pactHome(), 'relays.json');
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
  mkdirSync(pactHome(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ relays }), { mode: 0o600 });
}

/** Whether relays were set via the UI/config (vs falling back to env/defaults). */
export function relaysAreCustom(): boolean {
  return loadSaved() !== undefined;
}

export function resolveRelays(): string[] {
  const saved = loadSaved();
  if (saved) return saved;
  if (process.env.PACT_RELAYS) {
    return process.env.PACT_RELAYS.split(',').map((r) => r.trim()).filter(Boolean);
  }
  return DEFAULT_RELAYS;
}
