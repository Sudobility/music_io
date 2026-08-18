import { describe, expect, it } from 'vitest';
import { buildIt } from './it-fixture.js';
import { readIt } from './it.js';

describe('readIt', () => {
  it('rejects a file without the IMPM magic', () => {
    const bytes = new Uint8Array(256);
    expect(() => readIt(bytes.buffer)).toThrow(/Not an Impulse Tracker module/);
  });

  it('reads the title', () => {
    expect(readIt(buildIt({ title: 'Sad Song' })).title).toBe('Sad Song');
  });

  it('reads instrument names from the IMPI header, not the sample header', () => {
    // Both tables are populated with different names on purpose: reading the
    // wrong table would still return plausible strings.
    const module = readIt(
      buildIt({ instruments: ['hihat', 'ride'], samples: ['untitled', 'untitled'] }),
    );
    expect(module.instruments.map((i) => i.name)).toEqual(['hihat', 'ride']);
  });

  it('numbers instruments from one', () => {
    const module = readIt(buildIt({ instruments: ['a', 'b'] }));
    expect(module.instruments.map((i) => i.index)).toEqual([1, 2]);
  });

  it('truncates the order list at the end-of-song marker', () => {
    const module = readIt(buildIt({ order: [0, 1, 255, 0], patterns: [{ rows: 4 }, { rows: 4 }] }));
    expect(module.order).toEqual([0, 1]);
  });

  it('keeps the skip marker, which flattenRows drops as an unknown pattern', () => {
    // 254 is a separator. It is not a pattern index and not an end marker.
    const module = readIt(buildIt({ order: [0, 254, 1], patterns: [{ rows: 4 }, { rows: 4 }] }));
    expect(module.order).toEqual([0, 254, 1]);
  });

  it('reports mptm only for cmwt 0x0888', () => {
    expect(readIt(buildIt({ cmwt: 0x0214 })).format).toBe('it');
    expect(readIt(buildIt({ cmwt: 0x0200 })).format).toBe('it');
    expect(readIt(buildIt({ cmwt: 0x0888 })).format).toBe('mptm');
  });
});

describe('IT pattern unpacking', () => {
  const cell = (module: ReturnType<typeof readIt>, row: number, ch: number) =>
    module.patterns[0][row][ch];

  it('gives each pattern the row count from its own header', () => {
    const module = readIt(buildIt({ patterns: [{ rows: 128 }, { rows: 417 }], order: [0, 1] }));
    expect(module.patterns[0]).toHaveLength(128);
    expect(module.patterns[1]).toHaveLength(417);
  });

  it('gives an empty pattern 64 blank rows rather than none', () => {
    const module = readIt(buildIt({ patterns: [{ rows: 64, empty: true }] }));
    expect(module.patterns[0]).toHaveLength(64);
    expect(module.patterns[0][0].every((c) => c.note === null)).toBe(true);
  });

  it('reads a fully specified cell', () => {
    const module = readIt(
      buildIt({ patterns: [{ rows: 2, cells: [[{ note: 48, instrument: 3, volume: 64 }]] }] }),
    );
    expect(cell(module, 0, 0).note).toBe(48);
    expect(cell(module, 0, 0).instrument).toBe(3);
  });

  it('maps note 60 to MIDI 60 and note 119 into range', () => {
    // IT's "C-5" is middle C. Adding an octave, as XM and DSM's bases would
    // suggest, puts note 119 at MIDI 131 — and preparator.mptm uses note 119.
    const module = readIt(
      buildIt({ patterns: [{ rows: 2, cells: [[{ note: 60 }], [{ note: 119 }]] }] }),
    );
    expect(cell(module, 0, 0).note).toBe(60);
    expect(cell(module, 1, 0).note).toBe(119);
  });

  it('maps note-off, note-cut and OpenMPT note-fade alike', () => {
    // 253 is a fade, and appears in the MPTM files alone — a reader written
    // against IT emits MIDI 253 for it, which is not a note at all.
    const module = readIt(
      buildIt({ patterns: [{ rows: 3, cells: [[{ note: 255 }], [{ note: 254 }], [{ note: 253 }]] }] }),
    );
    expect(cell(module, 0, 0).note).toBe('off');
    expect(cell(module, 1, 0).note).toBe('off');
    expect(cell(module, 2, 0).note).toBe('off');
  });

  // The heart of the format. Without the replay half, this test's second row
  // comes back empty while every structural assertion still passes.
  it('replays a channel remembered note and instrument, consuming no bytes', () => {
    const module = readIt(
      buildIt({
        patterns: [
          {
            rows: 3,
            cells: [
              [{ note: 60, instrument: 7 }],
              [{ replay: ['note', 'instrument'] }],
              [{ note: 62 }],
            ],
          },
        ],
      }),
    );
    expect(cell(module, 1, 0).note).toBe(60);
    expect(cell(module, 1, 0).instrument).toBe(7);
    // The stream must still be aligned afterwards.
    expect(cell(module, 2, 0).note).toBe(62);
  });

  it('remembers per channel, not globally', () => {
    const module = readIt(
      buildIt({
        patterns: [
          {
            rows: 2,
            cells: [
              [
                { note: 60, instrument: 1 },
                { note: 40, instrument: 2 },
              ],
              [{ replay: ['note', 'instrument'] }, { replay: ['note', 'instrument'] }],
            ],
          },
        ],
      }),
    );
    expect(cell(module, 1, 0).note).toBe(60);
    expect(cell(module, 1, 0).instrument).toBe(1);
    expect(cell(module, 1, 1).note).toBe(40);
    expect(cell(module, 1, 1).instrument).toBe(2);
  });

  it('reuses the remembered mask when the channel byte has bit 7 clear', () => {
    const module = readIt(
      buildIt({
        patterns: [
          {
            rows: 2,
            cells: [
              [{ note: 50, instrument: 4 }],
              [{ note: 52, instrument: 5, reuseMask: true }],
            ],
          },
        ],
      }),
    );
    // Row 1 wrote no mask byte; the reader must reuse "note + instrument".
    expect(cell(module, 1, 0).note).toBe(52);
    expect(cell(module, 1, 0).instrument).toBe(5);
  });

  it('applies IT commands with S3M numbering', () => {
    // 1 = A = speed, 20 = T = tempo. ProTracker numbering would read these as
    // something else entirely, so checking both knobs pins the choice.
    const module = readIt(
      buildIt({
        patterns: [
          { rows: 2, cells: [[{ command: 1, param: 3 }], [{ command: 20, param: 140 }]] },
        ],
      }),
    );
    expect(cell(module, 0, 0).speed).toBe(3);
    expect(cell(module, 1, 0).bpm).toBe(140);
  });

  it('sizes rows to the widest channel any pattern reaches', () => {
    const module = readIt(
      buildIt({ patterns: [{ rows: 1, cells: [[{ note: 60 }, undefined, undefined, { note: 62 }]] }] }),
    );
    expect(module.channels).toBe(4);
    for (const row of module.patterns[0]) expect(row).toHaveLength(4);
  });
});
