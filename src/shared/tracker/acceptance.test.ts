import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { SharedTrackerCodec } from '../mod/codec.js';

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
