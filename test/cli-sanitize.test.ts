// Regression for the terminal-escape injection audit finding (F-15, CWE-150):
// `pact bond list` / `pact discover` / `pact bond verify` printed relay-
// controlled strings (bond ids, `about` text, author npubs, sought kinds)
// straight to stdout. An OSC-52 sequence in a bond's `about` field —
//   ESC ] 52 ; c ; <base64> BEL
// writes attacker-chosen text into the operator's clipboard the moment the
// line is printed; CSI sequences (ESC [ 2 J) clear or repaint the screen.
// The CLI now strips control characters and whole escape sequences from every
// untrusted string before it reaches a human-readable line. JSON output is
// left alone: JSON.stringify byte-escapes ESC/BEL already (locked below).

import { describe, expect, it } from 'vitest';

import type { BondView, Candidate } from 'pact-sdk';

import { bondLine, candidateLine, sanitizeTerminal } from '../packages/cli/src/index.js';

// The exact PoC payloads from the audit.
const POC_OSC52 = 'hello\u001b]52;c;aGVsbG8=\u0007'; // OSC-52: set clipboard to "hello"
const POC_CSI_CLEAR = '\u001b[2J'; // CSI: clear the whole screen
const POC_BRACKETED_PASTE = '\u001b[?2004hpasted\u001b[?2004l';

function expectNoControlBytes(s: string): void {
  expect(s).not.toMatch(/[\u001b\u0007]/);
  expect(s).not.toMatch(/[\u0080-\u009f]/); // C1 controls (incl. C1 CSI/OSC)
}

function bondView(over: Partial<BondView>): BondView {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    author: '22'.repeat(32),
    bond: 'urn:mate:test',
    counterparty: '11'.repeat(32),
    state: 'proposed',
    kind: null,
    created_at: 1000,
    signature_valid: true,
    visibility: 'public',
    ...over,
  };
}

function candidate(over: Partial<Candidate>): Candidate {
  return {
    author: '22'.repeat(32),
    seeking: ['companion'],
    intentAt: 1000,
    record: { bonds: 1, reaffirmations: 0, oldestBondDays: 0 },
    score: 2,
    ...over,
  };
}

describe('sanitizeTerminal', () => {
  it('strips the OSC-52 clipboard-write PoC, leaving no escape bytes or OSC remnants', () => {
    const out = sanitizeTerminal(POC_OSC52);
    expectNoControlBytes(out);
    expect(out).not.toContain(']52;'); // the OSC body is gone, not just its ESC
    expect(out).not.toContain('aGVsbG8'); // the base64 clipboard payload
  });

  it('strips CSI sequences (screen clear) wholesale, not just the ESC byte', () => {
    const out = sanitizeTerminal(`read this${POC_CSI_CLEAR}not this`);
    expectNoControlBytes(out);
    expect(out).not.toContain('[2J');
    expect(out).not.toContain('2J');
    expect(out).toContain('read this');
  });

  it('strips bracketed-paste mode toggles', () => {
    const out = sanitizeTerminal(POC_BRACKETED_PASTE);
    expectNoControlBytes(out);
    expect(out).not.toContain('[?2004h');
    expect(out).not.toContain('[?2004l');
  });

  it('strips lone BEL, ESC, and C1 control characters anywhere in the string', () => {
    const out = sanitizeTerminal('a\u0007b\u001bc\u009bd\u009de');
    expectNoControlBytes(out);
    expect(out).toBe('abcde');
  });

  it('leaves benign text — including tab, newline, and unicode — byte-identical', () => {
    const benign = [
      'hello world',
      'companion/collaboration',
      '✓  🔒  …  “quoted”  — em dash',
      'line one\nline two',
      'column\tsep',
      '',
    ];
    for (const s of benign) {
      expect(sanitizeTerminal(s)).toBe(s);
    }
  });
});

describe('CLI human-readable lines', () => {
  it('bondLine sanitizes the relay-controlled bond id, author, and state', () => {
    const line = bondLine(
      bondView({
        bond: `urn:mate:${POC_OSC52}`,
        author: POC_OSC52 + '22'.repeat(32),
        state: `proposed${POC_CSI_CLEAR}`,
        signature_valid: false,
      }),
    );
    expectNoControlBytes(line);
    expect(line).not.toContain(']52;');
    // Benign structure survives: marks, padding, the author ellipsis.
    expect(line).toContain('✗');
    expect(line).toContain('…');
  });

  it('candidateLine sanitizes relay-controlled about, seeking kinds, and author', () => {
    const line = candidateLine(
      candidate({
        author: POC_OSC52 + '22'.repeat(32),
        seeking: ['companion\u0007', `co${POC_CSI_CLEAR}llab`],
        about: POC_OSC52,
      }),
    );
    expectNoControlBytes(line);
    expect(line).not.toContain(']52;');
    expect(line).not.toContain('[2J');
  });

  it('candidateLine keeps the pre-fix one-line shape byte-identical for benign input', () => {
    const c = candidate({ seeking: ['companion', 'collaboration'], about: undefined, score: 12.34 });
    c.record = { bonds: 3, reaffirmations: 2, oldestBondDays: 10 };
    const line = candidateLine(c);
    expect(line).toBe(
      `  ${(12.34).toFixed(1).padStart(6)}  ${c.author.slice(0, 12)}…  seeks companion/collaboration  · 3 bond(s), 2 reaffirmation(s)`,
    );
  });

  it('JSON output is already byte-escaped (ESC/BEL never raw), so it stays untouched', () => {
    const s = JSON.stringify({ about: POC_OSC52 });
    expect(s).not.toMatch(/[\u001b\u0007]/);
    expect(JSON.parse(s)).toEqual({ about: POC_OSC52 });
  });
});
