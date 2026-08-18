import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { SharedTrackerCodec } from '../mod/codec.js';
import { readIt } from './it.js';
import { readS3m } from './s3m.js';
import { readXm } from './xm.js';

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

describe('XM real-world findings', () => {
  const load = (name: string) => {
    const buf = readFileSync(`${DIR}${name}`);
    return readXm(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  };

  it('reads every instrument past the empty ones', () => {
    // sunlight.xm has eight instruments with no samples among fifteen. A reader
    // assuming a 263-byte header loses everything after the first of them.
    const xm = load('sunlight.xm');
    expect(xm.instruments).toHaveLength(15);
    expect(xm.instruments.filter((i) => i.name.length > 0).length).toBeGreaterThan(1);
  });

  it('gives each pattern its own row count', () => {
    const xm = load('dr_wily.xm');
    const lengths = new Set(xm.patterns.map((p) => p.length));
    expect(lengths.has(64)).toBe(true);
    expect(lengths.has(76)).toBe(true);
  });

  it('gives an empty pattern its declared rows rather than none', () => {
    const xm = load('dr_wily.xm');
    for (const pattern of xm.patterns) expect(pattern.length).toBeGreaterThan(0);
  });

  it('finds key offs, which no earlier format had in a real file', () => {
    const offs = load('sunlight.xm')
      .patterns.flat(2)
      .filter((c) => c.note === 'off');
    expect(offs.length).toBeGreaterThan(0);
  });
});

describe('IT real-world findings', () => {
  const load = (name: string) => {
    const buf = readFileSync(`${DIR}${name}`);
    return readIt(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  };
  const notesOf = (name: string) =>
    load(name)
      .patterns.flat(2)
      .map((c) => c.note)
      .filter((n): n is number => typeof n === 'number');

  it('recognises MPTM by cmwt alone', () => {
    expect(load('thereal1.it').format).toBe('it');
    expect(load('preparator.mptm').format).toBe('mptm');
  });

  it('keeps note 119 inside MIDI, which a twelve-semitone base would not', () => {
    // preparator.mptm reaches note 119. At `note + 12` that is MIDI 131.
    const notes = notesOf('preparator.mptm');
    expect(Math.max(...notes)).toBe(119);
    expect(Math.min(...notes)).toBe(36);
  });

  it('puts the lowest drum note on the General MIDI kick', () => {
    // Both files are drum kits — thereal1.it names "bm (kick)", preparator
    // "Kick-013". MIDI 36 is the GM bass drum; an octave up would be 48.
    expect(Math.min(...notesOf('thereal1.it'))).toBe(37);
    expect(Math.min(...notesOf('preparator.mptm'))).toBe(36);
  });

  it('reads the replayed notes, which a structurally-correct reader would lose', () => {
    // 3,823 of these come from read bits and 1,246 — a quarter — from replay
    // bits alone. Dropping the replay half still unpacks every byte cleanly and
    // still lands on every declared row; it just returns 3,823 notes.
    expect(notesOf('thereal1.it')).toHaveLength(5069);
  });

  it('assigns almost every note an instrument, which comes mostly from replay', () => {
    // 271 instruments are read and 4,798 replayed — 17.7 to 1. Without the
    // replay half nearly every note lands on instrument 0 and groups onto one
    // wrong track.
    const cells = load('thereal1.it')
      .patterns.flat(2)
      .filter((c) => typeof c.note === 'number');
    const placed = cells.filter((c) => c.instrument > 0);
    expect(placed.length / cells.length).toBeGreaterThan(0.9);
  });

  it('gives each pattern its own row count', () => {
    // preparator.mptm has six distinct lengths, including 63 and 65 either side
    // of 64 — where an off-by-one in the row loop would hide.
    const rows = new Set(load('preparator.mptm').patterns.map((p) => p.length));
    expect(rows).toEqual(new Set([8, 56, 63, 64, 65, 72]));
  });

  it('stops the order list at the end marker and keeps the skip marker', () => {
    // thereal1.it carries both: four 254 separators, and 255 as its last entry.
    const order = load('thereal1.it').order;
    expect(order).not.toContain(255);
    expect(order.filter((o) => o === 254)).toHaveLength(4);
  });

  it('treats note-off, note-cut and OpenMPT note-fade alike', () => {
    const offs = (name: string) =>
      load(name)
        .patterns.flat(2)
        .filter((c) => c.note === 'off');
    // thereal1.it: 915 offs + 44 cuts. preparator.mptm adds 4 note-fades (253),
    // which exist in the MPTM files alone — an IT-only reader emits MIDI 253.
    expect(offs('thereal1.it')).toHaveLength(959);
    expect(offs('preparator.mptm')).toHaveLength(757);
  });

  it('reads every instrument name', () => {
    expect(load('thereal1.it').instruments.filter((i) => i.name.length > 0)).toHaveLength(11);
    expect(load('preparator.mptm').instruments.filter((i) => i.name.length > 0)).toHaveLength(13);
  });
});
