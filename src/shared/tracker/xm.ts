/**
 * Reading a FastTracker 2 module into the neutral tracker model.
 *
 * Almost nothing in an XM has a fixed size. The file header, every pattern
 * header and — the one that catches people — every *instrument* header declares
 * its own length, and the reader must seek by those declarations. An instrument
 * with no samples writes a 33-byte header where one with samples writes 263, so
 * assuming the larger desynchronises everything after the first empty slot.
 * `sunlight.xm` has eight empty instruments among fifteen.
 *
 * Patterns come before instruments in the file, so the instruments can only be
 * found by walking every pattern first.
 *
 * **Measured against four real modules** (modarchive 142447, 58823, 153249 and
 * 3), all of which walk to exactly end-of-file under the arithmetic here.
 *
 * Sample data is never read — only its length, to find the next instrument.
 */
import type { TrackerCell, TrackerInstrument, TrackerModule } from '@sudobility/music_types';
import { applyProTrackerEffect } from './protracker-effects.js';

const SIGNATURE = 'Extended Module: ';
const HEADER_SIZE_AT = 60;
const ORDER_AT = 80;
const INSTRUMENT_NAME_AT = 4;
const INSTRUMENT_NAME_LENGTH = 22;
const NUM_SAMPLES_AT = 27;
const SAMPLE_HEADER_SIZE_AT = 29;

/** Note 1 is C-0, so MIDI is the value plus eleven. 97 is a key off. */
const NOTE_BASE = 11;
const KEY_OFF = 97;

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const c = bytes[at + i];
    if (c === 0) break;
    if (c >= 32 && c < 127) out += String.fromCharCode(c);
  }
  return out.trim();
}

/** Raw, untrimmed — the signature has a trailing space that matters. */
function raw(bytes: Uint8Array, at: number, length: number): string {
  if (at + length > bytes.length) return '';
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[at + i]);
  return out;
}

const emptyCell = (): TrackerCell => ({ instrument: 0, note: null });

/**
 * One pattern, and where the next one starts.
 *
 * Two encodings share the stream. A byte with bit 7 set is a *mask*, selecting
 * which of note, instrument, volume, effect and parameter follow. A byte with
 * bit 7 clear **is the note**, and all five fields follow uncompressed. Reading
 * the second form as a mask desynchronises the rest of the pattern.
 *
 * `packedSize` of 0 means the pattern is blank — `rows` empty rows, not zero
 * rows. Real files use it: `dr_wily.xm` has four and `mercury.xm` eighteen.
 */
function readPattern(
  bytes: Uint8Array,
  view: DataView,
  at: number,
  channels: number,
): { rows: TrackerCell[][]; next: number } {
  const headerLength = view.getUint32(at, true);
  const numRows = view.getUint16(at + 5, true);
  const packedSize = view.getUint16(at + 7, true);
  const start = at + headerLength;
  const end = Math.min(start + packedSize, bytes.length);

  const rows: TrackerCell[][] = Array.from({ length: numRows }, () =>
    Array.from({ length: channels }, emptyCell),
  );

  let pos = start;
  let row = 0;
  let channel = 0;
  while (pos < end && row < numRows) {
    const first = bytes[pos];
    pos += 1;

    let note: number | undefined;
    let instrument: number | undefined;
    let effect: number | undefined;
    let param = 0;

    if (first & 0x80) {
      if (first & 1) {
        note = bytes[pos];
        pos += 1;
      }
      if (first & 2) {
        instrument = bytes[pos];
        pos += 1;
      }
      if (first & 4) {
        // Volume column: read and discarded, as everywhere else.
        pos += 1;
      }
      if (first & 8) {
        effect = bytes[pos];
        pos += 1;
      }
      if (first & 16) {
        param = bytes[pos];
        pos += 1;
      }
    } else {
      note = first;
      instrument = bytes[pos];
      effect = bytes[pos + 2];
      param = bytes[pos + 3];
      pos += 4;
    }

    if (channel < channels) {
      const cell = rows[row][channel];
      if (note !== undefined) {
        if (note === 0) cell.note = null;
        else if (note === KEY_OFF) cell.note = 'off';
        else cell.note = note + NOTE_BASE;
      }
      if (instrument !== undefined) cell.instrument = instrument;
      if (effect !== undefined) applyProTrackerEffect(cell, effect, param);
    }

    channel += 1;
    if (channel >= channels) {
      channel = 0;
      row += 1;
    }
  }

  return { rows, next: start + packedSize };
}

/**
 * One instrument, and where the next one starts.
 *
 * The size arithmetic is the whole difficulty of this format:
 *
 *     next = start + instrumentHeaderSize
 *                  + numSamples * sampleHeaderSize
 *                  + the sum of every sample's length
 *
 * All three parts are read from the file. `instrumentHeaderSize` in particular
 * is **not** a constant — an instrument with no samples writes 33 bytes where
 * one with samples writes 263, and real modules mix them freely.
 *
 * Sample data is only ever measured, never read.
 */
function readInstrument(
  bytes: Uint8Array,
  view: DataView,
  at: number,
  index: number,
): { instrument: TrackerInstrument; next: number } {
  const headerSize = view.getUint32(at, true);
  const name = ascii(bytes, at + INSTRUMENT_NAME_AT, INSTRUMENT_NAME_LENGTH);
  const numSamples = view.getUint16(at + NUM_SAMPLES_AT, true);

  let next = at + headerSize;
  if (numSamples > 0 && at + SAMPLE_HEADER_SIZE_AT + 4 <= bytes.length) {
    const sampleHeaderSize = view.getUint32(at + SAMPLE_HEADER_SIZE_AT, true);
    let total = 0;
    for (let s = 0; s < numSamples; s += 1) {
      const headerAt = next + s * sampleHeaderSize;
      if (headerAt + 4 > bytes.length) break;
      total += view.getUint32(headerAt, true);
    }
    next += numSamples * sampleHeaderSize + total;
  }

  return { instrument: { index, name }, next };
}

export function readXm(buffer: ArrayBuffer): TrackerModule {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < ORDER_AT) {
    throw new Error('Not a FastTracker module: file is too short');
  }
  if (raw(bytes, 0, SIGNATURE.length) !== SIGNATURE) {
    throw new Error('Not a FastTracker module: missing the "Extended Module: " signature');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Counted *from* offset 60, not from the start of the file.
  const headerSize = view.getUint32(HEADER_SIZE_AT, true);
  const songLength = view.getUint16(64, true);
  const channels = view.getUint16(68, true);
  const numPatterns = view.getUint16(70, true);
  const numInstruments = view.getUint16(72, true);

  const order: number[] = [];
  for (let i = 0; i < songLength; i += 1) order.push(bytes[ORDER_AT + i]);

  let at = HEADER_SIZE_AT + headerSize;
  const patterns: TrackerCell[][][] = [];
  for (let p = 0; p < numPatterns && at + 9 <= bytes.length; p += 1) {
    const { rows, next } = readPattern(bytes, view, at, channels);
    patterns.push(rows);
    at = next;
  }

  const instruments: TrackerInstrument[] = [];
  for (let i = 0; i < numInstruments && at + 4 <= bytes.length; i += 1) {
    const { instrument, next } = readInstrument(bytes, view, at, i + 1);
    instruments.push(instrument);
    at = next;
  }

  return {
    format: 'xm',
    title: ascii(bytes, 17, 20),
    channels,
    instruments,
    order,
    patterns,
  };
}
