/**
 * Writing a FastTracker 2 module from the neutral tracker model.
 *
 * The inverse of `xm.ts`, and deliberately the layout `xm-fixture.ts` already
 * builds — that fixture's output is read by `readXm` in passing tests, so the
 * structure here is proven rather than freshly interpreted.
 *
 * **No sample data.** Instruments are written in the 33-byte zero-sample form,
 * which is structurally valid and which `sunlight.xm` shows real files using
 * for eight of its fifteen slots. The file is silent until a tracker user drops
 * samples into the named slots, which is the whole point of a notes format.
 *
 * Cells are written in the mask form (bit 7 set) throughout. The uncompressed
 * form `readXm` also accepts is never emitted: one encoding is enough, and the
 * mask form is smaller for the sparse patterns a score produces.
 */
import type { TrackerCell, TrackerModule } from '@sudobility/music_types';

const SIGNATURE = 'Extended Module: ';
const HEADER_SIZE = 276;
const INSTRUMENT_HEADER_EMPTY = 33;
const PATTERN_HEADER_SIZE = 9;

/** Note 1 is C-0, so the byte is MIDI minus eleven. 97 is a key off. */
const NOTE_BASE = 11;
const KEY_OFF = 97;

const DEFAULT_SPEED = 6;
const DEFAULT_BPM = 125;

/** `F` carries both knobs, split at 0x20: below is speed, at or above is BPM. */
const EFFECT_F = 0x0f;

function ascii(out: Uint8Array, at: number, text: string, length: number): void {
  for (let i = 0; i < length; i += 1) {
    const code = i < text.length ? text.charCodeAt(i) : 0;
    out[at + i] = code >= 32 && code < 127 ? code : 0;
  }
}

type Effect = { effect: number; param: number };

/** One cell, in the mask form. */
function packCell(out: number[], cell: TrackerCell, effect?: Effect): void {
  let mask = 0x80;
  const note =
    cell.note === null ? undefined : cell.note === 'off' ? KEY_OFF : cell.note - NOTE_BASE;
  if (note !== undefined) mask |= 1;
  if (cell.instrument > 0) mask |= 2;
  if (effect) mask |= 8 | 16;

  out.push(mask);
  if (note !== undefined) out.push(Math.max(1, Math.min(KEY_OFF, note)));
  if (cell.instrument > 0) out.push(cell.instrument & 0xff);
  if (effect) out.push(effect.effect, effect.param);
}

/**
 * Which channel carries which effect on one row.
 *
 * `F` carries both timing knobs, split at 0x20 — below is speed, at or above is
 * BPM — so **one cell cannot express both**. Speed stays on the channel that
 * asked for it and the BPM rides the next channel that is free. With a
 * single-channel module the BPM cannot be an effect at all; the header still
 * carries the initial value, which is what a real tracker reads.
 *
 * No clamping is needed here: `speedAndTempoFor` only ever emits speeds of
 * 3/6/12 (all below 0x20) and tempos of 32-255 (all at or above it), so the
 * values already fall on the correct side of the split.
 */
function effectsForRow(row: TrackerCell[], channels: number): Array<Effect | undefined> {
  const effects: Array<Effect | undefined> = new Array(channels).fill(undefined);
  for (let c = 0; c < channels; c += 1) {
    const cell = row[c];
    if (!cell) continue;
    if (cell.speed !== undefined && effects[c] === undefined) {
      effects[c] = { effect: EFFECT_F, param: cell.speed };
    }
    if (cell.bpm !== undefined) {
      const target = effects[c] === undefined ? c : c + 1;
      if (target < channels && effects[target] === undefined) {
        effects[target] = { effect: EFFECT_F, param: cell.bpm };
      }
    }
  }
  return effects;
}

function packPattern(rows: TrackerCell[][], channels: number): Uint8Array {
  const body: number[] = [];
  for (const row of rows) {
    const effects = effectsForRow(row, channels);
    for (let c = 0; c < channels; c += 1) {
      packCell(body, row[c] ?? { instrument: 0, note: null }, effects[c]);
    }
  }
  return new Uint8Array(body);
}

export function encodeXm(module: TrackerModule): ArrayBuffer {
  if (module.format !== 'xm') {
    throw new Error(`encodeXm writes xm, not "${module.format}"`);
  }

  const channels = Math.max(1, module.channels);
  const packed = module.patterns.map((rows) => packPattern(rows, channels));

  // Row 0's knobs become the header defaults, which is where a tracker reads
  // the starting tempo from.
  const first = module.patterns[0]?.[0] ?? [];
  const initialSpeed = first.find((c) => c?.speed !== undefined)?.speed ?? DEFAULT_SPEED;
  const initialBpm = first.find((c) => c?.bpm !== undefined)?.bpm ?? DEFAULT_BPM;

  const patternBytes = packed.reduce((n, p) => n + PATTERN_HEADER_SIZE + p.length, 0);
  const instrumentBytes = module.instruments.length * INSTRUMENT_HEADER_EMPTY;
  const out = new Uint8Array(60 + HEADER_SIZE + patternBytes + instrumentBytes);
  const view = new DataView(out.buffer);

  ascii(out, 0, SIGNATURE, 17);
  ascii(out, 17, module.title, 20);
  out[37] = 0x1a;
  ascii(out, 38, 'Moosiac', 20);
  view.setUint16(58, 0x0104, true);
  view.setUint32(60, HEADER_SIZE, true);
  view.setUint16(64, module.order.length, true);
  view.setUint16(68, channels, true);
  view.setUint16(70, module.patterns.length, true);
  view.setUint16(72, module.instruments.length, true);
  view.setUint16(76, initialSpeed, true);
  view.setUint16(78, initialBpm, true);
  module.order.forEach((value, i) => {
    out[80 + i] = value & 0xff;
  });

  let at = 60 + HEADER_SIZE;
  packed.forEach((data, i) => {
    view.setUint32(at, PATTERN_HEADER_SIZE, true);
    out[at + 4] = 0;
    view.setUint16(at + 5, module.patterns[i].length, true);
    view.setUint16(at + 7, data.length, true);
    out.set(data, at + PATTERN_HEADER_SIZE);
    at += PATTERN_HEADER_SIZE + data.length;
  });

  for (const instrument of module.instruments) {
    view.setUint32(at, INSTRUMENT_HEADER_EMPTY, true);
    ascii(out, at + 4, instrument.name, 22);
    out[at + 26] = 0;
    view.setUint16(at + 27, 0, true); // no samples: a notes format carries none
    at += INSTRUMENT_HEADER_EMPTY;
  }

  return out.buffer;
}
