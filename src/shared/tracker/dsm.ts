/**
 * Reading a DSIK/DSMI module into the neutral tracker model.
 *
 * A RIFF container of `SONG`, `INST` and `PATT` chunks. Structurally the
 * simplest format in the family, which is why it is the first one added after
 * MOD: if it needed the model changed, the model was wrong.
 *
 * **Every offset here was measured against a real module** (modarchive 214766),
 * not taken from a specification — two of them contradict the commonly cited
 * layout. `numOrders` in particular sits at +36, where +34 is `restartPos`;
 * reading it there yields 127 rather than the true 31. The `INST` name sits at
 * +36 of a 64-byte header, which is confirmed by `64 + length` equalling the
 * chunk length for every instrument in the file.
 *
 * Sample data is never read. It sits inside each `INST` chunk after that
 * header, and the chunk walker steps over it by length.
 */
import type { TrackerCell, TrackerInstrument, TrackerModule } from '@sudobility/music_types';
import { applyProTrackerEffect } from './protracker-effects.js';
import { readRiffChunks } from './riff.js';

const SONG_BYTES = 192;
/** Sample data begins after this; the name sits at +36 inside it. */
const INST_HEADER_BYTES = 64;
const INST_NAME_AT = 36;
const INST_NAME_LENGTH = 28;
const ORDERS_AT = 64;

/**
 * DSM's note numbering: 1 is C-0, so MIDI is the byte plus eleven.
 *
 * **Unconfirmed against a reference player.** The real module this reader was
 * measured against uses notes 41-72 with no special values, which fixes the
 * *spacing* but not the absolute base — every note would move together if this
 * is wrong by an octave.
 */
const NOTE_BASE = 11;
/** DSM patterns are a fixed 64 rows, as MOD's are. */
const ROWS_PER_PATTERN = 64;

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const c = bytes[at + i];
    if (c === 0) break;
    if (c >= 32 && c < 127) out += String.fromCharCode(c);
  }
  return out.trim();
}

const emptyCell = (): TrackerCell => ({ instrument: 0, note: null });

/**
 * One packed pattern.
 *
 * A flag byte per event, zero ending the row: the low nibble is the channel and
 * the high nibble says which of note, instrument, volume and effect follow.
 * Reading those four in the wrong order shifts every remaining byte in the row,
 * which is why the volume column has a test of its own — MOD has no equivalent
 * of it.
 */
function unpackPattern(
  bytes: Uint8Array,
  start: number,
  length: number,
  channels: number,
): TrackerCell[][] {
  const rows: TrackerCell[][] = [];
  // The payload opens with a uint16 of its own length, which the chunk header
  // already told us; skip it rather than trusting two sources.
  let at = start + 2;
  const end = start + length;

  while (rows.length < ROWS_PER_PATTERN) {
    const row: TrackerCell[] = Array.from({ length: channels }, emptyCell);
    while (at < end) {
      const flag = bytes[at];
      at += 1;
      if (flag === 0) break;

      const channel = flag & 0x0f;
      // A channel past the declared count still has to consume its bytes, or
      // every following event in the row is read from the wrong offset.
      const cell = channel < channels ? row[channel] : emptyCell();
      if (flag & 0x80) {
        const note = bytes[at];
        at += 1;
        cell.note = note === 0 ? null : note + NOTE_BASE;
      }
      if (flag & 0x40) {
        cell.instrument = bytes[at];
        at += 1;
      }
      if (flag & 0x20) {
        // Read and discarded: a tracker volume column is a performance
        // instruction, and the score model has velocity for that at entry.
        at += 1;
      }
      if (flag & 0x10) {
        applyProTrackerEffect(cell, bytes[at], bytes[at + 1]);
        at += 2;
      }
    }
    rows.push(row);
    // A pattern whose data ended early still owes its remaining rows, or the
    // measure grid downstream comes out short.
    if (at >= end) {
      while (rows.length < ROWS_PER_PATTERN) {
        rows.push(Array.from({ length: channels }, emptyCell));
      }
    }
  }
  return rows;
}

export function readDsm(buffer: ArrayBuffer): TrackerModule {
  const bytes = new Uint8Array(buffer);
  const chunks = readRiffChunks(bytes, 'DSMF');

  const songChunk = chunks.find((c) => c.id === 'SONG');
  if (!songChunk || songChunk.length < SONG_BYTES) {
    throw new Error('Not a DSM module: no SONG chunk');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const song = songChunk.start;

  const title = ascii(bytes, song, 28);
  const numOrders = view.getUint16(song + 36, true);
  const channels = view.getUint16(song + 42, true);

  const order: number[] = [];
  for (let i = 0; i < numOrders; i += 1) order.push(bytes[song + ORDERS_AT + i]);

  const instruments: TrackerInstrument[] = chunks
    .filter((c) => c.id === 'INST')
    .map((chunk, i) => ({
      index: i + 1,
      name:
        chunk.length >= INST_HEADER_BYTES
          ? ascii(bytes, chunk.start + INST_NAME_AT, INST_NAME_LENGTH)
          : '',
    }));

  const patterns: TrackerCell[][][] = chunks
    .filter((c) => c.id === 'PATT')
    .map((chunk) => unpackPattern(bytes, chunk.start, chunk.length, channels));

  return { format: 'dsm', title, channels, instruments, order, patterns };
}
