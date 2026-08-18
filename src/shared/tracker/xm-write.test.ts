import { describe, expect, it } from 'vitest';
import type { TrackerCell, TrackerModule } from '@sudobility/music_types';
import { encodeXm } from './xm-write.js';
import { readXm } from './xm.js';

const cell = (over: Partial<TrackerCell> = {}): TrackerCell => ({
  instrument: 0,
  note: null,
  ...over,
});

function moduleOf(rows: TrackerCell[][][], channels: number): TrackerModule {
  return {
    format: 'xm',
    title: 'Round Trip',
    channels,
    instruments: [
      { index: 1, name: 'Acoustic Grand Piano' },
      { index: 2, name: 'Fretless Bass' },
    ],
    order: rows.map((_, i) => i),
    patterns: rows,
  };
}

/** One 64-row pattern with the given cells written at row 0. */
function oneRow(cells: TrackerCell[]): TrackerModule {
  const pattern = Array.from({ length: 64 }, (_, r) =>
    Array.from({ length: cells.length }, (_, c) => (r === 0 ? cells[c] : cell())),
  );
  return moduleOf([pattern], cells.length);
}

describe('encodeXm', () => {
  it('writes a file our own reader accepts', () => {
    const module = oneRow([cell({ note: 60, instrument: 1 })]);
    const back = readXm(encodeXm(module));
    expect(back.format).toBe('xm');
    expect(back.title).toBe('Round Trip');
  });

  it('round-trips notes and instruments', () => {
    const module = oneRow([cell({ note: 60, instrument: 1 }), cell({ note: 48, instrument: 2 })]);
    const back = readXm(encodeXm(module));
    expect(back.patterns[0][0][0]).toMatchObject({ note: 60, instrument: 1 });
    expect(back.patterns[0][0][1]).toMatchObject({ note: 48, instrument: 2 });
  });

  it('round-trips a release', () => {
    const module = oneRow([cell({ note: 'off' })]);
    expect(readXm(encodeXm(module)).patterns[0][0][0].note).toBe('off');
  });

  it('round-trips instrument names, which is what the slots are for', () => {
    const back = readXm(encodeXm(oneRow([cell({ note: 60, instrument: 1 })])));
    expect(back.instruments.map((i) => i.name)).toEqual(['Acoustic Grand Piano', 'Fretless Bass']);
  });

  it('writes zero-sample instruments, so the file carries no audio', () => {
    const bytes = new Uint8Array(encodeXm(oneRow([cell({ note: 60, instrument: 1 })])));
    // Every instrument header declares 0 samples and the 33-byte short form.
    // A 263-byte header here would mean sample slots we never fill.
    const view = new DataView(bytes.buffer);
    const headerSize = view.getUint32(60, true);
    let at = 60 + headerSize;
    // Skip the one pattern: its own header length, then packedSize bytes.
    at += view.getUint32(at, true) + view.getUint16(at + 7, true);
    expect(view.getUint32(at, true)).toBe(33);
    expect(view.getUint16(at + 27, true)).toBe(0);
  });

  it('round-trips speed and tempo, across two channels', () => {
    // XM has one effect column and `F` carries both knobs, so a row setting
    // speed and BPM together needs two cells. Our own importer reads tempo
    // only from cells — never from the header — so this is the path that
    // decides whether an exported tempo survives a re-import.
    const module = oneRow([cell({ note: 60, instrument: 1, speed: 6, bpm: 140 }), cell()]);
    const back = readXm(encodeXm(module));
    const row = back.patterns[0][0];
    expect(row[0].speed).toBe(6);
    expect(row[1].bpm).toBe(140);
  });

  it('still writes the header tempo, which is what a real tracker reads', () => {
    const bytes = new Uint8Array(encodeXm(oneRow([cell({ speed: 6, bpm: 140 }), cell()])));
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(76, true)).toBe(6);
    expect(view.getUint16(78, true)).toBe(140);
  });

  it('round-trips multiple patterns and the order list', () => {
    const blank = Array.from({ length: 64 }, () => [cell()]);
    const module = moduleOf([blank, blank], 1);
    const back = readXm(encodeXm(module));
    expect(back.patterns).toHaveLength(2);
    expect(back.order).toEqual([0, 1]);
  });

  it('refuses a format it does not write', () => {
    const module = { ...oneRow([cell()]), format: 'dsm' as const };
    expect(() => encodeXm(module)).toThrow(/xm/i);
  });
});
