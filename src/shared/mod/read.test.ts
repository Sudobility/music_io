import { describe, expect, it } from 'vitest';
import { readMod } from './read.js';
import { buildMod } from './fixture.js';

describe('readMod', () => {
  it('reads the title and sample names', () => {
    const mod = readMod(buildMod({ title: 'Elysium', sampleNames: ['bass', 'lead'] }));
    expect(mod.title).toBe('Elysium');
    expect(mod.instruments[0].name).toBe('bass');
    expect(mod.instruments[1].name).toBe('lead');
  });

  it('reads four channels from an M.K. module', () => {
    expect(readMod(buildMod({})).channels).toBe(4);
  });

  it('trims the order list to the song length', () => {
    // The 128-byte order list is mostly junk past the song length; reading it
    // whole would play patterns the song never reaches.
    const mod = readMod(buildMod({ order: [0, 1, 0] }));
    expect(mod.order).toEqual([0, 1, 0]);
  });

  it('unpacks a cell into an instrument and a note, converting the period', () => {
    // Periods do not survive decoding: only MOD has them, so the neutral cell
    // carries the note number every other format stores directly.
    const mod = readMod(
      buildMod({ patterns: [[[{ sample: 5, period: 428, effect: 0xf, param: 0x03 }]]] }),
    );
    expect(mod.patterns[0][0][0]).toEqual({ instrument: 5, note: 48, speed: 0x03 });
  });

  it('normalises effect F into speed below 0x20 and bpm above it', () => {
    const slow = readMod(buildMod({ patterns: [[[{ sample: 1, period: 428, effect: 0xf, param: 0x06 }]]] }));
    expect(slow.patterns[0][0][0].speed).toBe(6);
    expect(slow.patterns[0][0][0].bpm).toBeUndefined();

    const fast = readMod(buildMod({ patterns: [[[{ sample: 1, period: 428, effect: 0xf, param: 0x7d }]]] }));
    expect(fast.patterns[0][0][0].bpm).toBe(0x7d);
    expect(fast.patterns[0][0][0].speed).toBeUndefined();
  });

  it('marks a pattern break, which used to be ignored', () => {
    const mod = readMod(buildMod({ patterns: [[[{ sample: 1, period: 428, effect: 0xd }]]] }));
    expect(mod.patterns[0][0][0].patternBreak).toBe(true);
  });

  it('reads sample numbers above 15, which span both nibbles', () => {
    // The classic MOD parsing bug: the sample number is split across two bytes.
    const mod = readMod(buildMod({ patterns: [[[{ sample: 31, period: 428 }]]] }));
    expect(mod.patterns[0][0][0].instrument).toBe(31);
  });

  it('reports an empty cell as no note', () => {
    const mod = readMod(buildMod({ patterns: [[[{}]]] }));
    expect(mod.patterns[0][0][0].note).toBeNull();
  });

  it('rejects a file with no recognisable magic', () => {
    expect(() => readMod(new ArrayBuffer(2000))).toThrow(/not a .*module/i);
  });

  it('rejects a file too short to hold a header', () => {
    expect(() => readMod(new ArrayBuffer(64))).toThrow();
  });
});
