// Non-custodial sats interface for pactd.
//
// Default provider is Nostr Wallet Connect (NIP-47): pactd talks to the USER'S
// OWN Lightning wallet (lnflash / Alby / any NWC wallet) over Nostr. pactd never
// holds funds or wallet keys — it only relays signed, encrypted requests to the
// wallet service the user authorized via a `nostr+walletconnect://` URI.
//
// This is the rail every ECONOMICS.md market settles on (relay fees, verification
// fees, bonding/escrow, agent-labor payments). This first cut ships the rail +
// primitives (invoice / pay / lookup / balance); market mechanics build on top.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { sha256 } from '@noble/hashes/sha2.js';
import * as secp256k1 from '@noble/secp256k1';

import { finalizeEvent, keypairFromSecret, type NostrEvent, type UnsignedEvent } from '@pact/core';

secp256k1.hashes.sha256 = sha256;

const NWC_REQUEST_KIND = 23194;
const NWC_RESPONSE_KIND = 23195;

export interface Invoice {
  invoice: string;
  paymentHash?: string;
}

export interface Payment {
  preimage?: string;
  feesPaidSats?: number;
}

export interface LightningProvider {
  getInfo(): Promise<Record<string, unknown>>;
  getBalanceSats(): Promise<number>;
  makeInvoice(amountSats: number, description?: string): Promise<Invoice>;
  payInvoice(invoice: string): Promise<Payment>;
  lookupInvoice(opts: { invoice?: string; paymentHash?: string }): Promise<{ paid: boolean } & Record<string, unknown>>;
}

interface NwcConnection {
  walletPubkey: string;
  relay: string;
  secret: Uint8Array;
}

export class NwcProvider implements LightningProvider {
  private constructor(private readonly conn: NwcConnection) {}

  static fromUri(uri: string): NwcProvider {
    const url = new URL(uri); // nostr+walletconnect://<wallet-pubkey>?relay=..&secret=..
    const walletPubkey = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
    const relay = url.searchParams.get('relay');
    const secretHex = url.searchParams.get('secret');
    if (!/^[0-9a-f]{64}$/.test(walletPubkey) || !relay || !secretHex) {
      throw new Error('invalid NWC URI (expected nostr+walletconnect://<pubkey>?relay=..&secret=..)');
    }
    return new NwcProvider({ walletPubkey, relay, secret: hexToBytes(secretHex) });
  }

  getInfo(): Promise<Record<string, unknown>> {
    return this.request('get_info', {});
  }

  async getBalanceSats(): Promise<number> {
    const r = await this.request('get_balance', {});
    return Math.floor((Number(r.balance) || 0) / 1000);
  }

  async makeInvoice(amountSats: number, description?: string): Promise<Invoice> {
    const r = await this.request('make_invoice', { amount: amountSats * 1000, description });
    return { invoice: String(r.invoice), paymentHash: r.payment_hash ? String(r.payment_hash) : undefined };
  }

  async payInvoice(invoice: string): Promise<Payment> {
    const r = await this.request('pay_invoice', { invoice });
    return {
      preimage: r.preimage ? String(r.preimage) : undefined,
      feesPaidSats: r.fees_paid != null ? Math.floor(Number(r.fees_paid) / 1000) : undefined,
    };
  }

  async lookupInvoice(opts: { invoice?: string; paymentHash?: string }): Promise<{ paid: boolean } & Record<string, unknown>> {
    const params = opts.paymentHash ? { payment_hash: opts.paymentHash } : { invoice: opts.invoice };
    const r = await this.request('lookup_invoice', params);
    return { paid: Boolean(r.preimage) || r.settled_at != null || r.paid === true, ...r };
  }

  private async request(method: string, params: unknown): Promise<Record<string, any>> {
    const { walletPubkey, secret } = this.conn;
    const ourPubkey = keypairFromSecret(secret).pubkeyHex;
    const content = nip04Encrypt(JSON.stringify({ method, params }), secret, walletPubkey);
    const unsigned: UnsignedEvent = {
      pubkey: ourPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: NWC_REQUEST_KIND,
      tags: [['p', walletPubkey]],
      content,
    };
    const reqEvent = finalizeEvent(unsigned, secret);
    const respEvent = await this.roundtrip(reqEvent, ourPubkey);
    const decrypted = nip04Decrypt(respEvent.content, secret, walletPubkey);
    const parsed = JSON.parse(decrypted) as { result_type?: string; error?: { code: string; message: string }; result?: Record<string, any> };
    if (parsed.error) throw new Error(`NWC ${parsed.error.code}: ${parsed.error.message}`);
    return parsed.result ?? {};
  }

  private roundtrip(reqEvent: NostrEvent, ourPubkey: string, timeoutMs = 30000): Promise<NostrEvent> {
    const { relay } = this.conn;
    return new Promise((resolve, reject) => {
      const sub = `nwc-${reqEvent.id.slice(0, 12)}`;
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws.send(JSON.stringify(['CLOSE', sub]));
          ws.close();
        } catch {
          /* ignore */
        }
        fn();
      };
      const ws = new WebSocket(relay);
      const timer = setTimeout(() => finish(() => reject(new Error('NWC request timed out'))), timeoutMs);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', sub, { kinds: [NWC_RESPONSE_KIND], '#e': [reqEvent.id], '#p': [ourPubkey] }]));
        ws.send(JSON.stringify(['EVENT', reqEvent]));
      });
      ws.addEventListener('error', () => finish(() => reject(new Error('NWC relay connection error'))));
      ws.addEventListener('message', (ev: MessageEvent) => {
        let msg: unknown;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === sub && msg[2]) {
          finish(() => resolve(msg[2] as NostrEvent));
        }
      });
    });
  }
}

/** Build a Lightning provider from the environment (PACT_NWC), or null if unset. */
export function lightningFromEnv(): LightningProvider | null {
  const uri = process.env.PACT_NWC;
  return uri ? NwcProvider.fromUri(uri) : null;
}

// --- NIP-04 (encrypted NWC payloads) ---------------------------------------

function sharedKey(secret: Uint8Array, pubkeyHex: string): Buffer {
  const shared = secp256k1.getSharedSecret(secret, hexToBytes(`02${pubkeyHex}`));
  return Buffer.from(shared.slice(1, 33));
}

function nip04Encrypt(text: string, secret: Uint8Array, pubkeyHex: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', sharedKey(secret, pubkeyHex), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${enc.toString('base64')}?iv=${iv.toString('base64')}`;
}

function nip04Decrypt(payload: string, secret: Uint8Array, pubkeyHex: string): string {
  const [ct, ivb] = payload.split('?iv=');
  if (!ct || !ivb) throw new Error('malformed NIP-04 payload');
  const decipher = createDecipheriv('aes-256-cbc', sharedKey(secret, pubkeyHex), Buffer.from(ivb, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
