// In-process Nostr relay for tests: NIP-01 EVENT/REQ/EOSE/OK over a real
// WebSocket server, with the filter subset pact uses (kinds, authors, #d, #p, #t).

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
  limit?: number;
}

function tagValues(event: StoredEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name).map((t) => t[1]);
}

function matches(event: StoredEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  for (const key of ['#d', '#p', '#t'] as const) {
    const wanted = filter[key];
    if (wanted && !tagValues(event, key.slice(1)).some((v) => wanted.includes(v))) return false;
  }
  return true;
}

export interface MockRelay {
  url: string;
  events: StoredEvent[];
  close(): Promise<void>;
}

export function startMockRelay(): Promise<MockRelay> {
  const events: StoredEvent[] = [];
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
        // Addressable kinds (30000–39999): replace prior (author, d) event.
        if (event.kind >= 30000 && event.kind < 40000) {
          const d = tagValues(event, 'd')[0];
          const prior = events.findIndex(
            (e) => e.kind === event.kind && e.pubkey === event.pubkey && tagValues(e, 'd')[0] === d,
          );
          if (prior >= 0) events.splice(prior, 1);
        }
        events.push(event);
        ws.send(JSON.stringify(['OK', event.id, true, '']));
      } else if (msg[0] === 'REQ' && typeof msg[1] === 'string') {
        const subId = msg[1];
        const filter = (msg[2] ?? {}) as Filter;
        const matched = events.filter((e) => matches(e, filter)).slice(0, filter.limit ?? 500);
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
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
