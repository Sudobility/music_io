import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { SharedTrackerCodec } from '../mod/codec.js';
import { readS3m } from './s3m.js';

const DIR = new URL('./fixtures/', import.meta.url).pathname;

describe('real modules', () => {
  const codec = new SharedTrackerCodec();
  for (const name of readdirSync(DIR).filter((f) => !f.endsWith('.md'))) {
    it(`decodes ${name}`, () => {
      const buf = readFileSync(`${DIR}${name}`);
      const module = codec.decode(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
      expect(module.channels).toBeGreaterThan(0);
      expect(module.patterns.length).toBeGreaterThan(0);
      expect(module.order.length).toBeGreaterThan(0);
      // Every row is as wide as the module says it is: a packing bug usually
      // shows up here first, as a short or ragged row.
      for (const pattern of module.patterns) {
        for (const row of pattern) expect(row).toHaveLength(module.channels);
      }
      // Notes that decode to something outside MIDI's range mean the note base
      // or the packing is wrong.
      for (const pattern of module.patterns) {
        for (const row of pattern) {
          for (const cell of row) {
            if (typeof cell.note === 'number') {
              expect(cell.note).toBeGreaterThanOrEqual(0);
              expect(cell.note).toBeLessThanOrEqual(127);
            }
          }
        }
      }
    });
  }
});

describe('S3M real-world quirks', () => {
  const load = (name: string) => {
    const buf = readFileSync(`${DIR}${name}`);
    return readS3m(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  };

  it('gives every pattern 64 rows even where the file stops short', () => {
    // Every pattern in this module yields 62-63 rows of data, and most run one
    // byte past their declared length. Requiring 64 rows rejects the file.
    const s3m = load('portal_to_hell.s3m');
    expect(s3m.patterns).toHaveLength(31);
    for (const pattern of s3m.patterns) expect(pattern).toHaveLength(64);
  });

  it('sizes rows to cover the channels the patterns use', () => {
    // This module enables 16 channels in its header but only reaches 0-8.
    const s3m = load('moving_that_rhythm.s3m');
    expect(s3m.channels).toBeGreaterThanOrEqual(9);
    for (const pattern of s3m.patterns) {
      for (const row of pattern) expect(row).toHaveLength(s3m.channels);
    }
  });

  it('decodes notes into a plausible register, which a wrong octave shift would not', () => {
    const notes = load('moving_that_rhythm.s3m')
      .patterns.flat(2)
      .map((c) => c.note)
      .filter((n): n is number => typeof n === 'number');
    expect(Math.min(...notes)).toBeGreaterThanOrEqual(24);
    expect(Math.max(...notes)).toBeLessThanOrEqual(108);
  });
});
