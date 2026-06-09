// Non-custodial sats interface for pactd.
//
// Default provider is Nostr Wallet Connect (NIP-47): pactd talks to the USER'S
// OWN Lightning wallet over Nostr. pactd never holds funds or wallet keys — it
// only relays signed, encrypted requests to the wallet service the user
// authorized via a `nostr+walletconnect://` URI.
//
// Works with any NWC-compatible wallet (Alby, Coinos, Primal, …). NOTE: lnflash
// does NOT implement NWC yet, so it is not usable through this provider; a
// direct lnflash provider (via its API) is a planned addition.
//
// This is the rail every ECONOMICS.md market settles on (relay fees, verification
// fees, bonding/escrow, agent-labor payments). This first cut ships the rail +
// primitives (invoice / pay / lookup / balance); market mechanics build on top.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { sha256 } from '@noble/hashes/sha2.js';
import * as secp256k1 from '@noble/secp256k1';
import { bech32 } from '@scure/base';

import { finalizeEvent, keypairFromSecret, type NostrEvent, type UnsignedEvent } from 'pact-core';

secp256k1.hashes.sha256 = sha256;

const NWC_REQUEST_KIND = 23194;
const NWC_RESPONSE_KIND = 23195;

export interface Invoice {
  invoice: string;
  paymentHash?: string;
}

export interface Payment {
  /** settled = confirmed paid; pending = submitted but unconfirmed (do not retry); failed = rejected, no funds moved. */
  status: 'settled' | 'pending' | 'failed';
  preimage?: string;
  feesPaidSats?: number;
  paymentHash?: string;
  error?: string;
  message?: string;
}

export interface WalletTransaction {
  type?: string;
  amountSats: number;
  feesPaidSats: number;
  description?: string;
  paymentHash?: string;
  preimage?: string;
  settledAt?: number | null;
  createdAt?: number;
}

/** What a connected wallet backend can do — the start of Pact's per-wallet policy layer. */
export interface WalletCapabilities {
  /** NWC methods the wallet advertises (from get_info). */
  methods: string[];
  /** Best-effort backend label (e.g. "phoenixd", "alby-hub", "unknown"). */
  backend: string;
  /** Whether this backend can pay amountless (0-amount) bolt11 invoices. */
  canPayAmountless: boolean;
}

export interface LightningProvider {
  getInfo(): Promise<Record<string, unknown>>;
  getBalanceSats(): Promise<number>;
  makeInvoice(amountSats: number, description?: string): Promise<Invoice>;
  payInvoice(invoice: string, amountSats?: number): Promise<Payment>;
  lookupInvoice(opts: { invoice?: string; paymentHash?: string }): Promise<{ paid: boolean } & Record<string, unknown>>;
  listTransactions(opts?: { limit?: number; unpaid?: boolean }): Promise<WalletTransaction[]>;
  getCapabilities(): Promise<WalletCapabilities>;
}

interface NwcConnection {
  walletPubkey: string;
  relay: string;
  secret: Uint8Array;
}

export class NwcProvider implements LightningProvider {
  private infoCache?: Record<string, unknown>;

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

  private async getInfoCached(): Promise<Record<string, unknown>> {
    if (!this.infoCache) this.infoCache = await this.getInfo();
    return this.infoCache;
  }

  async getCapabilities(): Promise<WalletCapabilities> {
    return capabilitiesFromInfo(await this.getInfoCached());
  }

  async getBalanceSats(): Promise<number> {
    const r = await this.request('get_balance', {});
    return Math.floor((Number(r.balance) || 0) / 1000);
  }

  async makeInvoice(amountSats: number, description?: string): Promise<Invoice> {
    const r = await this.request('make_invoice', { amount: amountSats * 1000, description });
    return { invoice: String(r.invoice), paymentHash: r.payment_hash ? String(r.payment_hash) : undefined };
  }

