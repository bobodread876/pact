// In-process Nostr relay for tests: NIP-01 EVENT/REQ/EOSE/OK over a real
// WebSocket server, with the filter subset pact uses (kinds, authors, #d, #p,
// #t, since, until, limit). Behaves like a real relay where it matters for
// limit-dependent code: it rejects events whose id/signature don't verify, and
// it serves the NEWEST `limit` matches (created_at desc, then id asc).

import { verifyEvent } from '@mate-protocol/core';
import { WebSocketServer } from 'ws';

interface StoredEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Filter {
  kinds?: number[];
  authors?: string[];
  '#d'?: string[];
  '#p'?: string[];
  '#t'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

function tagValues(event: StoredEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name).map((t) => t[1]);
}

function matches(event: StoredEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const key of ['#d', '#p', '#t'] as const) {
    const wanted = filter[key];
    if (wanted && !tagValues(event, key.slice(1)).some((v) => wanted.includes(v))) return false;
  }
  return true;
}

export interface MockRelay {
  url: string;
  events: StoredEvent[];
  /** Number of REQ subscriptions received so far (to assert "no relay round trip"). */
  reqCount(): number;
  /** When true, every EVENT is answered OK=false and not stored (a relay that rejects writes). */
  setRejectEvents(reject: boolean): void;
  close(): Promise<void>;
}

export function startMockRelay(): Promise<MockRelay> {
  const events: StoredEvent[] = [];
  let reqs = 0;
  let rejectEvents = false;
  const wss = new WebSocketServer({ port: 0 });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(raw)) as unknown[];
      } catch {
        return;
      }
      if (msg[0] === 'EVENT' && msg[1]) {
        const event = msg[1] as StoredEvent;
        if (rejectEvents) {
          ws.send(JSON.stringify(['OK', event.id, false, 'blocked: test relay rejects writes']));
          return;
        }
        if (!verifyEvent(event)) {
          ws.send(JSON.stringify(['OK', event.id, false, 'invalid: bad id or signature']));
          return;
        }
        // Addressable kinds (30000–39999): keep only the newest (author, d) event
        // (NIP-01: newest created_at, ties to the lowest id).
        if (event.kind >= 30000 && event.kind < 40000) {
          const d = tagValues(event, 'd')[0];
          const prior = events.findIndex(
            (e) => e.kind === event.kind && e.pubkey === event.pubkey && tagValues(e, 'd')[0] === d,
          );
          if (prior >= 0) {
            const old = events[prior];
            const newer = event.created_at > old.created_at || (event.created_at === old.created_at && event.id < old.id);
            if (!newer) {
              ws.send(JSON.stringify(['OK', event.id, true, 'duplicate: have a newer event']));
              return;
            }
            events.splice(prior, 1);
          }
        }
        events.push(event);
        ws.send(JSON.stringify(['OK', event.id, true, '']));
      } else if (msg[0] === 'REQ' && typeof msg[1] === 'string') {
        reqs += 1;
        const subId = msg[1];
        const filter = (msg[2] ?? {}) as Filter;
        const matched = events
          .filter((e) => matches(e, filter))
          .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, filter.limit ?? 500);
        for (const event of matched) {
          ws.send(JSON.stringify(['EVENT', subId, event]));
        }
        ws.send(JSON.stringify(['EOSE', subId]));
      }
    });
  });

  return new Promise((resolve) => {
    wss.on('listening', () => {
      const { port } = wss.address() as { port: number };
      resolve({
        url: `ws://127.0.0.1:${port}`,
        events,
        reqCount: () => reqs,
        setRejectEvents: (reject: boolean) => {
          rejectEvents = reject;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
