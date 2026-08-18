/**
 * Reading an Impulse Tracker module into the neutral tracker model.
 *
 * Addressed by offset tables, like S3M: the header carries a uint32 offset per
 * instrument, sample and pattern, so nothing is found by walking forward.
 *
 * **Measured against seven real modules** (four IT, three MPTM), all of which
 * unpack to exactly their declared row counts consuming exactly their declared
 * bytes. The one thing that does *not* show up in those numbers is the replay
 * half of the mask — see `unpackPattern`, where 21% of one file's notes live.
 *
 * MPTM is not a separate format. OpenMPT writes the same structure and marks it
 * with `cmwt == 0x0888`; its extensions are appended after the data this reader
 * follows, so they are ignored for free.
 *
 * Sample data is never read.
 */
import type { TrackerCell, TrackerInstrument, TrackerModule } from '@sudobility/music_types';
import { applyS3mEffect } from './s3m-effects.js';

const ORDERS_AT = 192;
const HEADER_MINIMUM = ORDERS_AT;

const INSTRUMENT_NAME_AT = 32;
const NAME_LENGTH = 26;

/** OpenMPT's marker. `OMPT` at offset 60 means "written by", not "is one". */
const MPTM_CMWT = 0x0888;

/**
 * IT note 60 *is* MIDI 60 — no offset. IT displays middle C as "C-5" where
 * scientific notation calls it C4, but that is a naming difference, not a
 * pitch one. Deliberately unlike XM/DSM (11) and S3M (12): IT's full 0-119
 * range only fits MIDI at base 0, and `preparator.mptm` uses note 119.
 */
const NOTE_BASE = 0;
/**
 * Only 0-119 are pitches. Everything above ends the note: 255 off, 254 cut and
 * **253 fade**, an OpenMPT extension that appears in the MPTM files alone — it
 * is absent from all four ITs, which is exactly how a reader written against IT
 * comes to emit MIDI 253. Measured across the corpus, no other value above 119
 * occurs, and the three are indistinguishable in a score model with no
 * envelopes, so all of them become `'off'`.
 */
const LOWEST_TERMINATOR = 253;

/** Order list markers. 255 ends the song; 254 separates and is not a pattern. */
const ORDER_END = 255;

/** IT's own default when a pattern carries no data. */
const EMPTY_PATTERN_ROWS = 64;
const MAX_CHANNELS = 64;

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const c = bytes[at + i];
    if (c === 0) break;
    if (c >= 32 && c < 127) out += String.fromCharCode(c);
  }
  return out.trim();
}

