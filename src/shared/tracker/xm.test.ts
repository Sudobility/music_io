import { describe, expect, it } from 'vitest';
import { readXm } from './xm.js';
import { buildXm } from './xm-fixture.js';

describe('readXm: header', () => {
  it('reads the title, channel count and format', () => {
    const xm = readXm(buildXm({ title: 'sunlight', channels: 8 }));
    expect(xm.title).toBe('sunlight');
    expect(xm.channels).toBe(8);
    expect(xm.format).toBe('xm');
  });

  it('reads the order list, trimmed to the song length', () => {
    const xm = readXm(
      buildXm({ order: [0, 2, 1], patterns: [{ rows: 64 }, { rows: 64 }, { rows: 64 }] }),
    );
    expect(xm.order).toEqual([0, 2, 1]);
  });

  it('rejects a file without the XM signature', () => {
    const bytes = new Uint8Array(buildXm({}));
    bytes[0] = 0;
    expect(() => readXm(bytes.buffer)).toThrow(/not a .*module/i);
  });

  it('rejects a file too short to hold a header', () => {
    expect(() => readXm(new ArrayBuffer(32))).toThrow();
  });
});

describe('readXm: pattern unpacking', () => {
  it('unpacks a masked event, reading only the fields the mask selects', () => {
    const xm = readXm(
      buildXm({ channels: 2, patterns: [{ rows: 1, cells: [[{ note: 49, instrument: 3 }]] }] }),
    );
    // Note 1 is C-0, so MIDI is note + 11.
    expect(xm.patterns[0][0][0]).toMatchObject({ note: 60, instrument: 3 });
    expect(xm.patterns[0][0][1]).toEqual({ instrument: 0, note: null });
  });

  it('unpacks an uncompressed event, where the byte itself is the note', () => {
    // Bit 7 clear means all five fields follow. Treating it as a mask reads
    // the note as a field selector and desynchronises the rest of the row.
    const xm = readXm(
      buildXm({
        channels: 1,
        patterns: [
          {
            rows: 1,
            cells: [[{ note: 49, instrument: 5, effect: 0xf, param: 6, uncompressed: true }]],
          },
        ],
      }),
    );
    expect(xm.patterns[0][0][0]).toMatchObject({ note: 60, instrument: 5, speed: 6 });
  });

  it('treats note 97 as a key off', () => {
    // Confirmed present in all four real modules, unlike DSM's and S3M's.
    const xm = readXm(buildXm({ channels: 1, patterns: [{ rows: 1, cells: [[{ note: 97 }]] }] }));
    expect(xm.patterns[0][0][0].note).toBe('off');
  });

  it('treats note 0 as an empty cell', () => {
    const xm = readXm(buildXm({ channels: 1, patterns: [{ rows: 1, cells: [[{ note: 0 }]] }] }));
    expect(xm.patterns[0][0][0].note).toBeNull();
  });

  it('normalises effect F into speed and bpm as ProTracker does', () => {
    const xm = readXm(
      buildXm({
        channels: 1,
        patterns: [{ rows: 2, cells: [[{ effect: 0xf, param: 6 }], [{ effect: 0xf, param: 125 }]] }],
      }),
    );
    expect(xm.patterns[0][0][0].speed).toBe(6);
    expect(xm.patterns[0][1][0].bpm).toBe(125);
  });

  it('honours each pattern its own row count', () => {
    // dr_wily.xm holds a 76-row pattern among its 64s; mercury.xm holds 32s and
    // 56s. XM is the first format here that is not fixed at 64.
    const xm = readXm(buildXm({ patterns: [{ rows: 32 }, { rows: 76 }] }));
    expect(xm.patterns[0]).toHaveLength(32);
    expect(xm.patterns[1]).toHaveLength(76);
  });

  it('gives an empty pattern its declared rows, blank', () => {
    // packedSize 0 means "this many blank rows", not "no rows". Emitting
    // nothing would shorten the song and shift everything after it.
    const xm = readXm(buildXm({ channels: 3, patterns: [{ rows: 64, empty: true }] }));
    expect(xm.patterns[0]).toHaveLength(64);
    expect(xm.patterns[0][0]).toHaveLength(3);
    expect(xm.patterns[0].every((row) => row.every((c) => c.note === null))).toBe(true);
  });

  it('finds the second pattern, which means it seeked by the first header length', () => {
    const xm = readXm(
      buildXm({
        channels: 1,
        patterns: [
          { rows: 1, cells: [[{ note: 49 }]] },
          { rows: 1, cells: [[{ note: 61 }]] },
        ],
      }),
    );
    expect(xm.patterns[0][0][0].note).toBe(60);
    expect(xm.patterns[1][0][0].note).toBe(72);
  });
});

describe('readXm: instruments', () => {
  it('reads instrument names', () => {
    const xm = readXm(
      buildXm({ instruments: [{ name: 'fndr  -|', samples: 1 }, { name: 'sunshine', samples: 1 }] }),
    );
    expect(xm.instruments[0]).toEqual({ index: 1, name: 'fndr  -|' });
    expect(xm.instruments[1]).toEqual({ index: 2, name: 'sunshine' });
  });

  it('seeks past an instrument with no samples, whose header is 33 bytes not 263', () => {
    // The trap. sunlight.xm has eight empty instruments among fifteen; a reader
    // that assumes 263 loses every instrument after the first empty one.
    const xm = readXm(
      buildXm({
        instruments: [
          { name: 'first', samples: 1 },
          { name: 'empty', samples: 0 },
          { name: 'third', samples: 1 },
        ],
      }),
    );
    expect(xm.instruments.map((i) => i.name)).toEqual(['first', 'empty', 'third']);
  });

  it('seeks past sample data of any size to find the next instrument', () => {
    const xm = readXm(
      buildXm({
        instruments: [
          { name: 'big', samples: 1, sampleLengths: [4096] },
          { name: 'after', samples: 1, sampleLengths: [8] },
        ],
      }),
    );
    expect(xm.instruments.map((i) => i.name)).toEqual(['big', 'after']);
  });

  it('seeks past an instrument with several samples', () => {
    const xm = readXm(
      buildXm({
        instruments: [
          { name: 'multi', samples: 3, sampleLengths: [16, 32, 64] },
          { name: 'after', samples: 1 },
        ],
      }),
    );
    expect(xm.instruments.map((i) => i.name)).toEqual(['multi', 'after']);
  });

  it('finds the instruments at all, which means it walked every pattern first', () => {
    // Instruments follow the patterns, so a pattern-walking bug shows up here
    // as garbage names rather than as a pattern failure.
    const xm = readXm(
      buildXm({
        patterns: [{ rows: 64 }, { rows: 76 }, { rows: 32, empty: true }],
        instruments: [{ name: 'reached', samples: 1 }],
      }),
    );
    expect(xm.instruments[0].name).toBe('reached');
  });
});