  async payInvoice(invoice: string, amountSats?: number): Promise<Payment> {
    const paymentHash = paymentHashFromInvoice(invoice) ?? undefined;

    // Amountless invoices: gate on backend capability + require an explicit amount.
    const params: Record<string, unknown> = { invoice };
    if (invoiceAmountSats(invoice) == null) {
      const caps = await this.getCapabilities();
      if (!caps.canPayAmountless) {
        return {
          status: 'failed',
          error: `this wallet backend (${caps.backend}) cannot pay amountless invoices — ask the payee for a fixed-amount invoice`,
          paymentHash,
        };
      }
      if (!amountSats || amountSats <= 0) {
        return {
          status: 'failed',
          error: 'amountless invoice — provide amountSats to specify how much to pay',
          paymentHash,
        };
      }
      params.amount = amountSats * 1000; // msats, for a zero-amount invoice
    }

    let nwcError: string | undefined;

    try {
      const r = await this.request('pay_invoice', params);
      if (r.preimage) {
        return {
          status: 'settled',
          preimage: String(r.preimage),
          feesPaidSats: r.fees_paid != null ? Math.floor(Number(r.fees_paid) / 1000) : undefined,
          paymentHash,
        };
      }
      // Responded without a preimage → in-flight/unknown; poll below.
    } catch (error) {
      nwcError = error instanceof Error ? error.message : String(error);
      // Definitive failures: no funds moved, safe to report as failed.
      if (/INSUFFICIENT_BALANCE|QUOTA_EXCEEDED|UNAUTHORIZED|NOT_IMPLEMENTED|RESTRICTED|RATE_LIMITED|PAYMENT_FAILED/.test(nwcError)) {
        return { status: 'failed', error: nwcError, paymentHash };
      }
      // INTERNAL / OTHER / "no preimage" → ambiguous (may be in-flight); poll below.
    }

    // Poll the ledger to discover the TRUE settlement status before reporting.
    if (paymentHash) {
      const settled = await this.pollSettlement(paymentHash);
      if (settled) {
        return {
          status: 'settled',
          preimage: settled.preimage,
          feesPaidSats: settled.feesPaidSats,
          paymentHash,
        };
      }
    }

    return {
      status: 'pending',
      paymentHash,
      error: nwcError,
      message:
        'Payment submitted but settlement is UNCONFIRMED — the wallet returned no preimage and it has not settled yet. ' +
        'DO NOT retry (re-paying may double-spend). Check pact_list_transactions or your wallet for the final status.',
    };
  }

  /** Poll list_transactions for a settled outgoing payment matching paymentHash. */
  private async pollSettlement(
    paymentHash: string,
    attempts = 4,
    delayMs = 2000,
  ): Promise<WalletTransaction | null> {
    for (let i = 0; i < attempts; i++) {
      await delay(delayMs);
      try {
        const txs = await this.listTransactions({ limit: 30 });
        const tx = txs.find((t) => t.paymentHash === paymentHash && t.settledAt != null);
        if (tx) return tx;
      } catch {
        // keep polling
      }
    }
    return null;
  }

  async lookupInvoice(opts: { invoice?: string; paymentHash?: string }): Promise<{ paid: boolean } & Record<string, unknown>> {
    const params = opts.paymentHash ? { payment_hash: opts.paymentHash } : { invoice: opts.invoice };
    const r = await this.request('lookup_invoice', params);
    return { paid: Boolean(r.preimage) || r.settled_at != null || r.paid === true, ...r };
  }

