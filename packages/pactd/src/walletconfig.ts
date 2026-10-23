// Runtime wallet configuration: persist the NWC connection URI in PACT_HOME so
// the wallet can be connected via the status UI (no env/compose editing needed),
// surviving restarts. Falls back to the PACT_NWC env var.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pactHome, writeSecretFile } from 'pact-core';

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
  writeSecretFile(configPath(), JSON.stringify({ nwc }));
}

export function clearNwcUri(): void {
  try {
    writeSecretFile(configPath(), JSON.stringify({}));
  } catch {
    // ignore
  }
}
