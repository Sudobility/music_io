import { describe, expect, it } from 'vitest';
import { readDsm } from './dsm.js';
import { buildDsm } from './dsm-fixture.js';

describe('readDsm: song header', () => {
  it('reads the title, channel count and format', () => {
    const dsm = readDsm(buildDsm({ title: 'Race against time', channels: 4 }));
    expect(dsm.title).toBe('Race against time');
    expect(dsm.channels).toBe(4);
    expect(dsm.format).toBe('dsm');
  });

  it('reads the order list, trimmed to numOrders', () => {
    // The 128-byte order array is mostly junk past the count, exactly as MOD's is.
    const dsm = readDsm(buildDsm({ order: [1, 2, 0], patterns: [[], [], []] }));
    expect(dsm.order).toEqual([1, 2, 0]);
  });

  it('reads instrument names from offset 36 of the INST header', () => {
    const dsm = readDsm(buildDsm({ instrumentNames: ['Blast', 'Poly'] }));
    expect(dsm.instruments[0]).toEqual({ index: 1, name: 'Blast' });
    expect(dsm.instruments[1]).toEqual({ index: 2, name: 'Poly' });
  });

  it('rejects a file that is not a DSM', () => {
    expect(() => readDsm(new ArrayBuffer(64))).toThrow(/riff/i);
  });
});

describe('readDsm: pattern unpacking', () => {
  it('unpacks a cell into channel, note and instrument', () => {
    const dsm = readDsm(buildDsm({ patterns: [[[{ channel: 2, note: 49, instrument: 3 }]]] }));
    // Note 1 is C-0, so MIDI is note + 11.
    expect(dsm.patterns[0][0][2]).toMatchObject({ note: 60, instrument: 3 });
  });

  it('leaves untouched channels empty in that row', () => {
    const dsm = readDsm(buildDsm({ channels: 4, patterns: [[[{ channel: 1, note: 49 }]]] }));
    expect(dsm.patterns[0][0][0]).toEqual({ instrument: 0, note: null });
    expect(dsm.patterns[0][0][3]).toEqual({ instrument: 0, note: null });
  });

  it('produces 64 rows, each as wide as the channel count', () => {
    const dsm = readDsm(buildDsm({ channels: 4, patterns: [[[{ channel: 0, note: 49 }]]] }));
    expect(dsm.patterns[0]).toHaveLength(64);
    expect(dsm.patterns[0][0]).toHaveLength(4);
    expect(dsm.patterns[0][63]).toHaveLength(4);
  });

  it('normalises effect F into speed, as ProTracker does', () => {
    const dsm = readDsm(
      buildDsm({ patterns: [[[{ channel: 0, note: 49, effect: 0xf, param: 0x06 }]]] }),
    );
    expect(dsm.patterns[0][0][0].speed).toBe(6);
  });

  it('normalises effect F above 0x20 into bpm', () => {
    const dsm = readDsm(buildDsm({ patterns: [[[{ channel: 0, effect: 0xf, param: 0x72 }]]] }));
    expect(dsm.patterns[0][0][0].bpm).toBe(0x72);
  });

  it('marks a pattern break', () => {
    const dsm = readDsm(buildDsm({ patterns: [[[{ channel: 0, effect: 0xd }]]] }));
    expect(dsm.patterns[0][0][0].patternBreak).toBe(true);
  });

  it('reads a volume byte without mistaking it for anything else', () => {
    // The volume column is the one flag bit MOD has no equivalent for; getting
    // its position wrong shifts every following byte in the row.
    const dsm = readDsm(
      buildDsm({
        patterns: [[[{ channel: 0, note: 49, volume: 40, effect: 0xf, param: 0x06 }]]],
      }),
    );
    expect(dsm.patterns[0][0][0]).toMatchObject({ note: 60, speed: 6 });
  });

  it('unpacks several events in one row, in channel order', () => {
    const dsm = readDsm(
      buildDsm({ patterns: [[[{ channel: 0, note: 49 }, { channel: 2, note: 61 }]]] }),
    );
    expect(dsm.patterns[0][0][0].note).toBe(60);
    expect(dsm.patterns[0][0][1].note).toBeNull();
    expect(dsm.patterns[0][0][2].note).toBe(72);
  });
});
