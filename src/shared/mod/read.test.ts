import { describe, expect, it } from 'vitest';
import { readMod } from './read.js';
import { buildMod } from './fixture.js';

describe('readMod', () => {
  it('reads the title and sample names', () => {
    const mod = readMod(buildMod({ title: 'Elysium', sampleNames: ['bass', 'lead'] }));
    expect(mod.title).toBe('Elysium');
    expect(mod.samples[0].name).toBe('bass');
    expect(mod.samples[1].name).toBe('lead');
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

  it('unpacks a cell into sample, period, effect and param', () => {
    const mod = readMod(
      buildMod({ patterns: [[[{ sample: 5, period: 428, effect: 0xf, param: 0x03 }]]] }),
    );
    const cell = mod.patterns[0][0][0];
    expect(cell).toEqual({ sample: 5, period: 428, effect: 0xf, param: 0x03 });
  });

  it('reads sample numbers above 15, which span both nibbles', () => {
    // The classic MOD parsing bug: the sample number is split across two bytes.
    const mod = readMod(buildMod({ patterns: [[[{ sample: 31, period: 428 }]]] }));
    expect(mod.patterns[0][0][0].sample).toBe(31);
  });

  it('reports an empty cell as period 0', () => {
    const mod = readMod(buildMod({ patterns: [[[{}]]] }));
    expect(mod.patterns[0][0][0].period).toBe(0);
  });

  it('rejects a file with no recognisable magic', () => {
    expect(() => readMod(new ArrayBuffer(2000))).toThrow(/not a .*module/i);
  });

  it('rejects a file too short to hold a header', () => {
    expect(() => readMod(new ArrayBuffer(64))).toThrow();
  });
});
