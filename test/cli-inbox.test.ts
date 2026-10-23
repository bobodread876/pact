// The `pact` CLI on a flooded private inbox: the refusal names the override,
// the override accepts, and verify/list say why instead of a bare "not mutual".
// Runs the built CLI (CI builds before testing) as a real child process — each
// command is its own process, as in use.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { finalizeEvent, formBond, generateNostrKeypair, keypairFromSecret, newBondId, publishEvent, secretFromNsec } from '../packages/core/src/index.js';
import { startMockRelay } from './mock-relay.js';

const CLI = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'index.js');

function pact(home: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Async spawn: the mock relay lives in this process's event loop.
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, PACT_HOME: home } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('pact CLI: a flooded inbox', () => {
  it('accept refuses and names --allow-incomplete-inbox; the flag accepts; verify and list say "inbox incomplete"', async () => {
    const r = await startMockRelay();
    const home = mkdtempSync(join(tmpdir(), 'pact-cli-'));
    try {
      const rel = ['--relay', r.url];
      expect((await pact(home, ['keygen'])).code).toBe(0);
      const me = JSON.parse((await pact(home, ['whoami', '--json'])).stdout) as { npub: string; pubkeyHex: string };

      const alice = secretFromNsec(generateNostrKeypair().nsec);
      const bondId = newBondId();
      await formBond(alice, { counterparty: me.npub, bondId, state: 'proposed', visibility: 'private', relays: [r.url] });
      const t = Math.floor(Date.now() / 1000) + 60;
      for (let i = 0; i < 201; i++) {
        const k = secretFromNsec(generateNostrKeypair().nsec);
        await publishEvent([r.url], finalizeEvent({ pubkey: keypairFromSecret(k).pubkeyHex, created_at: t, kind: 1059, tags: [['p', me.pubkeyHex]], content: 'x' }, k));
      }

      const refused = await pact(home, ['bond', 'accept', bondId, ...rel]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/inbox incomplete/);
      expect(refused.stderr).toMatch(/--allow-incomplete-inbox/);

      const forced = await pact(home, ['bond', 'accept', bondId, '--allow-incomplete-inbox', ...rel]);
      // eslint-disable-next-line no-console
      if (forced.code !== 0) console.log('FORCED-FAIL stdout:', forced.stdout, 'stderr:', forced.stderr);
      expect(forced.code).toBe(0);
      expect(forced.stdout).toMatch(/Accepted bond .* \(private\)/);

      const verify = await pact(home, ['bond', 'verify', bondId, ...rel]);
      expect(verify.code).toBe(1);
      expect(verify.stdout).toContain('not mutual: inbox incomplete');

      const list = await pact(home, ['bond', 'list', '--visibility', 'private', ...rel]);
      expect(list.stdout).toContain('inbox incomplete');
    } finally {
      await r.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
