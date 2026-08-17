/**
 * Reading a Scream Tracker 3 module into the neutral tracker model.
 *
 * Unlike MOD and DSM, S3M is *parapointer-addressed*: the header carries tables
 * of 16-bit pointers which, multiplied by sixteen, give file offsets for each
 * instrument and pattern. Nothing is laid out in sequence, so nothing can be
 * read by walking forward.
 *
 * **Measured against two real modules** (modarchive 69391 and 54606), and two
 * of their behaviours contradict the format documentation — see
 * `unpackPattern` and `channelCount`. A reader written from the specification
 * alone rejects one of those files outright.
 *
 * Sample data is never read. Each instrument header carries its own parapointer
 * to the audio, and this reader simply never follows it.
 */
import type { TrackerCell, TrackerInstrument, TrackerModule } from '@sudobility/music_types';
import { applyS3mEffect } from './s3m-effects.js';

const HEADER_BYTES = 96;
const MAGIC_AT = 44;
const CHANNEL_SETTINGS_AT = 64;
const CHANNEL_SETTINGS_COUNT = 32;
const ORDERS_AT = 96;
/** A parapointer is a file offset divided by this. */
const PARA = 16;

const INSTRUMENT_NAME_AT = 48;
const INSTRUMENT_NAME_LENGTH = 28;

/** S3M patterns are 64 rows, though the data may stop short — see `unpackPattern`. */
const ROWS_PER_PATTERN = 64;
/** The note byte is `(octave << 4) | note`, so octave 0 note 0 is C-0 = MIDI 12. */
const NOTE_BASE = 12;
const NOTE_EMPTY = 0xff;
const NOTE_CUT = 0xfe;

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

type RawEvent = { channel: number; apply: (cell: TrackerCell) => void };

/**
 * One packed pattern, as a list of events per row.
 *
 * Returned before the channel width is known, because the width depends on the
 * highest channel any pattern touches — see `channelCount`.
 *
 * **The declared length is not trusted to terminate the data, and 64 rows of
 * data are not required.** A real module (modarchive 54606) yields 62 or 63
 * rows for every one of its patterns, and 24 of them run one byte past their
 * declared length: the writer omits trailing empty rows and sometimes the final
 * terminator. Every read is clamped to the buffer and the remaining rows are
 * left empty.
 */
function unpackPattern(bytes: Uint8Array, para: number): RawEvent[][] {
  const rows: RawEvent[][] = [];
  if (para === 0) return rows;

  const start = para * PARA;
  if (start + 2 > bytes.length) return rows;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint16(start, true);
  const end = Math.min(start + declared, bytes.length);

  let at = start + 2;
  let row: RawEvent[] = [];
  while (rows.length < ROWS_PER_PATTERN && at < end) {
    const flag = bytes[at];
    at += 1;
    if (flag === 0) {
      rows.push(row);
      row = [];
      continue;
    }

    const channel = flag & 31;
    let note: number | 'off' | null | undefined;
    let instrument: number | undefined;
    let command: number | undefined;
    let info = 0;

    if (flag & 32) {
      // Note and instrument travel together under this one bit.
      const raw = bytes[at];
      instrument = bytes[at + 1];
      at += 2;
      if (raw === NOTE_EMPTY) note = null;
      else if (raw === NOTE_CUT) note = 'off';
      else note = NOTE_BASE + (raw >> 4) * 12 + (raw & 0x0f);
    }
    if (flag & 64) {
      // Read and discarded: a tracker volume column is a performance
      // instruction, and the score model has velocity for that at entry.
      at += 1;
    }
    if (flag & 128) {
      command = bytes[at];
      info = bytes[at + 1];
      at += 2;
    }

    row.push({
      channel,
      apply: (cell) => {
        if (note !== undefined) cell.note = note;
        if (instrument !== undefined) cell.instrument = instrument;
        if (command !== undefined) applyS3mEffect(cell, command, info);
      },
    });
  }
  // A row left part-built when the data ran out is still a row.
  if (row.length > 0 && rows.length < ROWS_PER_PATTERN) rows.push(row);
  return rows;
}

/**
 * How many columns each row needs.
 *
 * The wider of what the header enables and what the patterns actually reach.
 * A real module (modarchive 69391) marks sixteen channels enabled and uses
 * nine; another could reference a channel the header never enabled. Erring wide
 * costs empty columns, which are harmless because `trackerToScore` builds
 * tracks from instruments rather than channels. Erring narrow loses notes.
 */
function channelCount(bytes: Uint8Array, patterns: RawEvent[][][]): number {
  let enabled = 0;
  for (let i = 0; i < CHANNEL_SETTINGS_COUNT; i += 1) {
    const setting = bytes[CHANNEL_SETTINGS_AT + i];
    if (setting !== 0xff && (setting & 0x80) === 0) enabled += 1;
  }
  let highest = -1;
  for (const pattern of patterns) {
    for (const row of pattern) {
      for (const event of row) highest = Math.max(highest, event.channel);
    }
  }
  return Math.min(CHANNEL_SETTINGS_COUNT, Math.max(enabled, highest + 1, 1));
}

export function readS3m(buffer: ArrayBuffer): TrackerModule {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < HEADER_BYTES) {
    throw new Error('Not a Scream Tracker module: file is too short');
  }
  if (fourCC(bytes, MAGIC_AT) !== 'SCRM') {
    throw new Error(`Not a Scream Tracker module: signature is "${fourCC(bytes, MAGIC_AT)}"`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ordNum = view.getUint16(32, true);
  const insNum = view.getUint16(34, true);
  const patNum = view.getUint16(36, true);

  const order: number[] = [];
  for (let i = 0; i < ordNum; i += 1) order.push(bytes[ORDERS_AT + i]);

  const tableAt = ORDERS_AT + ordNum;
  const instrumentParas: number[] = [];
  for (let i = 0; i < insNum; i += 1) instrumentParas.push(view.getUint16(tableAt + i * 2, true));
  const patternParas: number[] = [];
  for (let i = 0; i < patNum; i += 1) {
    patternParas.push(view.getUint16(tableAt + insNum * 2 + i * 2, true));
  }

  const instruments: TrackerInstrument[] = instrumentParas.map((para, i) => {
    const at = para * PARA;
    // An empty slot has type 0 and no SCRS magic — a real module has one, and
    // rejecting it would reject the module.
    const usable = para !== 0 && at + INSTRUMENT_NAME_AT + INSTRUMENT_NAME_LENGTH <= bytes.length;
    return {
      index: i + 1,
      name: usable ? ascii(bytes, at + INSTRUMENT_NAME_AT, INSTRUMENT_NAME_LENGTH) : '',
    };
  });

  const raw = patternParas.map((para) => unpackPattern(bytes, para));
  const channels = channelCount(bytes, raw);
  const patterns: TrackerCell[][][] = raw.map((pattern) => {
    const rows: TrackerCell[][] = [];
    for (let r = 0; r < ROWS_PER_PATTERN; r += 1) {
      const row: TrackerCell[] = Array.from({ length: channels }, () => ({
        instrument: 0,
        note: null,
      }));
      for (const event of pattern[r] ?? []) {
        if (event.channel < channels) event.apply(row[event.channel]);
      }
      rows.push(row);
    }
    return rows;
  });

  return {
    format: 's3m',
    title: ascii(bytes, 0, 28),
    channels,
    instruments,
    order,
    patterns,
  };
}