function fourCC(bytes: Uint8Array, at: number): string {
  if (at + 4 > bytes.length) return '';
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

const emptyCell = (): TrackerCell => ({ instrument: 0, note: null });

/**
 * One packed pattern.
 *
 * The stream is channel-variable bytes. `0` ends a row. Otherwise the channel
 * is `(cv - 1) & 63`, and bit 7 says whether a **mask byte follows** or the
 * channel's *remembered* mask applies.
 *
 * The mask has two halves. Bits 1/2/4/8 read note, instrument, volume and
 * command+param from the stream. Bits 16/32/64/128 **replay this channel's last
 * value for that field and consume nothing** — which is why a reader that drops
 * them still consumes every declared byte and still lands on the exact declared
 * row count, while silently losing notes. Measured on `djb.it`: 8,058 of 25,049
 * notes exist only as replay bits, and on the shipped `thereal1.it` replayed
 * instruments outnumber read ones 17.7 to 1, so those notes would also group
 * onto the wrong track.
 */
function unpackPattern(
  bytes: Uint8Array,
  view: DataView,
  at: number,
): { rows: TrackerCell[][]; channels: number } {
  // Offset 0 means an empty pattern: blank rows, not zero rows.
  if (at === 0 || at + 8 > bytes.length) {
    return {
      rows: Array.from({ length: EMPTY_PATTERN_ROWS }, () => [emptyCell()]),
      channels: 1,
    };
  }

  const length = view.getUint16(at, true);
  const numRows = view.getUint16(at + 2, true);
  const start = at + 8;
  const end = Math.min(start + length, bytes.length);

  const rows: TrackerCell[][] = Array.from({ length: numRows }, () => []);
  let widest = 0;

  const lastMask = new Uint8Array(MAX_CHANNELS);
  const lastNote = new Uint8Array(MAX_CHANNELS);
  const lastInstrument = new Uint8Array(MAX_CHANNELS);
  const lastVolume = new Uint8Array(MAX_CHANNELS);
  const lastCommand = new Uint8Array(MAX_CHANNELS);
  const lastParam = new Uint8Array(MAX_CHANNELS);

  let pos = start;
  let row = 0;
  while (pos < end && row < numRows) {
    const cv = bytes[pos];
    pos += 1;
    if (cv === 0) {
      row += 1;
      continue;
    }

    const channel = (cv - 1) & 63;
    let mask: number;
    if (cv & 128) {
      mask = bytes[pos];
      pos += 1;
      lastMask[channel] = mask;
    } else {
      mask = lastMask[channel];
    }

    // The read half. Each consumes bytes and updates the channel's memory.
    if (mask & 1) {
      lastNote[channel] = bytes[pos];
      pos += 1;
    }
    if (mask & 2) {
      lastInstrument[channel] = bytes[pos];
      pos += 1;
    }
    if (mask & 4) {
      // Volume is read for byte accounting and discarded, as everywhere else.
      lastVolume[channel] = bytes[pos];
      pos += 1;
    }
    if (mask & 8) {
      lastCommand[channel] = bytes[pos];
      lastParam[channel] = bytes[pos + 1];
      pos += 2;
    }

    // The replay half consumes nothing; it only selects what to emit.
    const hasNote = (mask & 1) !== 0 || (mask & 16) !== 0;
    const hasInstrument = (mask & 2) !== 0 || (mask & 32) !== 0;
    const hasCommand = (mask & 8) !== 0 || (mask & 128) !== 0;

    while (rows[row].length <= channel) rows[row].push(emptyCell());
    widest = Math.max(widest, channel + 1);
    const cell = rows[row][channel];

    if (hasNote) {
      const raw = lastNote[channel];
      if (raw >= LOWEST_TERMINATOR) cell.note = 'off';
      else cell.note = raw + NOTE_BASE;
    }
    if (hasInstrument) cell.instrument = lastInstrument[channel];
    if (hasCommand) applyS3mEffect(cell, lastCommand[channel], lastParam[channel]);
  }

  return { rows, channels: Math.max(widest, 1) };
}

export function readIt(buffer: ArrayBuffer): TrackerModule {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < HEADER_MINIMUM) {
    throw new Error('Not an Impulse Tracker module: file is too short');
  }
  if (fourCC(bytes, 0) !== 'IMPM') {
    throw new Error(`Not an Impulse Tracker module: signature is "${fourCC(bytes, 0)}"`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ordNum = view.getUint16(32, true);
  const insNum = view.getUint16(34, true);
  const smpNum = view.getUint16(36, true);
  const patNum = view.getUint16(38, true);
  const cmwt = view.getUint16(42, true);

  // 255 ends the song, so nothing past it is played. 254 is a separator and is
  // left in place: it is not a valid pattern index, and `flattenRows` skips it.
  const order: number[] = [];
  for (let i = 0; i < ordNum; i += 1) {
    const entry = bytes[ORDERS_AT + i];
    if (entry === ORDER_END) break;
    order.push(entry);
  }

  const insTableAt = ORDERS_AT + ordNum;
  const patTableAt = insTableAt + insNum * 4 + smpNum * 4;

  const instruments: TrackerInstrument[] = [];
  for (let i = 0; i < insNum; i += 1) {
    const at = view.getUint32(insTableAt + i * 4, true);
    // Sample names are deliberately not a fallback: where they are populated
    // they are as often "untitled" as anything useful.
    const usable = at !== 0 && at + INSTRUMENT_NAME_AT + NAME_LENGTH <= bytes.length;
    instruments.push({
      index: i + 1,
      name: usable ? ascii(bytes, at + INSTRUMENT_NAME_AT, NAME_LENGTH) : '',
    });
  }

  const patterns: TrackerCell[][][] = [];
  let channels = 1;
  for (let p = 0; p < patNum; p += 1) {
    const at = view.getUint32(patTableAt + p * 4, true);
    const unpacked = unpackPattern(bytes, view, at);
    channels = Math.max(channels, unpacked.channels);
    patterns.push(unpacked.rows);
  }

  // Patterns are unpacked before the widest channel is known, so rows are
  // padded out to the module-wide width afterwards.
  for (const pattern of patterns) {
    for (const row of pattern) {
      while (row.length < channels) row.push({ instrument: 0, note: null });
    }
  }

  return {
    format: cmwt === MPTM_CMWT ? 'mptm' : 'it',
    title: ascii(bytes, 4, NAME_LENGTH),
    channels,
    instruments,
    order,
    patterns,
  };
}
