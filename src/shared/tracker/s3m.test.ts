import { describe, expect, it } from 'vitest';
import { readS3m } from './s3m.js';
import { buildS3m } from './s3m-fixture.js';

describe('readS3m: header', () => {
  it('reads the title and format', () => {
    const s3m = readS3m(buildS3m({ title: 'Portal to hell' }));
    expect(s3m.title).toBe('Portal to hell');
    expect(s3m.format).toBe('s3m');
  });

  it('reads the order list, trimmed to ordNum', () => {
    const s3m = readS3m(buildS3m({ order: [0, 2, 1], patterns: [[], [], []] }));
    expect(s3m.order).toEqual([0, 2, 1]);
  });

  it('reads instrument names from offset 48 of the instrument header', () => {
    const s3m = readS3m(buildS3m({ instrumentNames: ['Inesyn1', 'Inedrum1'] }));
    expect(s3m.instruments[0]).toEqual({ index: 1, name: 'Inesyn1' });
    expect(s3m.instruments[1]).toEqual({ index: 2, name: 'Inedrum1' });
  });

  it('accepts an empty instrument slot rather than rejecting the file', () => {
    // Instrument 5 of a real module has type 0 and no SCRS magic.
    const s3m = readS3m(buildS3m({ instrumentNames: ['Lead', '', 'Bass'] }));
    expect(s3m.instruments).toHaveLength(3);
    expect(s3m.instruments[1].name).toBe('');
  });

  it('rejects a file without the SCRM magic', () => {
    const bytes = new Uint8Array(buildS3m({}));
    bytes[44] = 0;
    expect(() => readS3m(bytes.buffer)).toThrow(/not a .*module/i);
  });

  it('rejects a file too short to hold a header', () => {
    expect(() => readS3m(new ArrayBuffer(32))).toThrow();
  });
});

describe('readS3m: pattern unpacking', () => {
  it('unpacks (octave << 4) | note into MIDI', () => {
    // 0x45 is octave 4, note 5 — F. C-0 is MIDI 12, so this is 12 + 48 + 5.
    const s3m = readS3m(buildS3m({ patterns: [[[{ channel: 0, note: 0x45, instrument: 3 }]]] }));
    expect(s3m.patterns[0][0][0]).toMatchObject({ note: 65, instrument: 3 });
  });

  it('reads a note and its instrument as one pair, under one flag bit', () => {
    // Note and instrument share flag 32. Reading only one of them shifts every
    // remaining byte in the row.
    const s3m = readS3m(
      buildS3m({
        patterns: [
          [[{ channel: 0, note: 0x45, instrument: 7 }, { channel: 1, note: 0x50, instrument: 9 }]],
        ],
      }),
    );
    expect(s3m.patterns[0][0][0]).toMatchObject({ note: 65, instrument: 7 });
    expect(s3m.patterns[0][0][1]).toMatchObject({ note: 72, instrument: 9 });
  });

  it('treats 0xFF as an empty cell and 0xFE as a note off', () => {
    const s3m = readS3m(
      buildS3m({ patterns: [[[{ channel: 0, note: 0xff }], [{ channel: 0, note: 0xfe }]]] }),
    );
    expect(s3m.patterns[0][0][0].note).toBeNull();
    expect(s3m.patterns[0][1][0].note).toBe('off');
  });

  it('normalises command A into speed and T into bpm', () => {
    const s3m = readS3m(
      buildS3m({
        patterns: [[[{ channel: 0, command: 1, info: 6 }], [{ channel: 0, command: 20, info: 125 }]]],
      }),
    );
    expect(s3m.patterns[0][0][0].speed).toBe(6);
    expect(s3m.patterns[0][1][0].bpm).toBe(125);
  });

  it('reads a volume byte without mistaking it for anything else', () => {
    const s3m = readS3m(
      buildS3m({
        patterns: [[[{ channel: 0, note: 0x45, instrument: 1, volume: 40, command: 1, info: 6 }]]],
      }),
    );
    expect(s3m.patterns[0][0][0]).toMatchObject({ note: 65, speed: 6 });
  });

  it('produces 64 rows even when the data stops short', () => {
    // Quirk 1: a real module omits its trailing empty rows and sometimes the
    // final terminator. Requiring 64 rows of data rejects it.
    const s3m = readS3m(
      buildS3m({ truncateLastRow: true, patterns: [[[{ channel: 0, note: 0x45 }]]] }),
    );
    expect(s3m.patterns[0]).toHaveLength(64);
    expect(s3m.patterns[0][63].every((c) => c.note === null)).toBe(true);
  });

  it('keeps every channel the patterns actually use, even past what the header enables', () => {
    // Quirk 2, in its dangerous direction: erring narrow loses music.
    const s3m = readS3m(buildS3m({ channels: 2, patterns: [[[{ channel: 5, note: 0x45 }]]] }));
    expect(s3m.channels).toBeGreaterThanOrEqual(6);
    expect(s3m.patterns[0][0][5].note).toBe(65);
  });

  it('keeps the channels the header enables even when the patterns are silent', () => {
    // Quirk 2, in its harmless direction: a real module enables 16 and uses 9.
    // Empty columns cost nothing downstream, since tracks come from instruments.
    const s3m = readS3m(buildS3m({ channels: 8, patterns: [[[{ channel: 0, note: 0x45 }]]] }));
    expect(s3m.channels).toBe(8);
    expect(s3m.patterns[0][0]).toHaveLength(8);
  });
});
