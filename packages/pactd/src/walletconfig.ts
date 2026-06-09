// Runtime wallet configuration: persist the NWC connection URI in PACT_HOME so
// the wallet can be connected via the status UI (no env/compose editing needed),
// surviving restarts. Falls back to the PACT_NWC env var.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pactHome } from 'pact-core';

function configPath(): string {
  return join(pactHome(), 'wallet.json');
}

export function loadNwcUri(): string | undefined {
  try {
    if (existsSync(configPath())) {
      const data = JSON.parse(readFileSync(configPath(), 'utf8')) as { nwc?: string };
      if (data.nwc) return data.nwc;
    }
  } catch {
    // ignore
  }
  return process.env.PACT_NWC || undefined;
}

export function saveNwcUri(nwc: string): void {
  mkdirSync(pactHome(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ nwc }), { mode: 0o600 });
}

export function clearNwcUri(): void {
  try {
    writeFileSync(configPath(), JSON.stringify({}), { mode: 0o600 });
  } catch {
    // ignore
  }
}