  async listTransactions(opts: { limit?: number; unpaid?: boolean } = {}): Promise<WalletTransaction[]> {
    const r = await this.request('list_transactions', { limit: opts.limit ?? 20, unpaid: opts.unpaid ?? false });
    const txs = Array.isArray(r.transactions) ? (r.transactions as Record<string, any>[]) : [];
    return txs.map((t) => ({
      type: t.type,
      amountSats: Math.floor(Number(t.amount) / 1000) || 0,
      feesPaidSats: Math.floor(Number(t.fees_paid) / 1000) || 0,
      description: t.description || undefined,
      paymentHash: t.payment_hash || undefined,
      preimage: t.preimage || undefined,
      settledAt: t.settled_at ?? null,
      createdAt: t.created_at,
    }));
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

/** Build a Lightning provider from an NWC URI (validates it), or null if empty. */
export function lightningFrom(uri: string | undefined): LightningProvider | null {
  return uri ? NwcProvider.fromUri(uri) : null;
}

/** Build a Lightning provider from the environment (PACT_NWC), or null if unset. */
export function lightningFromEnv(): LightningProvider | null {
  return lightningFrom(process.env.PACT_NWC || undefined);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- bolt11 payment-hash extraction ----------------------------------------

/** Extract the payment hash (hex) from a bolt11 invoice, or null if it can't be parsed. */
export function paymentHashFromInvoice(invoice: string): string | null {
  try {
    const lower = invoice.toLowerCase();
    const { words } = bech32.decode(lower as `${string}1${string}`, lower.length + 1);
    // bolt11 data words = [ 7-word timestamp | tagged fields… | 104-word signature ]
    const taggedEnd = words.length - 104;
    let pos = 7;
    while (pos + 3 <= taggedEnd) {
      const type = words[pos];
      const len = (words[pos + 1] << 5) | words[pos + 2];
      pos += 3;
      if (pos + len > words.length) break;
      if (type === 1) {
        // tag 'p' = 256-bit payment hash
        return Buffer.from(fiveBitToBytes(words.slice(pos, pos + len)).slice(0, 32)).toString('hex');
      }
      pos += len;
    }
    return null;
  } catch {
    return null;
  }
}

/** Amount of a bolt11 invoice in sats, or null if the invoice is amountless. */
export function invoiceAmountSats(invoice: string): number | null {
  try {
    const lower = invoice.toLowerCase();
    const sep = lower.lastIndexOf('1'); // bech32 separator (no '1' in hrp/data otherwise)
    if (sep < 0) return null;
    const hrp = lower.slice(0, sep);
    const m = hrp.match(/([0-9]+)([munp]?)$/);
    if (!m) return null; // no amount → amountless
    const value = parseInt(m[1], 10);
    const satsPer: Record<string, number> = { m: 1e5, u: 100, n: 0.1, p: 1e-4, '': 1e8 };
    return Math.round(value * satsPer[m[2]]);
  } catch {
    return null;
  }
}

function fiveBitToBytes(words: number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// --- Wallet capability / policy detection -----------------------------------
// The start of Pact's per-wallet policy layer: detect the backend and apply
// known quirks, so Pact never submits operations a backend can't perform.

const BACKEND_QUIRKS: Record<string, { canPayAmountless: boolean }> = {
  // phoenixd (often fronted by Alby Hub) rejects 0-amount invoices outright.
  phoenixd: { canPayAmountless: false },
};

function detectBackend(info: Record<string, unknown>): string {
  const alias = String(info.alias ?? '').toLowerCase();
  if (alias.includes('phoenix')) return 'phoenixd';
  const methods = Array.isArray(info.methods) ? (info.methods as unknown[]).map(String) : [];
  if (methods.includes('get_budget') || methods.includes('multi_pay_invoice')) return 'alby-hub';
  return 'unknown';
}

export function capabilitiesFromInfo(info: Record<string, unknown>): WalletCapabilities {
  const methods = Array.isArray(info.methods) ? (info.methods as unknown[]).map(String) : [];
  const backend = detectBackend(info);
  const quirk = BACKEND_QUIRKS[backend];
  // Operator override (per deployment): PACT_WALLET_AMOUNTLESS=true|false wins.
  const override = process.env.PACT_WALLET_AMOUNTLESS;
  const canPayAmountless = override != null ? override === 'true' : quirk ? quirk.canPayAmountless : true;
  return { methods, backend, canPayAmountless };
}
