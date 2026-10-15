// In-process mock NWC (NIP-47) wallet service for paywall tests — speaks the
// exact wire shape packages/pactd/src/lightning.ts drives: kind:23194 NIP-04-
// encrypted requests in, kind:23195 signed+encrypted responses out, matched to
// the request by #e tag over a real WebSocket relay. Tracked: it records every
// request, every signed response it emits, and per-method call counts, so tests
// can capture genuine ciphertexts, replay them in forged envelopes, and prove
// no extra invoices were minted.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { sha256 } from '@noble/hashes/sha2.js';
import * as secp256k1 from '@noble/secp256k1';
import { bech32 } from '@scure/base';
import { WebSocketServer, type WebSocket } from 'ws';

import { finalizeEvent, keypairFromSecret, type NostrEvent } from '../packages/core/src/index.js';

secp256k1.hashes.sha256 = sha256;

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
  const d = createDecipheriv('aes-256-cbc', sharedKey(secret, pubkeyHex), Buffer.from(ivb, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
function bytesToFiveBit(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/**
 * Craft a bolt11-shaped bech32 string whose 'p' tag carries `paymentHashHex`.
 * Only fields pactd's parser reads (timestamp words, tagged fields, 104-word
 * signature tail) are present; no real signature. 1-sat amount (lnbc10n) so the
 * daemon treats it as a fixed-amount invoice.
 */
export function craftBolt11ForHash(paymentHashHex: string): string {
  const hashWords = bytesToFiveBit(Buffer.from(paymentHashHex, 'hex')); // 52 words
  const words = [
    ...[0, 0, 0, 0, 0, 0, 0], // timestamp
    1,
    (hashWords.length >> 5) & 31,
    hashWords.length & 31,
    ...hashWords,
    ...new Array<number>(104).fill(0), // signature placeholder for the parser's window
  ];
  return bech32.encode('lnbc10n', words, 2048);
}

export interface MockWalletQuirks {
  /** Answer "settled" lookups with settled_at: 0 and no preimage (buggy-wallet sim). */
  settledAtZero?: boolean;
  /** Answer with a result_type that does not match the called method. */
  wrongResultType?: boolean;
  /** Settled lookup answers echo a DIFFERENT payment hash than the queried one. */
  wrongPaymentHash?: boolean;
  /** pay_invoice returns a preimage whose sha256 does not match the invoice. */
  badPreimage?: boolean;
}

export interface CapturedResponse {
  method: string;
  paymentHash?: string;
  settled: boolean;
  event: NostrEvent;
}

export interface MockWallet {
  url: string;
  walletPubkey: string;
  nwcUri: string;
  /** Mark an invoice (by payment hash) as settled — lookup_invoice then answers with settlement evidence. */
  markPaid(paymentHash: string): void;
  isPaid(paymentHash: string): boolean;
  quirks: MockWalletQuirks;
  /** Per-method artificial response delay in ms (e.g. to widen race windows). */
  delays: Partial<Record<string, number>>;
  /** Per-method invocation counts. */
  counts: Record<string, number>;
  /** Every genuine, wallet-signed response event, in emission order. */
  responded: CapturedResponse[];
  /** Queue a forged-envelope replay: on the NEXT NWC request, deliver this exact
   * ciphertext wrapped in a wallet-spoofed-pubkey, junk-signature event with the
   * correct #e tag — before the genuine wallet response follows. */
  forgeNextResponse(encryptedContent: string): void;
  close(): Promise<void>;
}

export function startMockWallet(): Promise<MockWallet> {
  const wSec = randomBytes(32);
  const wPub = keypairFromSecret(wSec).pubkeyHex;
  const cSec = randomBytes(32); // client (pactd) secret — embedded in the NWC URI

  const settled = new Set<string>();
  const forgedQueue: string[] = [];
  const counts: Record<string, number> = {};
  const responded: CapturedResponse[] = [];
  const invoices = new Map<string, { paymentHash: string; preimageHex: string; invoice: string }>();

  const wallet: MockWallet = {
    url: '',
    walletPubkey: wPub,
    nwcUri: '',
    markPaid: (hash) => settled.add(hash),
    isPaid: (hash) => settled.has(hash),
    quirks: {},
    delays: {},
    counts,
    responded,
    forgeNextResponse: (content) => forgedQueue.push(content),
    close: () =>
      new Promise((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => done());
      }),
  };

  const pending: Array<{ ws: WebSocket; subId: string; eId: string }> = [];

  /** Forged deliveries race ahead of the genuine response; the sub stays armed. */
  function deliverForged(eId: string, event: Record<string, unknown>): void {
    for (const p of pending.filter((x) => x.eId === eId)) {
      p.ws.send(JSON.stringify(['EVENT', p.subId, event]));
    }
  }

  function deliver(eId: string, event: NostrEvent): void {
    for (const p of pending.filter((x) => x.eId === eId)) {
      p.ws.send(JSON.stringify(['EVENT', p.subId, event]));
      p.ws.send(JSON.stringify(['EOSE', p.subId]));
    }
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].eId === eId) pending.splice(i, 1);
  }

  function answer(rawReq: NostrEvent): void {
    let plain: { method: string; params?: Record<string, any> };
    try {
      plain = JSON.parse(nip04Decrypt(rawReq.content, wSec, rawReq.pubkey));
    } catch {
      return;
    }
    const method = plain.method;
    const params = (plain.params ?? {}) as Record<string, unknown>;
    counts[method] = (counts[method] ?? 0) + 1;

    // Forged-envelope replay goes FIRST — an attacker on the relay races the
    // genuine wallet response and would win against a first-EVENT-wins client.
    while (forgedQueue.length > 0) {
      const content = forgedQueue.shift()!;
      deliverForged(rawReq.id, {
        id: randomBytes(32).toString('hex'),
        pubkey: wPub, // wallet-spoofed author…
        created_at: Math.floor(Date.now() / 1000),
        kind: 23195,
        tags: [
          ['e', rawReq.id], // …with the correct #e binding…
          ['p', rawReq.pubkey],
        ],
        content,
        sig: 'ab'.repeat(64), // …but a junk signature.
      });
    }

    const queriedHash = typeof params.payment_hash === 'string' ? params.payment_hash : undefined;
    let settledAnswer = false;
    let result: Record<string, unknown> = {};
    let error: { code: string; message: string } | undefined;

    if (method === 'get_info') {
      result = {
        alias: 'mock-nwc',
        methods: ['get_info', 'get_balance', 'make_invoice', 'lookup_invoice', 'pay_invoice', 'list_transactions'],
      };
    } else if (method === 'get_balance') {
      result = { balance: 1_000_000 };
    } else if (method === 'make_invoice') {
      const preimageHex = randomBytes(32).toString('hex');
      const paymentHash = Buffer.from(sha256(hexToBytes(preimageHex))).toString('hex');
      const invoice = `lnbc1mock${invoices.size + 1}qqqq`;
      invoices.set(paymentHash, { paymentHash, preimageHex, invoice });
      result = { invoice, payment_hash: paymentHash };
    } else if (method === 'lookup_invoice') {
      const rec = queriedHash ? invoices.get(queriedHash) : [...invoices.values()].find((i) => i.invoice === params.invoice);
      if (!rec) {
        error = { code: 'NOT_FOUND', message: 'unknown invoice' };
      } else if (settled.has(rec.paymentHash)) {
        settledAnswer = true;
        const echoedHash = wallet.quirks.wrongPaymentHash ? randomBytes(32).toString('hex') : rec.paymentHash;
        if (wallet.quirks.settledAtZero) {
          // Buggy-wallet settlement claim: no preimage, zero timestamp.
          result = { type: 'incoming', invoice: rec.invoice, payment_hash: echoedHash, amount: 10000, created_at: 1, settled_at: 0 };
        } else {
          result = {
            type: 'incoming',
            invoice: rec.invoice,
            payment_hash: echoedHash,
            amount: 10000,
            fees_paid: 0,
            preimage: rec.preimageHex,
            created_at: 1,
            settled_at: Math.floor(Date.now() / 1000),
          };
        }
      } else {
        result = { type: 'incoming', invoice: rec.invoice, payment_hash: rec.paymentHash, amount: 10000, created_at: 1, settled_at: null };
      }
    } else if (method === 'pay_invoice') {
      if (wallet.quirks.badPreimage) {
        result = { preimage: 'ff'.repeat(32), fees_paid: 0 };
      } else {
        error = { code: 'PAYMENT_FAILED', message: 'mock wallet declines payments by default' };
      }
    } else if (method === 'list_transactions') {
      result = { transactions: [] };
    }

    const respond = (): void => {
      const payload = wallet.quirks.wrongResultType
        ? { result_type: 'get_balance', result: { balance: 1 } }
        : error
          ? { result_type: method, error }
          : { result_type: method, result };
      const respEv = finalizeEvent(
        {
          pubkey: wPub,
          created_at: Math.floor(Date.now() / 1000),
          kind: 23195,
          tags: [
            ['e', rawReq.id],
            ['p', rawReq.pubkey],
          ],
          content: nip04Encrypt(JSON.stringify(payload), wSec, rawReq.pubkey),
        },
        wSec,
      );
      responded.push({ method, paymentHash: queriedHash, settled: settledAnswer, event: respEv });
      deliver(rawReq.id, respEv);
    };

    const delay = wallet.delays[method];
    if (delay) setTimeout(respond, delay);
    else respond();
  }

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg: any[];
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg[0] === 'REQ') {
        const filter = (msg[2] ?? {}) as Record<string, string[]>;
        const eId = filter['#e']?.[0];
        if (eId) pending.push({ ws, subId: String(msg[1]), eId });
        return;
      }
      if (msg[0] === 'EVENT' && msg[1] && msg[1].kind === 23194) {
        answer(msg[1] as NostrEvent);
      }
    });
  });

  return new Promise((resolve) => {
    wss.on('listening', () => {
      const { port } = wss.address() as { port: number };
      wallet.url = `ws://127.0.0.1:${port}`;
      wallet.nwcUri = `nostr+walletconnect://${wPub}?relay=${encodeURIComponent(wallet.url)}&secret=${cSec.toString('hex')}`;
      resolve(wallet);
    });
  });
}
